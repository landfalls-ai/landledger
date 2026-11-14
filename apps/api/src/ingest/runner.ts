/**
 * Ingest runs (spec 002): read a source for a UTC day, build what the day should hold (`build.ts`), and bring the
 * ledger to it. Idempotent: a run that finds the same figures appends nothing. A changed figure is reversed and
 * re-entered; a figure that vanished is reversed; a locked month's change is booked in the open month as a Correction.
 * Today (and a day whose data may still arrive) goes to `provisional_usage`, replaced wholesale on every run.
 */
import type { IngestRun } from '@landledger/contracts';
import {
  COLUMNS,
  type CostRecord,
  type CostRow,
  correct,
  fromRow,
  monthOf,
  monthStart,
  type PeriodState,
  toRow,
  ulid,
} from '@landledger/focus';
import { Decimal, Money } from '@landledger/money';
import type { PricedVersion } from '@landledger/pricing';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { canonicalJson } from '../canonical.js';
import { day as dayOf, type Sql } from '../db.js';
import { newId } from '../ids.js';
import type { Records } from '../ledger.js';
import type { RateCards } from '../ratecards.js';
import { type BuiltDay, buildClicklandDay, buildLandflowDay } from './build.js';
import type { ClicklandClient, LandflowClient } from './sources.js';

export type IngestSource = 'landflow' | 'clickland';
export type RunKind = 'hourly' | 'daily' | 'backfill' | 'manual';

export interface IngestLog {
  info(data: object, msg: string): void;
  warn(data: object, msg: string): void;
  error(data: object, msg: string): void;
}

export interface IngestOptions {
  landflow: LandflowClient | null;
  clickland: ClicklandClient | null;
  /** Where Landflow runs: AI rows name it as the costed service. */
  landflowHost: { service: string; namespace: string };
  log: IngestLog;
  now?: () => Date;
  /** After a run that entered records: allocation of the months it touched. */
  afterRun?: (run: IngestRun & { provisional: boolean }) => Promise<void>;
}

/** How long after a UTC day ends its data is taken as complete (Clickland's samples land in batches). */
export const COMPLETE_AFTER_MS: Record<IngestSource, number> = { landflow: 15 * 60_000, clickland: 2 * 3_600_000 };

const DAY_MS = 86_400_000;
const tracer = trace.getTracer('landledger-ingest');

/** Every column but the ledger's own (record id, run, booking month, correction links): what a figure *is*. */
const SKIP = new Set([
  'x_RecordId',
  'x_IngestRunId',
  'x_CorrectionOfId',
  'BillingPeriodStart',
  'BillingPeriodEnd',
  'ChargeClass',
]);
export function fingerprint(r: CostRecord): string {
  const out: Record<string, unknown> = {};
  for (const col of COLUMNS) {
    if (SKIP.has(col.name)) continue;
    const v = (r as unknown as Record<string, unknown>)[col.name] ?? null;
    if (v === null) out[col.name] = null;
    else if (v instanceof Money) out[col.name] = `${v.currency}:${v.micros}`;
    else if (v instanceof Decimal) out[col.name] = v.normalize().toString();
    else out[col.name] = v;
  }
  return canonicalJson(out);
}

type RunRow = {
  id: string;
  source: IngestRun['source'];
  kind: IngestRun['kind'];
  day: Date;
  rate_card_version_id: string | null;
  params: Record<string, unknown>;
  started_by: string;
  started_at: Date;
  finished_at: Date | null;
  outcome: IngestRun['outcome'];
  read_count: number;
  new_count: number;
  corrected_count: number;
  unchanged_count: number;
  warnings: string[];
  error: string | null;
  observed_from: Date | null;
  observed_to: Date | null;
};

export const runOf = (r: RunRow): IngestRun & { provisional: boolean } => ({
  id: r.id,
  source: r.source,
  kind: r.kind,
  day: dayOf(r.day),
  rateCardVersionId: r.rate_card_version_id,
  startedBy: r.started_by,
  startedAt: r.started_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
  outcome: r.outcome,
  readCount: r.read_count,
  newCount: r.new_count,
  correctedCount: r.corrected_count,
  unchangedCount: r.unchanged_count,
  warnings: r.warnings,
  error: r.error,
  observedFrom: r.observed_from?.toISOString() ?? null,
  observedTo: r.observed_to?.toISOString() ?? null,
  provisional: r.params?.provisional === true,
});

interface Outcome {
  built: BuiltDay;
  version: PricedVersion | null;
  observedFrom: Date | null;
  observedTo: Date | null;
}

export class Ingest {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;

  constructor(
    private readonly sql: Sql,
    private readonly records: Records,
    private readonly rateCards: RateCards,
    private readonly options: IngestOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  sources(): IngestSource[] {
    return [
      ...(this.options.landflow ? ['landflow' as const] : []),
      ...(this.options.clickland ? ['clickland' as const] : []),
    ];
  }

  /** Whether `day`'s data is complete enough to enter the ledger (else it stays provisional). */
  isComplete(source: IngestSource, day: string): boolean {
    return this.now().getTime() >= Date.parse(`${day}T00:00:00Z`) + DAY_MS + COMPLETE_AFTER_MS[source];
  }

  /** One run, serialised per source in this process and per source and day in the database. */
  run(
    source: IngestSource,
    day: string,
    kind: RunKind,
    startedBy: string,
  ): Promise<IngestRun & { provisional: boolean }> {
    const prev = this.queues.get(source) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.runNow(source, day, kind, startedBy));
    this.queues.set(source, next);
    return next;
  }

  private async runNow(source: IngestSource, day: string, kind: RunKind, startedBy: string) {
    const today = this.now().toISOString().slice(0, 10);
    if (day > today) throw new RangeError(`${day} hasn't started yet`);
    const provisional = !this.isComplete(source, day);
    const id = newId('run');
    const book = await this.rateCards.book();
    const version = book.versionOn(day);
    await this.sql`
      INSERT INTO ingest_runs (id, source, kind, day, rate_card_version_id, params, started_by)
      VALUES (${id}, ${source}, ${kind}, ${day}, ${version?.id ?? null},
              ${this.sql.json({ provisional })}, ${startedBy})`;
    const log = this.options.log;
    return tracer.startActiveSpan(`ingest ${source}`, async (span) => {
      span.setAttributes({
        'landledger.ingest.run': id,
        'landledger.ingest.source': source,
        'landledger.ingest.day': day,
        'landledger.ingest.provisional': provisional,
      });
      let counts = { newCount: 0, correctedCount: 0, unchangedCount: 0 };
      let warnings: string[] = [];
      let read = 0;
      let observed: [Date | null, Date | null] = [null, null];
      let error: string | null = null;
      try {
        const out = await this.build(source, day, version);
        warnings = [...new Set(out.built.warnings)];
        read = out.built.read;
        observed = [out.observedFrom, out.observedTo];
        counts = provisional
          ? await this.replaceProvisional(source, day, id, out.built.records)
          : await this.reconcile(source, day, id, out.built.records);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        span.recordException(e as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error });
      }
      const [row] = await this.sql<RunRow[]>`
        UPDATE ingest_runs SET finished_at = clock_timestamp(), outcome = ${error ? 'failed' : 'succeeded'},
          read_count = ${read}, new_count = ${counts.newCount}, corrected_count = ${counts.correctedCount},
          unchanged_count = ${counts.unchangedCount}, warnings = ${this.sql.json(warnings)}, error = ${error},
          observed_from = ${observed[0]}, observed_to = ${observed[1]}
        WHERE id = ${id} RETURNING *`;
      const run = runOf(row!);
      span.setAttributes({
        'landledger.ingest.read': read,
        'landledger.ingest.new': counts.newCount,
        'landledger.ingest.corrected': counts.correctedCount,
        'landledger.ingest.unchanged': counts.unchangedCount,
        'landledger.ingest.warnings': warnings.length,
      });
      span.end();
      const data = {
        run: id,
        source,
        day,
        kind,
        provisional,
        read,
        ...counts,
        warnings: warnings.length,
        outcome: run.outcome,
      };
      if (error) log.error({ ...data, error }, `ingest ${source} ${day} failed: ${error}`);
      else
        log.info(
          data,
          `ingest ${source} ${day}${provisional ? ' (provisional)' : ''}: ${counts.newCount} new, ${counts.correctedCount} corrected, ${counts.unchangedCount} unchanged`,
        );
      for (const w of warnings.slice(0, 20)) log.warn({ run: id, source, day }, w);
      if (this.options.afterRun && !error)
        await this.options
          .afterRun(run)
          .catch((e: Error) => log.error({ run: id, error: e.message }, `after ingest ${source} ${day}: ${e.message}`));
      return run;
    });
  }

  private async build(source: IngestSource, day: string, version: PricedVersion | null): Promise<Outcome> {
    const start = new Date(`${day}T00:00:00Z`);
    const end = new Date(Math.min(start.getTime() + DAY_MS - 1, this.now().getTime()));
    if (source === 'landflow') {
      const lf = this.options.landflow;
      if (!lf) throw new Error('Landflow is not configured (LANDLEDGER_LANDFLOW_URL and LANDLEDGER_LANDFLOW_KEY)');
      const warnings: string[] = [];
      const events = await lf.aiEvents(start, end, warnings);
      const names = await lf.names();
      // Insights only for the cache adjustment: needed when some event of the day has no cache tokens.
      const needInsights =
        version !== null && events.some((e) => e.attrs.cacheRead === undefined || e.attrs.cacheWrite === undefined);
      const insights = needInsights
        ? await lf.insights(day, day).catch((e: Error) => (warnings.push(`Landflow insights: ${e.message}`), null))
        : null;
      // The per-model check: the events read add up to Landflow's own count for the window.
      try {
        const report = await lf.usageByModel(start, end);
        if (BigInt(report.totals.count) !== BigInt(events.length))
          warnings.push(`Landflow counts ${report.totals.count} ai.call events on ${day}; ${events.length} were read`);
      } catch (e) {
        warnings.push(`Landflow usage check: ${(e as Error).message}`);
      }
      const built = buildLandflowDay({ day, events, version, names, insights, host: this.options.landflowHost });
      built.warnings.unshift(...warnings);
      // Landflow's events are final when written: the window read is the window observed, calls or none.
      return { built, version, observedFrom: start, observedTo: new Date(end.getTime() + 1) };
    }
    const ck = this.options.clickland;
    if (!ck) throw new Error('Clickland is not configured (LANDLEDGER_CLICKLAND_URL and LANDLEDGER_CLICKLAND_KEY)');
    if (!version)
      throw new Error(
        `No approved rate card on ${day}: cluster usage is priced only by an approved rate card (approve v1 in Rate cards)`,
      );
    const rollup = await ck.rollup(start, new Date(end.getTime() + 1));
    const built = buildClicklandDay({ day, rollup, version });
    const firsts = rollup.coverage.sources
      .map((s) => s.firstSample)
      .filter((s): s is string => !!s)
      .map((s) => Date.parse(s));
    const lasts = rollup.coverage.sources
      .map((s) => s.lastSample)
      .filter((s): s is string => !!s)
      .map((s) => Date.parse(s));
    return {
      built,
      version,
      observedFrom: firsts.length ? new Date(Math.max(start.getTime(), Math.min(...firsts))) : null,
      observedTo: lasts.length ? new Date(Math.min(end.getTime() + 1, Math.max(...lasts))) : null,
    };
  }

  /** Today: the day's provisional rows replaced by this run's. */
  private async replaceProvisional(source: IngestSource, day: string, runId: string, records: CostRecord[]) {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`ingest:${source}:${day}`}))`;
      await tx`DELETE FROM provisional_usage WHERE source = ${source} AND charge_period_start = ${`${day}T00:00:00Z`}::timestamptz`;
      const rows = records.map((r) => toRow({ ...r, x_RecordId: ulid(), x_IngestRunId: runId }));
      for (let i = 0; i < rows.length; i += 500) await tx`INSERT INTO provisional_usage ${tx(rows.slice(i, i + 500))}`;
      return { newCount: rows.length, correctedCount: 0, unchangedCount: 0 };
    }) as Promise<{ newCount: number; correctedCount: number; unchangedCount: number }>;
  }

  /** A complete day: the ledger brought to what the day should hold, with entries, reversals and re-entries. */
  private async reconcile(source: IngestSource, day: string, runId: string, records: CostRecord[]) {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`ingest:${source}:${day}`}))`;
      const live = await tx<CostRow[]>`
        SELECT r.* FROM cost_records r JOIN cost_record_keys k ON k.record_id = r.record_id
        WHERE r.source = ${source} AND r.charge_period_start = ${`${day}T00:00:00Z`}::timestamptz
          AND r.basis = 'estimated' AND NOT k.is_reversal
          AND NOT EXISTS (SELECT 1 FROM cost_record_keys x WHERE x.correction_of_id = k.record_id)`;
      const periods = await tx<{ month: Date; status: string }[]>`SELECT month, status FROM periods`;
      const locked = new Set(periods.filter((p) => p.status === 'locked').map((p) => dayOf(p.month).slice(0, 7)));
      const lastLocked = [...locked].sort().at(-1) ?? '';
      const thisMonth = this.now().toISOString().slice(0, 7);
      const state: PeriodState = {
        // A month before a locked month takes nothing either (cost_records_enter).
        isLocked: (m) => locked.has(m) || m <= lastLocked,
        openMonth: thisMonth > lastLocked ? thisMonth : nextOpen(lastLocked),
      };
      const ctx = { ingestRunId: runId };
      const byKey = new Map(
        live.map((r) => {
          const rec = fromRow(r);
          return [rec.x_SourceKey, rec] as const;
        }),
      );
      const out: CostRecord[] = [];
      let newCount = 0;
      let correctedCount = 0;
      let unchangedCount = 0;
      const seen = new Set<string>();
      for (const r of records) {
        if (seen.has(r.x_SourceKey)) throw new Error(`Two figures for ${r.x_SourceKey} in one day`);
        seen.add(r.x_SourceKey);
        const original = byKey.get(r.x_SourceKey);
        if (!original) {
          newCount++;
          const month = state.isLocked(monthOf(r.ChargePeriodStart)) ? state.openMonth : monthOf(r.ChargePeriodStart);
          out.push({
            ...r,
            BillingPeriodStart: monthStart(month),
            BillingPeriodEnd: monthStart(nextOpen(month)),
            ChargeClass: month === monthOf(r.ChargePeriodStart) ? null : 'Correction',
            x_RecordId: ulid(),
            x_IngestRunId: runId,
          });
        } else if (fingerprint(original) === fingerprint(r)) unchangedCount++;
        else {
          correctedCount++;
          out.push(...correct(original, { ...r, x_RecordId: '', x_IngestRunId: runId }, state, ctx));
        }
      }
      for (const [key, original] of byKey)
        if (!seen.has(key)) {
          correctedCount++;
          out.push(...correct(original, null, state, ctx));
        }
      for (let i = 0; i < out.length; i += 500) await this.records.append(out.slice(i, i + 500), tx);
      // The day is in the ledger now: its provisional rows go.
      await tx`DELETE FROM provisional_usage WHERE source = ${source} AND charge_period_start = ${`${day}T00:00:00Z`}::timestamptz`;
      return { newCount, correctedCount, unchangedCount };
    }) as Promise<{ newCount: number; correctedCount: number; unchangedCount: number }>;
  }

  /** The days a source has data for, earliest first, from `from` to today. */
  static days(from: string, to: string): string[] {
    const out: string[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS)
      out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }

  /** Runs every day from `from` to today for a source (complete days into the ledger, today provisional). */
  async backfill(source: IngestSource, from: string, startedBy: string) {
    const today = this.now().toISOString().slice(0, 10);
    const runs = [];
    for (const d of Ingest.days(from, today))
      runs.push(await this.run(source, d, d === today ? 'manual' : 'backfill', startedBy));
    return runs;
  }

  /**
   * The hourly job: today's provisional figures, and each of the last `days` complete days that no run has entered
   * into the ledger in the last 20 hours (so each recent day is re-read about once a day: late data, corrections).
   */
  async tick(days = 7) {
    const now = this.now();
    const today = now.toISOString().slice(0, 10);
    const runs = [];
    for (const source of this.sources()) {
      runs.push(await this.run(source, today, 'hourly', 'schedule'));
      for (let i = 1; i <= days; i++) {
        const d = new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10);
        if (!this.isComplete(source, d)) {
          runs.push(await this.run(source, d, 'hourly', 'schedule'));
          continue;
        }
        const [recent] = await this.sql`
          SELECT 1 FROM ingest_runs WHERE source = ${source} AND day = ${d} AND outcome = 'succeeded'
            AND NOT coalesce((params->>'provisional')::boolean, false)
            AND started_at > ${new Date(now.getTime() - 20 * 3_600_000)}`;
        if (!recent) runs.push(await this.run(source, d, 'daily', 'schedule'));
      }
    }
    return runs;
  }

  async list(q: { source?: IngestSource; limit: number }) {
    const rows = await this.sql<RunRow[]>`
      SELECT * FROM ingest_runs WHERE TRUE ${q.source ? this.sql`AND source = ${q.source}` : this.sql``}
      ORDER BY started_at DESC LIMIT ${q.limit}`;
    return rows.map(runOf);
  }
}

function nextOpen(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
