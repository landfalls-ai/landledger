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

const currentMonth = () => new Date().toISOString().slice(0, 7);

/**
 * The months of the ledger (spec 001): open → closing → locked, one step at a time, by a person signed in with
 * Landbright; never by an API key, and never back. The database enforces the same (periods_forward_only).
 */
export class Periods {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
  ) {}

  async list(): Promise<Period[]> {
    const rows = await this.sql<PeriodRow[]>`SELECT * FROM periods ORDER BY month DESC`;
    return rows.map(periodOf);
  }

  /** Moves `month` to `closing` (from open) or `locked` (from closing). */
  async advance(month: string, to: 'closing' | 'locked', by: Principal): Promise<Period> {
    if (by.kind !== 'person')
      throw new ApiError(
        'forbidden',
        `Only a person signed in with Landbright ${to === 'locked' ? 'locks' : 'closes'} a month; an API key never does`,
      );
    if (!by.roles.some((r) => r === 'controller' || r === 'cfo'))
      throw new ApiError('forbidden', 'Closing and locking a month is for the controller or the CFO');
    if (month > currentMonth()) throw new ApiError('bad_request', `${month} hasn't started yet`);
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
        { ...actorOf(by), action: `period.${to}`, subjectType: 'period', subjectId: month, data: { from, to } },
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
