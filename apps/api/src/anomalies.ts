/**
 * Anomalies (spec 007). Cost: per dimension (cost center, service, agent, model) and key, a day's cost against a robust
 * baseline of the 14 days before it (median and MAD), checked every hour as today accrues. Approval patterns that look
 * like a control being worked around: a spend split under the automatic threshold, automatic approvals raised again
 * and again, a relayed decision seconds after its card, one approver waving through one requester. Each anomaly is
 * stored once (append only), audited, sent as a webhook (`cost.anomaly`, `approval.anomaly`) and, for cost only, logged
 * as an OpenTelemetry record with ids and no names (`landledger.event=cost.anomaly`) that a Clickland alert rule counts.
 * A cost anomaly's figure follows the day as it accrues and alerts again each time it doubles. A person acknowledges,
 * assigns and closes one with an outcome (expected, fixed, false positive), all audited; nothing ages out, and the
 * people a pattern names never acknowledge or close it (review of wave 3).
 */
import {
  type AnomalyKind,
  type AnomalyOutcome,
  type AnomalyRule,
  type AnomalyView,
  type Dimension,
} from '@landledger/contracts';
import { billingPeriod, toRow } from '@landledger/focus';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import { actorOf, type Principal } from './principal.js';
import type { AuditLog } from './audit.js';
import type { Sql, Tx } from './db.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';
import type { IngestLog } from './ingest/runner.js';
import type { Policies } from './policies.js';
import { addDays, amount, keyOf, type Spend } from './spend.js';
import type { Webhooks } from './webhooks.js';

const USD = REPORTING_CURRENCY;
/** The baseline: the 14 days before the day checked, of which at least 7 observed. */
export const BASELINE_DAYS = 14;
export const MIN_BASELINE_DAYS = 7;
/** A robust z-score of 3.5 (Iglewicz and Hoaglin) over the MAD scaled to σ (× 1.4826). */
export const MIN_SCORE = '3.5';
export const MAD_SCALE = '1.4826';
export const COST_DIMENSIONS: readonly Dimension[] = ['costCenter', 'service', 'agent', 'model'];

// Robust statistics, exact in micro-units -----------------------------------------------------------------------------

/** The median of micro-unit amounts; with an even count, the mean of the middle two rounded half to even. */
export function median(xs: readonly bigint[]): bigint {
  if (!xs.length) return 0n;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length >> 1;
  if (s.length % 2) return s[mid]!;
  const sum = s[mid - 1]! + s[mid]!;
  const half = sum / 2n;
  if (sum % 2n === 0n) return half;
  // x.5: to the even neighbour (toward −∞ for negatives is not needed: costs here are ≥ 0, but keep it exact).
  const down = sum < 0n ? half - 1n : half;
  return down % 2n === 0n ? down : down + 1n;
}

/** The median absolute deviation from the median. */
export function mad(xs: readonly bigint[], med = median(xs)): bigint {
  return median(xs.map((x) => (x > med ? x - med : med - x)));
}

export interface CostCheck {
  anomalous: boolean;
  median: bigint;
  mad: bigint;
  /** jump ÷ (1.4826 × MAD), two places; null when the baseline is flat (MAD 0). */
  score: string | null;
  /** Why not, when it isn't: in words. */
  reason: string;
}

/**
 * One day's cost against its baseline. Anomalous when the jump above the median is at least `minMicros`, at least half
 * the median, and (unless the baseline is flat) at least 3.5 robust standard deviations.
 */
export function checkCost(baseline: readonly bigint[], observed: bigint, minMicros: bigint): CostCheck {
  const med = median(baseline);
  const m = mad(baseline, med);
  const jump = observed - med;
  const score = m > 0n ? Decimal.of(jump, 6).divide(Decimal.of(m, 6).times(MAD_SCALE), 2, 'halfEven').toString() : null;
  const base = { median: med, mad: m, score };
  if (baseline.length < MIN_BASELINE_DAYS)
    return { ...base, anomalous: false, reason: `${baseline.length} observed days, ${MIN_BASELINE_DAYS} needed` };
  if (jump < minMicros) return { ...base, anomalous: false, reason: 'below the smallest jump' };
  if (jump * 2n < med) return { ...base, anomalous: false, reason: 'less than half the median above it' };
  if (score !== null && Decimal.parse(score).compare(MIN_SCORE) < 0)
    return { ...base, anomalous: false, reason: `robust score ${score} under ${MIN_SCORE}` };
  return { ...base, anomalous: true, reason: 'anomalous' };
}

// Approval patterns, pure ------------------------------------------------------------------------------------------

export interface Raised {
  id: string;
  createdAt: number;
  micros: bigint;
}

/**
 * Splits: runs of 3 or more requests (in creation order) within 72 hours of the first, every one under the automatic
 * threshold and together at or above it. A run found is skipped past, so one split is reported once.
 */
export function findSplits(rows: readonly Raised[], thresholdMicros: bigint): Raised[][] {
  const out: Raised[][] = [];
  const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  for (let i = 0; i < sorted.length;) {
    const start = sorted[i]!.createdAt;
    const window = sorted.slice(i).filter((r) => r.createdAt - start <= 72 * 3_600_000);
    const sum = window.reduce((a, r) => a + r.micros, 0n);
    if (window.length >= 3 && window.every((r) => r.micros < thresholdMicros) && sum >= thresholdMicros) {
      out.push(window);
      i += window.length;
    } else i++;
  }
  return out;
}

/** One approver for one requester: 5 or more of that requester's decisions, and at least 80% of them. */
export function findSamePairs<T extends { approver: string; requester: string }>(
  decisions: readonly T[],
): { approver: string; requester: string; rows: T[]; of: number }[] {
  const perRequester = new Map<string, number>();
  const pairs = new Map<string, T[]>();
  for (const d of decisions) {
    perRequester.set(d.requester, (perRequester.get(d.requester) ?? 0) + 1);
    const k = `${d.approver}\u0000${d.requester}`;
    pairs.set(k, [...(pairs.get(k) ?? []), d]);
  }
  return [...pairs.values()]
    .map((rows) => ({
      approver: rows[0]!.approver,
      requester: rows[0]!.requester,
      rows,
      of: perRequester.get(rows[0]!.requester)!,
    }))
    .filter((p) => p.rows.length >= 5 && p.rows.length * 5 >= p.of * 4);
}

/** A relayed decision under 10 seconds after its card was served. */
export const FAST_RELAY_MS = 10_000;
export const isFastRelay = (cardAt: Date | null, decidedAt: Date) =>
  cardAt !== null && decidedAt.getTime() - cardAt.getTime() < FAST_RELAY_MS;

// Rows ----------------------------------------------------------------------------------------------------------------

interface AnomalyRow {
  id: string;
  kind: AnomalyKind;
  rule: AnomalyRule;
  dimension: string;
  key: string;
  label: string;
  window_start: Date;
  window_end: Date;
  summary: string;
  observed_micros: string | null;
  baseline_micros: string | null;
  mad_micros: string | null;
  score: string | null;
  cost_center: string | null;
  request_ids: string[];
  details: Record<string, unknown>;
  detected_at: Date;
  ack_by: string | null;
  ack_at: Date | null;
  ack_note: string | null;
}

interface ActionRow {
  anomaly_id: string;
  action: 'assigned' | 'closed';
  by_name: string;
  assignee: string | null;
  assignee_name: string | null;
  outcome: 'expected' | 'fixed' | 'false_positive' | null;
  note: string;
  at: Date;
}

interface NewAnomaly {
  kind: AnomalyKind;
  rule: AnomalyRule;
  dimension: string;
  key: string;
  label: string;
  windowStart: string;
  windowEnd: string;
  summary: string;
  observed?: Money | null;
  baseline?: Money | null;
  mad?: Money | null;
  score?: string | null;
  costCenter?: string | null;
  requestIds?: string[];
  details?: Record<string, unknown>;
}

const usd = (m: bigint) => Money.ofMicros(m, USD);
const money = (m: string | null) => (m === null ? null : amount(Money.ofMicros(m, USD)));
const words = (m: Money) => `$${m.toDecimal().toFixed(2, 'halfEven')}`;
const iso = (d: Date) => d.toISOString();

export interface ScanResult {
  cost: number;
  approval: number;
  checked: { days: string[]; keys: number; observedDays: number };
}

export class Anomalies {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly spend: Spend,
    private readonly policies: Policies,
    private readonly log: IngestLog,
    private readonly options: { minUsd: string; consoleUrl: string },
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Reading -----------------------------------------------------------------------------------------------------------

  private readonly select = (s: Tx) => s`
      SELECT a.*, a.observed_micros::text AS observed_micros, a.baseline_micros::text AS baseline_micros,
             a.mad_micros::text AS mad_micros, a.score::text AS score,
             coalesce(u.email, u.name) AS ack_by, k.at AS ack_at, k.note AS ack_note
      FROM anomalies a LEFT JOIN anomaly_acks k ON k.anomaly_id = a.id LEFT JOIN users u ON u.id = k.by_user`;

  /** Open: not closed, however old (nothing ages out). All: every one, newest first. */
  async list(q: { status: 'open' | 'all'; kind?: AnomalyKind; limit: number }): Promise<AnomalyView[]> {
    const rows = await this.sql<AnomalyRow[]>`
      ${this.select(this.sql)}
      WHERE (${q.kind ?? null}::text IS NULL OR a.kind = ${q.kind ?? null})
        AND (${q.status} = 'all' OR NOT EXISTS (
          SELECT 1 FROM anomaly_actions c WHERE c.anomaly_id = a.id AND c.action = 'closed'))
      ORDER BY a.detected_at DESC, a.id LIMIT ${q.limit}`;
    return this.views(rows);
  }

  async view(id: string): Promise<AnomalyView> {
    const rows = await this.sql<AnomalyRow[]>`${this.select(this.sql)} WHERE a.id = ${id}`;
    if (!rows.length) throw new ApiError('not_found', `Anomaly ${id} not found`);
    return (await this.views(rows))[0]!;
  }

  /**
   * The people an approval pattern names, who never acknowledge, assign or close it: the requesters and sponsors of
   * its requests, the approver of a same-pair pattern and the decider of a fast relay. A cost anomaly names nobody.
   */
  private async peopleOf(rows: AnomalyRow[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const reqIds = [...new Set(rows.filter((r) => r.kind === 'approval').flatMap((r) => r.request_ids))];
    const reqs = reqIds.length
      ? await this.sql<{ id: string; requester_id: string | null; sponsor_id: string | null }[]>`
          SELECT id, requester_id, sponsor_id FROM requests WHERE id = ANY (${reqIds})`
      : [];
    const relayIds = rows.filter((r) => r.rule === 'fast_relay').map((r) => r.key);
    const relays = relayIds.length
      ? await this.sql<{ id: string; decided_by: string }[]>`
          SELECT id, decided_by FROM decisions WHERE id = ANY (${relayIds})`
      : [];
    for (const r of rows) {
      if (r.kind !== 'approval') {
        out.set(r.id, []);
        continue;
      }
      const stored = Array.isArray(r.details.people) ? (r.details.people as string[]) : [];
      const named = new Set(stored);
      for (const q of reqs.filter((x) => r.request_ids.includes(x.id))) {
        if (q.requester_id) named.add(q.requester_id);
        if (q.sponsor_id) named.add(q.sponsor_id);
      }
      if (r.rule === 'same_pair') named.add(r.key.split(':')[0]!);
      if (r.rule === 'fast_relay') for (const d of relays.filter((x) => x.id === r.key)) named.add(d.decided_by);
      out.set(r.id, [...named].filter((x) => x.startsWith('usr_') || !x.includes(':')).sort());
    }
    return out;
  }

  private async views(rows: AnomalyRow[]): Promise<AnomalyView[]> {
    const ids = [...new Set(rows.flatMap((r) => r.request_ids))];
    const reqs = ids.length
      ? await this.sql<{ id: string; number: number; title: string }[]>`
          SELECT id, number, title FROM requests WHERE id = ANY (${ids})`
      : [];
    const byId = new Map(reqs.map((r) => [r.id, { id: r.id, number: `R-${r.number}`, title: r.title }]));
    const aIds = rows.map((r) => r.id);
    const obs = aIds.length
      ? await this.sql<
          { anomaly_id: string; observed_micros: string; score: string | null; alerted: boolean; at: Date }[]
        >`
          SELECT anomaly_id, observed_micros::text AS observed_micros, score::text AS score, alerted, at
          FROM anomaly_observations WHERE anomaly_id = ANY (${aIds}) ORDER BY at`
      : [];
    const actions = aIds.length
      ? await this.sql<ActionRow[]>`
          SELECT c.anomaly_id, c.action, coalesce(b.email, b.name) AS by_name, c.assignee,
                 coalesce(s.email, s.name) AS assignee_name, c.outcome, c.note, c.at
          FROM anomaly_actions c JOIN users b ON b.id = c.by_user LEFT JOIN users s ON s.id = c.assignee
          WHERE c.anomaly_id = ANY (${aIds}) ORDER BY c.at`
      : [];
    const people = await this.peopleOf(rows);
    return rows.map((r) => {
      const mine = obs.filter((o) => o.anomaly_id === r.id);
      const last = mine.at(-1);
      const assigned = actions.filter((c) => c.anomaly_id === r.id && c.action === 'assigned').at(-1);
      const closed = actions.find((c) => c.anomaly_id === r.id && c.action === 'closed');
      return {
        id: r.id,
        kind: r.kind,
        rule: r.rule,
        dimension: r.dimension,
        key: r.key,
        label: r.label,
        windowStart: iso(r.window_start),
        windowEnd: iso(r.window_end),
        summary: r.summary,
        observed: money(r.observed_micros),
        current: last ? money(last.observed_micros) : money(r.observed_micros),
        currentAt: last ? iso(last.at) : iso(r.detected_at),
        alerts: 1 + mine.filter((o) => o.alerted).length,
        baseline: money(r.baseline_micros),
        mad: money(r.mad_micros),
        score: last?.score ?? r.score,
        costCenter: r.cost_center,
        requests: r.request_ids.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x),
        detectedAt: iso(r.detected_at),
        acknowledged: r.ack_at ? { by: r.ack_by ?? 'someone', at: iso(r.ack_at), note: r.ack_note ?? '' } : null,
        assignee: assigned
          ? {
              id: assigned.assignee!,
              name: assigned.assignee_name ?? assigned.assignee!,
              by: assigned.by_name,
              at: iso(assigned.at),
            }
          : null,
        closed: closed ? { by: closed.by_name, at: iso(closed.at), outcome: closed.outcome!, note: closed.note } : null,
        status: closed ? 'closed' : r.ack_at ? 'acknowledged' : 'open',
        named: people.get(r.id) ?? [],
        dev:
          r.details.devOnly === true ||
          (r.details.devOnly === undefined &&
            Array.isArray(r.details.sources) &&
            (r.details.sources as string[]).includes('dev-anomaly')),
      };
    });
  }

  // Acting on one -------------------------------------------------------------------------------------------------------

  /** Who may act on an anomaly: a person who is not an auditor only, and never someone the pattern names. */
  private async mayAct(tx: Tx, id: string, by: Principal, what: string) {
    if (by.kind !== 'person')
      throw new ApiError('forbidden', `An anomaly is ${what} by a person signed in with Landbright; a key never does`);
    if (by.roles.length > 0 && by.roles.every((r) => r === 'auditor'))
      throw new ApiError('forbidden', `Auditors read anomalies; they are not ${what} by them`);
    // One action at a time per anomaly (the app may not lock its rows: they are append only).
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`anomaly:${id}`}))`;
    const rows = await tx<AnomalyRow[]>`${this.select(tx)} WHERE a.id = ${id}`;
    if (!rows.length) throw new ApiError('not_found', `Anomaly ${id} not found`);
    const named = (await this.peopleOf(rows)).get(id) ?? [];
    if (named.includes(by.id))
      throw new ApiError('forbidden', 'This pattern names you: someone else acknowledges, assigns or closes it');
    const [closed] = await tx`SELECT 1 FROM anomaly_actions WHERE anomaly_id = ${id} AND action = 'closed'`;
    if (closed && what !== 'read') throw new ApiError('conflict', 'This anomaly is closed');
    return rows[0]!;
  }

  /** A person acknowledges an anomaly with a note: audited; it leaves Needs you and stays open until closed. */
  async acknowledge(id: string, note: string, by: Principal): Promise<AnomalyView> {
    await this.sql.begin(async (tx) => {
      const a = await this.mayAct(tx, id, by, 'acknowledged');
      const done = await tx`
        INSERT INTO anomaly_acks (anomaly_id, by_user, note) VALUES (${id}, ${by.id}, ${note})
        ON CONFLICT (anomaly_id) DO NOTHING RETURNING 1`;
      if (!done.length) throw new ApiError('conflict', 'This anomaly is acknowledged already');
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'anomaly.acknowledged',
          subjectType: 'anomaly',
          subjectId: id,
          data: { rule: a.rule, key: a.key, note },
        },
        tx,
      );
    });
    return this.view(id);
  }

  /** Assigns an anomaly to a person (again and again): audited. */
  async assign(id: string, input: { assignee: { id?: string; email?: string }; note: string }, by: Principal) {
    await this.sql.begin(async (tx) => {
      const a = await this.mayAct(tx, id, by, 'assigned');
      const [u] = await tx<{ id: string; email: string | null }[]>`
        SELECT id, email FROM users WHERE kind = 'person' AND active
          AND (id = ${input.assignee.id ?? ''} OR lower(email) = ${(input.assignee.email ?? '').toLowerCase()})`;
      if (!u) throw new ApiError('bad_request', 'Assign it to an active person (by id or email)');
      if (((await this.peopleOf([a])).get(id) ?? []).includes(u.id))
        throw new ApiError('bad_request', 'This pattern names that person: assign it to someone else');
      await tx`
        INSERT INTO anomaly_actions (id, anomaly_id, action, by_user, assignee, note, at)
        VALUES (${newId('ana')}, ${id}, 'assigned', ${by.id}, ${u.id}, ${input.note}, ${this.now()})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'anomaly.assigned',
          subjectType: 'anomaly',
          subjectId: id,
          data: { rule: a.rule, key: a.key, assignee: u.id, note: input.note },
        },
        tx,
      );
    });
    return this.view(id);
  }

  /** Closes an anomaly once with an outcome and a note: audited; it leaves the open list. */
  async close(id: string, input: { outcome: AnomalyOutcome; note: string }, by: Principal) {
    await this.sql.begin(async (tx) => {
      const a = await this.mayAct(tx, id, by, 'closed');
      await tx`
        INSERT INTO anomaly_actions (id, anomaly_id, action, by_user, outcome, note, at)
        VALUES (${newId('ana')}, ${id}, 'closed', ${by.id}, ${input.outcome}, ${input.note}, ${this.now()})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'anomaly.closed',
          subjectType: 'anomaly',
          subjectId: id,
          data: { rule: a.rule, key: a.key, outcome: input.outcome, note: input.note },
        },
        tx,
      );
    });
    return this.view(id);
  }

  // Scanning ----------------------------------------------------------------------------------------------------------

  /** What the hourly job does: expire old dev spikes, today and yesterday's cost, and the approval patterns. */
  async scan(opts: { days?: string[] } = {}): Promise<ScanResult> {
    await expireDevSpikes(this.sql, this.audit, this.now());
    const today = this.now().toISOString().slice(0, 10);
    const days = opts.days ?? [addDays(today, -1), today];
    let cost = 0;
    let keys = 0;
    let observedDays = 0;
    for (const day of days) {
      const r = await this.scanCost(day);
      cost += r.found;
      keys += r.keys;
      observedDays = Math.max(observedDays, r.observedDays);
    }
    const approval = await this.scanApprovals();
    return { cost, approval, checked: { days, keys, observedDays } };
  }

  /**
   * One day's cost per dimension and key against the 14 days before it. A key is judged on its real cost first; only
   * when that is ordinary and the `dev-anomaly` spike makes it jump is it stored as a dev test. A stored anomaly's figure
   * follows the day as it accrues: each scan that sees more records it, and a figure twice the last alerted one alerts
   * again.
   */
  async scanCost(day: string): Promise<{ found: number; keys: number; observedDays: number }> {
    const from = addDays(day, -BASELINE_DAYS);
    const before = addDays(day, -1);
    const observed = await this.sql<{ day: Date }[]>`
      SELECT DISTINCT day FROM ingest_runs
      WHERE outcome = 'succeeded' AND source IN ('landflow', 'clickland') AND day BETWEEN ${from} AND ${before}`;
    const baseDays = observed.map((r) => r.day.toISOString().slice(0, 10)).sort();
    const { lines } = await this.spend.lines({ from, to: day }, true, { includeDev: true });
    const ccs = await this.spend.costCenters();
    const minMicros = Money.parse(this.options.minUsd, USD).micros;
    let found = 0;
    let keys = 0;
    for (const dimension of COST_DIMENSIONS) {
      // cost per key per charge day (real, and with the dev spike); corrections are booked later for an earlier month.
      const series = new Map<
        string,
        { label: string; costCenter: string | null; real: Map<string, bigint>; all: Map<string, bigint> }
      >();
      for (const l of lines) {
        if (l.correction) continue;
        const k = keyOf(l, dimension, ccs);
        if (k.key === '(none)' || k.key === '') continue;
        const s = series.get(k.key) ?? {
          label: k.label,
          costCenter: null as string | null,
          real: new Map(),
          all: new Map(),
        };
        if (dimension === 'costCenter') s.costCenter = l.costCenter;
        s.all.set(l.day, (s.all.get(l.day) ?? 0n) + l.amount.micros);
        if (l.source !== 'dev-anomaly') s.real.set(l.day, (s.real.get(l.day) ?? 0n) + l.amount.micros);
        series.set(k.key, s);
      }
      for (const [key, s] of series) {
        if ((s.all.get(day) ?? 0n) <= 0n) continue;
        keys++;
        const realToday = s.real.get(day) ?? 0n;
        const realCheck = checkCost(
          baseDays.map((d) => s.real.get(d) ?? 0n),
          realToday,
          minMicros,
        );
        const devOnly = !realCheck.anomalous;
        const today = devOnly ? (s.all.get(day) ?? 0n) : realToday;
        const baseline = baseDays.map((d) => (devOnly ? s.all : s.real).get(d) ?? 0n);
        const c = devOnly ? checkCost(baseline, today, minMicros) : realCheck;
        if (!c.anomalous) continue;
        const asOf = this.now().toISOString().slice(0, 10) === day ? ' so far today' : ` on ${day}`;
        const novel = c.median === 0n && c.mad === 0n;
        const summary = `${s.label} cost ${words(usd(today))}${asOf}, against a median of ${words(usd(c.median))} a day over the ${baseline.length} observed days before${
          c.score
            ? ` (robust score ${c.score}, MAD ${words(usd(c.mad))})`
            : novel
              ? ' (new spend: nothing in the baseline)'
              : ' (a flat baseline)'
        }`;
        const stored = await this.store({
          kind: 'cost',
          rule: 'cost_jump',
          dimension,
          key,
          label: s.label,
          windowStart: `${day}T00:00:00.000Z`,
          windowEnd: `${addDays(day, 1)}T00:00:00.000Z`,
          summary,
          observed: usd(today),
          baseline: usd(c.median),
          mad: usd(c.mad),
          score: c.score,
          costCenter: dimension === 'costCenter' ? key : null,
          details: {
            baselineDays: baseline.length,
            devOnly,
            sources: [
              ...new Set(
                lines.filter((l) => l.day === day && keyOf(l, dimension, ccs).key === key).map((l) => l.source),
              ),
            ],
          },
        });
        if (stored) found++;
      }
    }
    return { found, keys, observedDays: baseDays.length };
  }

  /** The thresholds a kind's policy draws on a cost center: automatic, and each step's amount line. */
  private async thresholdsOf(kind: string, costCenter: string): Promise<Money[]> {
    const p = await this.policies.forRequest(kind as never, costCenter).catch(() => null);
    if (!p) return [];
    const out = [
      p.automaticBelow,
      ...p.steps.flatMap((st) => [st.when.amountAtLeast ?? null, st.when.amountAbove ?? null]),
    ].filter((x): x is string => !!x);
    return [...new Set(out)].map((x) => Money.parse(x, USD));
  }

  /** The approval patterns over the last 90 days. */
  async scanApprovals(): Promise<number> {
    const now = this.now();
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    let found = 0;

    // split and automatic_ratchet --------------------------------------------------------------------------------
    // By the person who answers for each request (its requester, or an agent's sponsor), across cost centers, agents
    // and kinds; only requests still open or approved (a rejected or cancelled one split nothing).
    const reqs = await this.sql<
      {
        id: string;
        kind: string;
        cost_center: string;
        amount_micros: string;
        created_at: Date;
        decided_at: Date | null;
        automatic: boolean;
        who: string;
        who_name: string;
        agent_id: string | null;
      }[]
    >`
      SELECT r.id, r.kind, r.cost_center, r.amount_micros::text AS amount_micros, r.created_at, r.decided_at, r.automatic,
             coalesce(r.sponsor_id, r.requester_id) AS who, r.agent_id,
             coalesce(u.name, u.email, r.requester_id) AS who_name
      FROM requests r LEFT JOIN users u ON u.id = coalesce(r.sponsor_id, r.requester_id)
      WHERE r.created_at >= ${ago(30)} AND r.change IS NULL
        AND r.status IN ('pending', 'awaiting_confirmation', 'approved', 'applied')
        AND coalesce(r.sponsor_id, r.requester_id) IS NOT NULL
      ORDER BY r.created_at, r.id`;
    const byPerson = new Map<string, (typeof reqs)[number][]>();
    for (const r of reqs) byPerson.set(r.who, [...(byPerson.get(r.who) ?? []), r]);
    const thresholdCache = new Map<string, Money[]>();
    for (const [who, rows] of byPerson) {
      const thresholds = new Map<bigint, Money>();
      for (const r of rows) {
        const k = `${r.kind}|${r.cost_center}`;
        if (!thresholdCache.has(k)) thresholdCache.set(k, await this.thresholdsOf(r.kind, r.cost_center));
        for (const t of thresholdCache.get(k)!) thresholds.set(t.micros, t);
      }
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const threshold of [...thresholds.values()].sort((a, b) => a.compare(b))) {
        // Requests at or above the line took the larger path anyway: only those under it can split it.
        const under = rows
          .filter((r) => BigInt(r.amount_micros) < threshold.micros)
          .map((r) => ({ id: r.id, createdAt: r.created_at.getTime(), micros: BigInt(r.amount_micros) }));
        for (const run of findSplits(under, threshold.micros)) {
          const window = run.map((r) => byId.get(r.id)!);
          const sum = run.reduce((a, r) => a + r.micros, 0n);
          const ccs = [...new Set(window.map((r) => r.cost_center))].sort();
          const kinds = [...new Set(window.map((r) => r.kind.replace('_', ' ')))].sort();
          const stored = await this.store({
            kind: 'approval',
            rule: 'split',
            dimension: 'requester',
            key: `${who}:${threshold.micros}`,
            label: `${window[0]!.who_name}, under ${words(threshold)}`,
            windowStart: iso(window[0]!.created_at),
            windowEnd: iso(window.at(-1)!.created_at),
            summary: `${window[0]!.who_name} raised or sponsored ${run.length} ${kinds.join(' and ')} requests on ${ccs.join(', ')} within 72 hours, each under the ${words(threshold)} line and ${words(usd(sum))} together`,
            observed: usd(sum),
            costCenter: ccs.length === 1 ? ccs[0]! : null,
            requestIds: window.map((r) => r.id),
            details: { threshold: amount(threshold), count: run.length, costCenters: ccs, people: [who] },
          });
          if (stored) found++;
        }
      }
    }
    // Automatic approvals raised or sponsored by one person on one cost center: once per calendar month (a stable key).
    const autos = new Map<string, (typeof reqs)[number][]>();
    for (const r of reqs)
      if (r.automatic && r.decided_at && r.decided_at >= ago(30)) {
        const g = `${r.who}|${r.cost_center}|${r.decided_at.toISOString().slice(0, 7)}`;
        autos.set(g, [...(autos.get(g) ?? []), r]);
      }
    for (const rows of autos.values()) {
      if (rows.length < 3) continue;
      const { who, who_name, cost_center: cc } = rows[0]!;
      const sorted = [...rows].sort((a, b) => a.decided_at!.getTime() - b.decided_at!.getTime());
      const sum = rows.reduce((a, r) => a + BigInt(r.amount_micros), 0n);
      const month = sorted[0]!.decided_at!.toISOString().slice(0, 7);
      const stored = await this.store({
        kind: 'approval',
        rule: 'automatic_ratchet',
        dimension: 'requester',
        key: `${who}:${cc}`,
        label: `${who_name} on ${cc}`,
        windowStart: `${month}-01T00:00:00.000Z`,
        windowEnd: iso(sorted.at(-1)!.decided_at!),
        summary: `${rows.length} requests raised or sponsored by ${who_name} on ${cc} were approved automatically in ${month}, ${words(usd(sum))} in all: each under the threshold, none seen by a person`,
        observed: usd(sum),
        costCenter: cc,
        requestIds: sorted.map((r) => r.id),
        details: { count: rows.length, people: [who] },
      });
      if (stored) found++;
    }

    // fast_relay -------------------------------------------------------------------------------------------------------
    const relays = await this.sql<
      {
        id: string;
        request_id: string;
        decided_at: Date;
        decided_by: string;
        card_at: Date | null;
        channel: string | null;
        cost_center: string;
        number: number;
        approver: string;
      }[]
    >`
      SELECT d.id, d.request_id, d.decided_at, d.decided_by, d.channel, r.cost_center, r.number,
             coalesce(a.name, a.email, d.decided_by) AS approver,
             (SELECT min(s.served_at) FROM evidence_serves s
              WHERE s.request_id = d.request_id AND s.sha256 = d.evidence_sha256 AND s.to_kind IN ('key', 'webhook')
                AND s.served_at <= d.decided_at) AS card_at
      FROM decisions d JOIN requests r ON r.id = d.request_id LEFT JOIN users a ON a.id = d.decided_by
      WHERE d.via = 'relay' AND d.decided_at >= ${ago(30)}`;
    for (const d of relays) {
      if (!d.card_at || !isFastRelay(d.card_at, d.decided_at)) continue;
      const ms = d.decided_at.getTime() - d.card_at.getTime();
      const stored = await this.store({
        kind: 'approval',
        rule: 'fast_relay',
        dimension: 'request',
        key: d.id,
        label: `R-${d.number}`,
        windowStart: iso(d.card_at),
        windowEnd: iso(d.decided_at),
        summary: `${d.approver} decided R-${d.number} through ${d.channel ?? 'a relay'} ${(ms / 1000).toFixed(1)} seconds after the card was served: too fast to have read the evidence`,
        costCenter: d.cost_center,
        requestIds: [d.request_id],
        details: { seconds: Number((ms / 1000).toFixed(1)), people: [d.decided_by] },
      });
      if (stored) found++;
    }

    // same_pair --------------------------------------------------------------------------------------------------------
    // Per step, only where more than one person could have decided it; once per approver, requester, step and quarter.
    const decided = await this.sql<
      {
        request_id: string;
        decided_at: Date;
        approver_id: string;
        approver: string;
        who: string;
        who_name: string;
        step_key: string;
        eligible: number;
      }[]
    >`
      SELECT d.request_id, d.decided_at, d.decided_by AS approver_id, coalesce(a.name, a.email) AS approver,
             coalesce(r.sponsor_id, r.requester_id) AS who, coalesce(u.name, u.email, r.requester_id) AS who_name,
             d.step_key,
             (SELECT count(DISTINCT p.id)::int FROM users p
              WHERE p.kind = 'person' AND p.active AND p.id IS DISTINCT FROM coalesce(r.sponsor_id, r.requester_id)
                AND (CASE WHEN s.owner_id IS NOT NULL
                       THEN p.id = s.owner_id OR p.id = ANY (coalesce(s.deputy_ids, '{}'))
                       ELSE p.groups && s.groups END)) AS eligible
      FROM decisions d JOIN requests r ON r.id = d.request_id JOIN users a ON a.id = d.decided_by
      JOIN request_steps s ON s.request_id = d.request_id AND s.position = d.step
      LEFT JOIN users u ON u.id = coalesce(r.sponsor_id, r.requester_id)
      WHERE d.decided_at >= ${ago(90)} AND coalesce(r.sponsor_id, r.requester_id) IS NOT NULL
      ORDER BY d.decided_at`;
    const contested = decided.filter((d) => d.eligible > 1);
    for (const step of [...new Set(contested.map((d) => d.step_key))]) {
      const atStep = contested.filter((d) => d.step_key === step);
      for (const p of findSamePairs(atStep.map((d) => ({ ...d, approver: d.approver_id, requester: d.who })))) {
        const { approver_id, approver, who, who_name } = atStep.find(
          (d) => d.approver_id === p.approver && d.who === p.requester,
        )!;
        const share = Math.round((p.rows.length / p.of) * 100);
        const last = p.rows.at(-1)!.decided_at;
        const quarter = `${last.getUTCFullYear()}-${String(Math.floor(last.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;
        const stored = await this.store({
          kind: 'approval',
          rule: 'same_pair',
          dimension: 'approver',
          key: `${approver_id}:${who}:${step}`,
          label: `${approver} for ${who_name} (${step})`,
          windowStart: `${quarter}T00:00:00.000Z`,
          windowEnd: iso(last),
          summary: `${approver} made ${p.rows.length} of the ${p.of} ${step} decisions on ${who_name}'s requests in 90 days (${share}%), where others could decide too`,
          requestIds: [...new Set(p.rows.map((r) => r.request_id))],
          details: { count: p.rows.length, of: p.of, share, step, people: [approver_id, who] },
        });
        if (stored) found++;
      }
    }
    return found;
  }

  /**
   * Stores an anomaly once; audits it, sends its webhook, and logs a cost anomaly for Clickland (ids, never names). An
   * anomaly already stored takes the new figure when it is higher, and alerts again when it doubled since the last
   * alert. Returns whether it was new.
   */
  private async store(a: NewAnomaly): Promise<boolean> {
    const id = newId('anm');
    const outcome = await this.sql.begin(async (tx: Tx) => {
      const rows = await tx`
        INSERT INTO anomalies (id, kind, rule, dimension, key, label, window_start, window_end, summary,
                               observed_micros, baseline_micros, mad_micros, score, cost_center, request_ids, details,
                               detected_at)
        VALUES (${id}, ${a.kind}, ${a.rule}, ${a.dimension}, ${a.key}, ${a.label}, ${a.windowStart}, ${a.windowEnd},
                ${a.summary}, ${a.observed?.micros.toString() ?? null}, ${a.baseline?.micros.toString() ?? null},
                ${a.mad?.micros.toString() ?? null}, ${a.score ?? null}, ${a.costCenter ?? null}, ${a.requestIds ?? []},
                ${tx.json((a.details ?? {}) as never)}, ${this.now()})
        ON CONFLICT (kind, rule, dimension, key, window_start) DO NOTHING RETURNING id`;
      if (!rows.length) {
        if (a.kind !== 'cost' || !a.observed) return { created: false, alerted: null as string | null };
        const [old] = await tx<{ id: string; observed_micros: string }[]>`
          SELECT id, observed_micros::text AS observed_micros FROM anomalies
          WHERE kind = ${a.kind} AND rule = ${a.rule} AND dimension = ${a.dimension} AND key = ${a.key}
            AND window_start = ${a.windowStart}`;
        if (!old) return { created: false, alerted: null };
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`anomaly:${old.id}`}))`;
        const obs = await tx<{ observed_micros: string; alerted: boolean }[]>`
          SELECT observed_micros::text AS observed_micros, alerted FROM anomaly_observations
          WHERE anomaly_id = ${old.id} ORDER BY at`;
        const latest = BigInt(obs.at(-1)?.observed_micros ?? old.observed_micros);
        if (a.observed.micros <= latest) return { created: false, alerted: null };
        const lastAlert = BigInt(obs.filter((o) => o.alerted).at(-1)?.observed_micros ?? old.observed_micros);
        const alerted = a.observed.micros >= lastAlert * 2n;
        await tx`
          INSERT INTO anomaly_observations (id, anomaly_id, observed_micros, score, alerted, at)
          VALUES (${newId('ano')}, ${old.id}, ${a.observed.micros.toString()}, ${a.score ?? null}, ${alerted}, ${this.now()})`;
        if (alerted)
          await this.audit.append(
            {
              actor: 'anomalies',
              actorKind: 'system',
              action: 'anomaly.escalated',
              subjectType: 'anomaly',
              subjectId: old.id,
              data: { observedMicros: a.observed.micros.toString(), lastAlertMicros: lastAlert.toString() },
            },
            tx,
          );
        return { created: false, alerted: alerted ? old.id : null };
      }
      await this.audit.append(
        {
          actor: 'anomalies',
          actorKind: 'system',
          action: `anomaly.${a.kind}`,
          subjectType: 'anomaly',
          subjectId: id,
          data: {
            rule: a.rule,
            dimension: a.dimension,
            key: a.key,
            observedMicros: a.observed?.micros.toString() ?? null,
          },
        },
        tx,
      );
      return { created: true, alerted: id };
    });
    if (!outcome.alerted) return outcome.created;
    const view = await this.view(outcome.alerted);
    const url = `${this.options.consoleUrl}/anomalies?id=${outcome.alerted}`;
    await this.sql.begin((tx) =>
      this.webhooks.enqueue(tx, a.kind === 'cost' ? 'cost.anomaly' : 'approval.anomaly', {
        anomaly: view,
        url,
        escalation: !outcome.created,
      }),
    );
    // Cost anomalies only, out to Clickland as an OpenTelemetry log record (pino → OTLP) that its alert rule counts:
    // ids and figures, never a summary or a person's name.
    if (a.kind === 'cost')
      this.log.warn(
        {
          'landledger.event': 'cost.anomaly',
          'landledger.anomaly.id': outcome.alerted,
          'landledger.anomaly.rule': a.rule,
          'landledger.anomaly.dimension': a.dimension,
          'landledger.anomaly.key': a.key,
          'landledger.anomaly.observed': view.current,
          'landledger.anomaly.baseline': view.baseline,
          'landledger.anomaly.cost_center': a.costCenter ?? '',
          'landledger.anomaly.dev': String(view.dev),
          'landledger.anomaly.escalation': String(!outcome.created),
          'landledger.anomaly.url': url,
        },
        `cost anomaly ${outcome.alerted}${outcome.created ? '' : ' (escalated)'}`,
      );
    return outcome.created;
  }
}

// The dev-only spike (spec 007) -----------------------------------------------------------------------------------------

export const DEV_SPIKE_SERVICE = 'landledger-dev-anomaly';

/** How long a dev spike stays before the hourly scan takes it out again. */
export const DEV_SPIKE_TTL_MS = 2 * 60 * 60 * 1000;

/** The dev spike only ever touches a database on this machine. */
export function assertLoopbackDatabase(postgresUrl: string): void {
  let host = '';
  try {
    host = new URL(postgresUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    host = '';
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(host))
    throw new ApiError('forbidden', 'The dev anomaly spike only runs against a database on this machine (localhost)');
}

function devGate(opts: { enabled: boolean; postgresUrl: string }): void {
  if (!opts.enabled)
    throw new ApiError(
      'forbidden',
      'The dev anomaly spike is off: set LANDLEDGER_DEV_ANOMALY=on, on this machine only',
    );
  assertLoopbackDatabase(opts.postgresUrl);
}

/**
 * A test spike: one provisional row today from the `dev-anomaly` source (never a real source, never in the ledger:
 * provisional rows are today's figures, replaced or removed, not booked). Refused unless LANDLEDGER_DEV_ANOMALY=on and
 * the database is on this machine. Only the anomaly scan reads it (every total, budget and export leaves the source
 * out), and the hourly scan takes it out again two hours after it was made.
 */
export async function devSpike(
  sql: Sql,
  audit: AuditLog,
  opts: { enabled: boolean; postgresUrl: string; amount: string; day: string; startedBy: string; now?: Date },
): Promise<{ recordId: string; runId: string; expiresAt: string }> {
  devGate(opts);
  const expiresAt = new Date((opts.now ?? new Date()).getTime() + DEV_SPIKE_TTL_MS).toISOString();
  const cost = Money.parse(opts.amount, USD);
  const runId = newId('run');
  const recordId = newId('rec');
  const day = opts.day;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO ingest_runs (id, source, kind, day, params, started_by)
      VALUES (${runId}, 'dev-anomaly', 'manual', ${day}, ${tx.json({ provisional: true, devSpike: true, amount: opts.amount, expiresAt })}, ${opts.startedBy})`;
    const row = toRow({
      // An estimate is never billed (FOCUS: BilledCost is the invoice's; estimated rows carry 0).
      BilledCost: Money.zero(USD),
      EffectiveCost: cost,
      ListCost: cost,
      ContractedCost: cost,
      ListUnitPrice: null,
      ContractedUnitPrice: null,
      PricingQuantity: null,
      PricingUnit: null,
      ConsumedQuantity: null,
      ConsumedUnit: null,
      BillingCurrency: USD,
      ChargePeriodStart: `${day}T00:00:00Z`,
      ChargePeriodEnd: `${addDays(day, 1)}T00:00:00Z`,
      ...billingPeriod(day.slice(0, 7)),
      ChargeCategory: 'Usage',
      ChargeClass: null,
      ChargeDescription: 'A dev-only test spike (spec 007); reversed after the test',
      ChargeFrequency: 'Usage-Based',
      PricingCategory: 'Standard',
      ServiceCategory: 'Other',
      ServiceSubcategory: 'Other (Other)',
      ServiceName: DEV_SPIKE_SERVICE,
      ServiceProviderName: 'Landledger (dev test)',
      HostProviderName: null,
      InvoiceIssuerName: 'Landledger (dev test)',
      BillingAccountId: 'dev-anomaly',
      BillingAccountName: null,
      SubAccountId: null,
      SubAccountName: null,
      SubAccountType: null,
      InvoiceId: null,
      ResourceId: null,
      ResourceName: null,
      ResourceType: null,
      SkuId: 'dev-anomaly:spike',
      SkuMeter: null,
      SkuPriceId: 'dev-anomaly:spike',
      SkuPriceDetails: null,
      Tags: { service: DEV_SPIKE_SERVICE, devAnomaly: 'true' },
      AllocatedMethodId: null,
      AllocatedMethodDetails: null,
      AllocatedResourceId: null,
      AllocatedResourceName: null,
      AllocatedTags: null,
      x_RecordId: recordId,
      x_Basis: 'estimated',
      x_Source: 'dev-anomaly',
      x_SourceKey: `dev-anomaly:${day}:${runId}`,
      x_SourceCost: cost.toDecimal(),
      x_RateCardVersion: null,
      x_IngestRunId: runId,
      x_CorrectionOfId: null,
      x_WorkflowId: null,
      x_AgentId: null,
      x_ActorId: null,
      x_OriginalCost: null,
      x_OriginalCurrency: null,
      x_FxRateId: null,
    });
    await tx`INSERT INTO provisional_usage ${tx(row as never)}`;
    await tx`UPDATE ingest_runs SET outcome = 'succeeded', finished_at = now(), new_count = 1 WHERE id = ${runId}`;
    await audit.append(
      {
        actor: opts.startedBy,
        actorKind: 'system',
        action: 'dev_anomaly.spiked',
        subjectType: 'ingest_run',
        subjectId: runId,
        data: { day, amountMicros: cost.micros.toString(), recordId },
      },
      tx,
    );
  });
  return { recordId, runId, expiresAt };
}

/** Takes every dev-anomaly row out: they were provisional, so nothing in the ledger changes. Audited. */
export async function devReverse(
  sql: Sql,
  audit: AuditLog,
  opts: { enabled: boolean; postgresUrl: string; startedBy: string },
): Promise<{ removed: number; ledger: number }> {
  devGate(opts);
  return sql.begin(async (tx) => {
    const gone = await tx`DELETE FROM provisional_usage WHERE source = 'dev-anomaly' RETURNING record_id`;
    const [{ n }] = (await tx`SELECT count(*)::int AS n FROM cost_records WHERE source = 'dev-anomaly'`) as unknown as [
      { n: number },
    ];
    await audit.append(
      {
        actor: opts.startedBy,
        actorKind: 'system',
        action: 'dev_anomaly.reversed',
        subjectType: 'dev_anomaly',
        subjectId: 'provisional',
        data: { removed: gone.length, ledgerRecords: n },
      },
      tx,
    );
    return { removed: gone.length, ledger: n };
  }) as Promise<{ removed: number; ledger: number }>;
}

/** The hourly scan takes out every dev spike past its two hours (audited); a forgotten spike never lingers. */
export async function expireDevSpikes(sql: Sql, audit: AuditLog, now: Date): Promise<number> {
  return sql.begin(async (tx) => {
    const gone = await tx<{ record_id: string }[]>`
      DELETE FROM provisional_usage p USING ingest_runs r
      WHERE p.source = 'dev-anomaly' AND r.id = p.ingest_run_id
        AND coalesce((r.params->>'expiresAt')::timestamptz, r.started_at + interval '2 hours') <= ${now}
      RETURNING p.record_id`;
    if (gone.length)
      await audit.append(
        {
          actor: 'anomalies',
          actorKind: 'system',
          action: 'dev_anomaly.expired',
          subjectType: 'dev_anomaly',
          subjectId: 'provisional',
          data: { removed: gone.length },
        },
        tx,
      );
    return gone.length;
  }) as Promise<number>;
}

// Clickland's alert rule (spec 007) -----------------------------------------------------------------------------------

/** Clickland's alert rule; its runbook is this Landledger's own Anomalies page. */
export const clicklandAlert = (consoleUrl: string) => ({
  name: 'Landledger cost anomaly',
  signal: 'logs',
  query: 'landledger.event:cost.anomaly',
  groupBy: 'landledger.anomaly.dimension',
  thresholdType: 'above',
  threshold: 0,
  windowMinutes: 60,
  intervalMinutes: 5,
  enabled: true,
  severity: 'sev3',
  labels: { team: 'finance', app: 'landledger' },
  runbookUrl: `${consoleUrl.replace(/\/$/, '')}/anomalies`,
});

/**
 * Installs (or brings up to date) Clickland's alert rule that counts Landledger's `cost.anomaly` log records, with a
 * key that holds `alerts:write`. Through Clickland's API only: Clickland's code is not changed.
 */
export async function installClicklandAlert(
  api: { url: string; alertsKey: string | null },
  consoleUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; created: boolean }> {
  if (!api.alertsKey) throw new Error('LANDLEDGER_CLICKLAND_ALERTS_KEY is not set (a Clickland key with alerts:write)');
  const headers = { authorization: `Bearer ${api.alertsKey}`, 'content-type': 'application/json' };
  const list = await fetchImpl(`${api.url}/api/alerts`, { headers });
  if (!list.ok) throw new Error(`Clickland GET /api/alerts: ${list.status}`);
  const { alerts } = (await list.json()) as { alerts: { id: string; name: string }[] };
  const rule = clicklandAlert(consoleUrl);
  const found = alerts.find((a) => a.name === rule.name);
  const res = await fetchImpl(`${api.url}/api/alerts${found ? `/${found.id}` : ''}`, {
    method: found ? 'PUT' : 'POST',
    headers,
    body: JSON.stringify(rule),
  });
  if (!res.ok) throw new Error(`Clickland ${found ? 'PUT' : 'POST'} /api/alerts: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return { id: body.id, created: !found };
}
