import type { CostRecord as WireRecord, Period, PeriodStatus, RecordsPage, RecordsQuery } from '@landledger/contracts';
import { assertValid, type CostRecord, type CostRow, fromRow, monthStart, toRow, toWire } from '@landledger/focus';
import type { AuditLog } from './audit.js';
import { day, inTransaction, type Sql, type Tx } from './db.js';
import { ApiError } from './errors.js';
import { actorOf, type Principal } from './principal.js';
import type { Webhooks } from './webhooks.js';

type PeriodRow = {
  month: Date;
  status: PeriodStatus;
  opened_at: Date;
  closing_by: string | null;
  closing_at: Date | null;
  locked_by: string | null;
  locked_at: Date | null;
};

const periodOf = (r: PeriodRow): Period => ({
  month: day(r.month).slice(0, 7),
  status: r.status,
  openedAt: r.opened_at.toISOString(),
  closingBy: r.closing_by,
  closingAt: r.closing_at?.toISOString() ?? null,
  lockedBy: r.locked_by,
  lockedAt: r.locked_at?.toISOString() ?? null,
});

const nextMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/**
 * The months of the ledger (spec 001): open → closing → locked, one step at a time, by a person signed in with
 * Landbright; never by an API key, and never back. The database enforces the same (periods_forward_only).
 *
 * A month locks only when it is whole: it has ended, every source has a complete (non-provisional) run for every day
 * of the month since its first data, no provisional rows are left, and every record has a stored allocation. A
 * controller can lock anyway with a reason; the override and the problems it overrode are audited.
 */
export class Periods {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Why `month` isn't ready to lock; empty when it is. */
  async lockProblems(month: string, tx: Tx = this.sql): Promise<string[]> {
    const problems: string[] = [];
    const first = `${month}-01`;
    const next = `${nextMonth(month)}-01`;
    if (this.now().getTime() < Date.parse(`${next}T00:00:00Z`))
      problems.push(`${month} hasn't ended yet (it ends ${next} 00:00 UTC)`);
    const lastDay = day(new Date(Date.parse(`${next}T00:00:00Z`) - 86_400_000));
    const sources = await tx<{ source: string; first: Date }[]>`
      SELECT source, min(day) AS first FROM ingest_runs WHERE outcome = 'succeeded' AND source <> 'manual'
      GROUP BY source ORDER BY source`;
    for (const s of sources) {
      const from = day(s.first) > first ? day(s.first) : first;
      if (from > lastDay) continue;
      const done = new Set(
        (
          await tx<{ day: Date }[]>`
            SELECT DISTINCT day FROM ingest_runs
            WHERE source = ${s.source} AND outcome = 'succeeded' AND day BETWEEN ${from} AND ${lastDay}
              AND NOT coalesce((params->>'provisional')::boolean, false)`
        ).map((r) => day(r.day)),
      );
      const missing: string[] = [];
      for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${lastDay}T00:00:00Z`); t += 86_400_000) {
        const d = new Date(t).toISOString().slice(0, 10);
        if (!done.has(d)) missing.push(d);
      }
      if (missing.length)
        problems.push(
          `${s.source} has no complete run for ${missing.length} day(s) of ${month}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`,
        );
    }
    const provisional = await tx<{ source: string; n: number }[]>`
      SELECT source, count(*)::int AS n FROM provisional_usage
      WHERE charge_period_start >= ${`${first}T00:00:00Z`}::timestamptz AND charge_period_start < ${`${next}T00:00:00Z`}::timestamptz
      GROUP BY source ORDER BY source`;
    for (const p of provisional)
      problems.push(`${p.n} provisional row(s) from ${p.source} are still in ${month}: its last days aren't complete`);
    const [{ n }] = (await tx`
      SELECT count(*)::int AS n FROM cost_records r
      WHERE r.billing_period_start = ${`${first}T00:00:00Z`}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM allocations a
          WHERE a.month = ${first} AND a.record_id = r.record_id
            AND a.generation_id = (SELECT id FROM allocation_generations g WHERE g.month = ${first} ORDER BY number DESC LIMIT 1))`) as unknown as [
      { n: number },
    ];
    if (n) problems.push(`${n} record(s) booked in ${month} have no stored allocation`);
    return problems;
  }

  async list(): Promise<Period[]> {
    const rows = await this.sql<PeriodRow[]>`SELECT * FROM periods ORDER BY month DESC`;
    return rows.map(periodOf);
  }

  /** Moves `month` to `closing` (from open) or `locked` (from closing; see `lockProblems`, and the override). */
  async advance(
    month: string,
    to: 'closing' | 'locked',
    by: Principal,
    override?: { reason: string },
  ): Promise<Period> {
    if (by.kind !== 'person')
      throw new ApiError(
        'forbidden',
        `Only a person signed in with Landbright ${to === 'locked' ? 'locks' : 'closes'} a month; an API key never does`,
      );
    if (!by.roles.some((r) => r === 'controller' || r === 'cfo'))
      throw new ApiError('forbidden', 'Closing and locking a month is for the controller or the CFO');
    if (month > this.now().toISOString().slice(0, 7)) throw new ApiError('bad_request', `${month} hasn't started yet`);
    if (override && (to !== 'locked' || !by.roles.includes('controller')))
      throw new ApiError('forbidden', 'Only a controller overrides the checks, and only to lock a month');
    const from = to === 'closing' ? 'open' : 'closing';
    return this.sql.begin(async (tx) => {
      const first = monthStart(month).slice(0, 10);
      await tx`INSERT INTO periods (month) VALUES (${first}) ON CONFLICT DO NOTHING`;
      const [row] = await tx<PeriodRow[]>`SELECT * FROM periods WHERE month = ${first} FOR UPDATE`;
      if (row!.status !== from)
        throw new ApiError(
          'conflict',
          row!.status === 'locked'
            ? `${month} is locked: it never reopens; corrections go to the open month`
            : `${month} is ${row!.status}: a month moves open → closing → locked`,
        );
      if (to === 'locked') {
        const [earlier] = await tx<{ month: Date }[]>`
          SELECT month FROM periods WHERE month < ${first} AND status <> 'locked' ORDER BY month LIMIT 1`;
        if (earlier)
          throw new ApiError('conflict', `Lock ${day(earlier.month).slice(0, 7)} first: months lock in order`);
      }
      const problems = to === 'locked' ? await this.lockProblems(month, tx) : [];
      if (problems.length && !override)
        throw new ApiError(
          'conflict',
          `${month} isn't ready to lock: ${problems.join('; ')}. A controller can lock it anyway with a reason (audited).`,
          { problems },
        );
      const [updated] =
        to === 'closing'
          ? await tx<PeriodRow[]>`
              UPDATE periods SET status = 'closing', closing_by = ${by.id}, closing_at = now()
              WHERE month = ${first} RETURNING *`
          : await tx<PeriodRow[]>`
              UPDATE periods SET status = 'locked', locked_by = ${by.id}, locked_at = now()
              WHERE month = ${first} RETURNING *`;
      const period = periodOf(updated!);
      await this.audit.append(
        {
          ...actorOf(by),
          action: `period.${to}`,
          subjectType: 'period',
          subjectId: month,
          data: {
            from,
            to,
            ...(to === 'locked'
              ? { checks: problems.length ? 'overridden' : 'passed', ...(override ? { problems, override } : {}) }
              : {}),
          },
        },
        tx,
      );
      if (to === 'closing') await this.webhooks.enqueue(tx, 'period.closing', { month });
      return period;
    }) as Promise<Period>;
  }
}

/** Cost records: read for everyone with `read`; appended only by ingest and corrections (spec 002), never edited. */
export class Records {
  constructor(private readonly sql: Sql) {}

  async list(q: RecordsQuery): Promise<RecordsPage> {
    const s = this.sql;
    const rows = await s<(CostRow & { seq: string })[]>`
      SELECT * FROM cost_records
      WHERE TRUE
        ${q.month ? s`AND billing_period_start = ${monthStart(q.month)}::timestamptz` : s``}
        ${q.basis ? s`AND basis = ${q.basis}` : s``}
        ${q.source ? s`AND source = ${q.source}` : s``}
        ${q.sourceKey ? s`AND source_key = ${q.sourceKey}` : s``}
        ${q.after ? s`AND seq > ${q.after}::bigint` : s``}
      ORDER BY seq LIMIT ${q.limit + 1}`;
    const page = rows.slice(0, q.limit);
    return {
      records: page.map((r) => toWire(fromRow(r)) as WireRecord),
      next: rows.length > q.limit ? page.at(-1)!.seq : null,
    };
  }

  /** Appends records after `check`; the database refuses what breaks the ledger's rules. */
  async append(records: readonly CostRecord[], tx: Tx = this.sql): Promise<number> {
    if (!records.length) return 0;
    const rows = records.map((r) => toRow(assertValid(r)));
    return inTransaction(tx, async (t) => (await t`INSERT INTO cost_records ${t(rows)}`).count);
  }
}
