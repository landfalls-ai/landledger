/**
 * Anomalies (spec 007). Cost: per dimension (cost center, service, agent, model) and key, a day's cost against a robust
 * baseline of the 14 days before it (median and MAD), checked every hour as today accrues. Approval patterns that look
 * like a control being worked around: a spend split under the automatic threshold, automatic approvals raised again
 * and again, a relayed decision seconds after its card, one approver waving through one requester. Each anomaly is
 * stored once (append only), audited, sent as a webhook (`cost.anomaly`, `approval.anomaly`) and, for cost, logged as
 * an OpenTelemetry record (`landledger.event=cost.anomaly`) that a Clickland alert rule counts. A person acknowledges
 * one with a note; it then leaves Needs you.
 */
import { type AnomalyKind, type AnomalyRule, type AnomalyView, type Dimension } from '@landledger/contracts';
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

  async list(q: { status: 'open' | 'all'; kind?: AnomalyKind; limit: number }): Promise<AnomalyView[]> {
    const since = new Date(this.now().getTime() - BASELINE_DAYS * 86_400_000);
    const rows = await this.sql<AnomalyRow[]>`
      SELECT a.*, a.observed_micros::text AS observed_micros, a.baseline_micros::text AS baseline_micros,
             a.mad_micros::text AS mad_micros, a.score::text AS score,
             coalesce(u.email, u.name) AS ack_by, k.at AS ack_at, k.note AS ack_note
      FROM anomalies a LEFT JOIN anomaly_acks k ON k.anomaly_id = a.id LEFT JOIN users u ON u.id = k.by_user
      WHERE (${q.kind ?? null}::text IS NULL OR a.kind = ${q.kind ?? null})
        AND (${q.status} = 'all' OR (k.anomaly_id IS NULL AND a.detected_at >= ${since}))
      ORDER BY a.detected_at DESC, a.id LIMIT ${q.limit}`;
    return this.views(rows);
  }

  async view(id: string): Promise<AnomalyView> {
    const rows = await this.sql<AnomalyRow[]>`
      SELECT a.*, a.observed_micros::text AS observed_micros, a.baseline_micros::text AS baseline_micros,
             a.mad_micros::text AS mad_micros, a.score::text AS score,
             coalesce(u.email, u.name) AS ack_by, k.at AS ack_at, k.note AS ack_note
      FROM anomalies a LEFT JOIN anomaly_acks k ON k.anomaly_id = a.id LEFT JOIN users u ON u.id = k.by_user
      WHERE a.id = ${id}`;
    if (!rows.length) throw new ApiError('not_found', `Anomaly ${id} not found`);
    return (await this.views(rows))[0]!;
  }

  private async views(rows: AnomalyRow[]): Promise<AnomalyView[]> {
    const ids = [...new Set(rows.flatMap((r) => r.request_ids))];
    const reqs = ids.length
      ? await this.sql<{ id: string; number: number; title: string }[]>`
          SELECT id, number, title FROM requests WHERE id = ANY (${ids})`
      : [];
    const byId = new Map(reqs.map((r) => [r.id, { id: r.id, number: `R-${r.number}`, title: r.title }]));
    return rows.map((r) => ({
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
      baseline: money(r.baseline_micros),
      mad: money(r.mad_micros),
      score: r.score,
      costCenter: r.cost_center,
      requests: r.request_ids.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x),
      detectedAt: iso(r.detected_at),
      acknowledged: r.ack_at ? { by: r.ack_by ?? 'someone', at: iso(r.ack_at), note: r.ack_note ?? '' } : null,
      dev: Array.isArray(r.details.sources) && (r.details.sources as string[]).includes('dev-anomaly'),
    }));
  }

  // Acknowledging -----------------------------------------------------------------------------------------------------

  /** A person acknowledges an anomaly with a note: audited; it leaves Needs you and stays in the list. */
  async acknowledge(id: string, note: string, by: Principal): Promise<AnomalyView> {
    if (by.kind !== 'person')
      throw new ApiError(
        'forbidden',
        'An anomaly is acknowledged by a person signed in with Landbright; a key never does',
      );
    if (by.roles.length > 0 && by.roles.every((r) => r === 'auditor'))
      throw new ApiError('forbidden', 'Auditors read anomalies; they do not acknowledge them');
    await this.sql.begin(async (tx) => {
      const [a] = await tx<
        { id: string; rule: string; key: string }[]
      >`SELECT id, rule, key FROM anomalies WHERE id = ${id}`;
      if (!a) throw new ApiError('not_found', `Anomaly ${id} not found`);
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

  // Scanning ----------------------------------------------------------------------------------------------------------

  /** What the hourly job does: today and yesterday's cost, and the approval patterns. */
  async scan(opts: { days?: string[] } = {}): Promise<ScanResult> {
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

  /** One day's cost per dimension and key against the 14 days before it. */
  async scanCost(day: string): Promise<{ found: number; keys: number; observedDays: number }> {
    const from = addDays(day, -BASELINE_DAYS);
    const before = addDays(day, -1);
    const observed = await this.sql<{ day: Date }[]>`
      SELECT DISTINCT day FROM ingest_runs
      WHERE outcome = 'succeeded' AND source IN ('landflow', 'clickland') AND day BETWEEN ${from} AND ${before}`;
    const baseDays = observed.map((r) => r.day.toISOString().slice(0, 10)).sort();
    const { lines } = await this.spend.lines({ from, to: day });
    const ccs = await this.spend.costCenters();
    const minMicros = Money.parse(this.options.minUsd, USD).micros;
    let found = 0;
    let keys = 0;
    for (const dimension of COST_DIMENSIONS) {
      // cost per key per charge day; corrections are booked later for an earlier month, never a day's usage.
      const series = new Map<string, { label: string; costCenter: string | null; days: Map<string, bigint> }>();
      for (const l of lines) {
        if (l.correction) continue;
        const k = keyOf(l, dimension, ccs);
        if (k.key === '(none)' || k.key === '') continue;
        const s = series.get(k.key) ?? { label: k.label, costCenter: null as string | null, days: new Map() };
        if (dimension === 'costCenter') s.costCenter = l.costCenter;
        s.days.set(l.day, (s.days.get(l.day) ?? 0n) + l.amount.micros);
        series.set(k.key, s);
      }
      for (const [key, s] of series) {
        const today = s.days.get(day) ?? 0n;
        if (today <= 0n) continue;
        keys++;
        const baseline = baseDays.map((d) => s.days.get(d) ?? 0n);
        const c = checkCost(baseline, today, minMicros);
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

  /** The approval patterns over the last 90 days. */
  async scanApprovals(): Promise<number> {
    const now = this.now();
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    let found = 0;

    // split and automatic_ratchet --------------------------------------------------------------------------------
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
      }[]
    >`
      SELECT r.id, r.kind, r.cost_center, r.amount_micros::text AS amount_micros, r.created_at, r.decided_at, r.automatic,
             CASE WHEN r.agent_id IS NOT NULL THEN 'agent:' || r.agent_id ELSE r.requester_id END AS who,
             coalesce(r.agent_name, u.name, u.email, r.requester_id) AS who_name
      FROM requests r LEFT JOIN users u ON u.id = r.requester_id
      WHERE r.created_at >= ${ago(30)} AND r.status <> 'draft' AND r.change IS NULL
        AND (r.requester_id IS NOT NULL OR r.agent_id IS NOT NULL)
      ORDER BY r.created_at, r.id`;
    const groups = new Map<string, (typeof reqs)[number][]>();
    for (const r of reqs) {
      const g = `${r.who}|${r.cost_center}|${r.kind}`;
      groups.set(g, [...(groups.get(g) ?? []), r]);
    }
    const thresholds = new Map<string, Money | null>();
    for (const rows of groups.values()) {
      const { who, who_name, cost_center: cc, kind } = rows[0]!;
      const tKey = `${kind}|${cc}`;
      if (!thresholds.has(tKey)) {
        const p = await this.policies.forRequest(kind as never, cc).catch(() => null);
        thresholds.set(tKey, p?.automaticBelow ? Money.parse(p.automaticBelow, USD) : null);
      }
      const threshold = thresholds.get(tKey)!;
      if (!threshold) continue;
      const byId = new Map(rows.map((r) => [r.id, r]));
      const raised = rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at.getTime(),
        micros: BigInt(r.amount_micros),
      }));
      for (const run of findSplits(raised, threshold.micros)) {
        const window = run.map((r) => byId.get(r.id)!);
        const sum = run.reduce((a, r) => a + r.micros, 0n);
        const stored = await this.store({
          kind: 'approval',
          rule: 'split',
          dimension: 'requester',
          key: `${who}:${cc}`,
          label: `${who_name} on ${cc}`,
          windowStart: iso(window[0]!.created_at),
          windowEnd: iso(window.at(-1)!.created_at),
          summary: `${who_name} raised ${run.length} ${kind.replace('_', ' ')} requests on ${cc} within 72 hours, each under the automatic threshold of ${words(threshold)} and ${words(usd(sum))} together`,
          observed: usd(sum),
          costCenter: cc,
          requestIds: window.map((r) => r.id),
          details: { threshold: amount(threshold), count: run.length },
        });
        if (stored) found++;
      }
    }
    const autos = new Map<string, (typeof reqs)[number][]>();
    for (const r of reqs)
      if (r.automatic && r.decided_at && r.decided_at >= ago(30)) {
        const g = `${r.who}|${r.cost_center}`;
        autos.set(g, [...(autos.get(g) ?? []), r]);
      }
    for (const rows of autos.values()) {
      if (rows.length < 3) continue;
      const { who, who_name, cost_center: cc } = rows[0]!;
      const sorted = [...rows].sort((a, b) => a.decided_at!.getTime() - b.decided_at!.getTime());
      const sum = rows.reduce((a, r) => a + BigInt(r.amount_micros), 0n);
      const stored = await this.store({
        kind: 'approval',
        rule: 'automatic_ratchet',
        dimension: 'requester',
        key: `${who}:${cc}`,
        label: `${who_name} on ${cc}`,
        windowStart: iso(sorted[0]!.decided_at!),
        windowEnd: iso(sorted.at(-1)!.decided_at!),
        summary: `${rows.length} requests by ${who_name} on ${cc} were approved automatically within 30 days, ${words(usd(sum))} in all: each under the threshold, none seen by a person`,
        observed: usd(sum),
        costCenter: cc,
        requestIds: sorted.map((r) => r.id),
        details: { count: rows.length },
      });
      if (stored) found++;
    }

    // fast_relay -------------------------------------------------------------------------------------------------------
    const relays = await this.sql<
      {
        id: string;
        request_id: string;
        decided_at: Date;
        card_at: Date | null;
        approver: string;
        channel: string | null;
        cost_center: string;
        number: number;
      }[]
    >`
      SELECT d.id, d.request_id, d.decided_at, d.channel, r.cost_center, r.number,
             coalesce(u.email, u.name) AS approver,
             (SELECT min(s.served_at) FROM evidence_serves s
              WHERE s.request_id = d.request_id AND s.sha256 = d.evidence_sha256 AND s.to_kind IN ('key', 'webhook')
                AND s.served_at <= d.decided_at) AS card_at
      FROM decisions d JOIN requests r ON r.id = d.request_id JOIN users u ON u.id = d.decided_by
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
        details: { seconds: Number((ms / 1000).toFixed(1)), approver: d.approver },
      });
      if (stored) found++;
    }

    // same_pair --------------------------------------------------------------------------------------------------------
    const decided = await this.sql<
      { request_id: string; decided_at: Date; approver_id: string; approver: string; who: string; who_name: string }[]
    >`
      SELECT d.request_id, d.decided_at, d.decided_by AS approver_id, coalesce(a.email, a.name) AS approver,
             CASE WHEN r.agent_id IS NOT NULL THEN 'agent:' || r.agent_id ELSE r.requester_id END AS who,
             coalesce(r.agent_name, u.name, u.email, r.requester_id) AS who_name
      FROM decisions d JOIN requests r ON r.id = d.request_id JOIN users a ON a.id = d.decided_by
      LEFT JOIN users u ON u.id = r.requester_id
      WHERE d.decided_at >= ${ago(90)} AND (r.requester_id IS NOT NULL OR r.agent_id IS NOT NULL)
      ORDER BY d.decided_at`;
    for (const p of findSamePairs(decided.map((d) => ({ ...d, approver: d.approver_id, requester: d.who })))) {
      const { approver_id, approver, who, who_name } = decided.find(
        (d) => d.approver_id === p.approver && d.who === p.requester,
      )!;
      const share = Math.round((p.rows.length / p.of) * 100);
      const stored = await this.store({
        kind: 'approval',
        rule: 'same_pair',
        dimension: 'approver',
        key: `${approver_id}:${who}`,
        label: `${approver} for ${who_name}`,
        windowStart: iso(p.rows[0]!.decided_at),
        windowEnd: iso(p.rows.at(-1)!.decided_at),
        summary: `${approver} made ${p.rows.length} of the ${p.of} decisions on ${who_name}'s requests in 90 days (${share}%): one approver for one requester`,
        requestIds: [...new Set(p.rows.map((r) => r.request_id))],
        details: { count: p.rows.length, of: p.of, share },
      });
      if (stored) found++;
    }
    return found;
  }

  /** Stores an anomaly once; audits it, sends its webhook, and logs a cost anomaly for Clickland. */
  private async store(a: NewAnomaly): Promise<boolean> {
    const id = newId('anm');
    const created = await this.sql.begin(async (tx: Tx) => {
      const rows = await tx`
        INSERT INTO anomalies (id, kind, rule, dimension, key, label, window_start, window_end, summary,
                               observed_micros, baseline_micros, mad_micros, score, cost_center, request_ids, details,
                               detected_at)
        VALUES (${id}, ${a.kind}, ${a.rule}, ${a.dimension}, ${a.key}, ${a.label}, ${a.windowStart}, ${a.windowEnd},
                ${a.summary}, ${a.observed?.micros.toString() ?? null}, ${a.baseline?.micros.toString() ?? null},
                ${a.mad?.micros.toString() ?? null}, ${a.score ?? null}, ${a.costCenter ?? null}, ${a.requestIds ?? []},
                ${tx.json((a.details ?? {}) as never)}, ${this.now()})
        ON CONFLICT (kind, rule, dimension, key, window_start) DO NOTHING RETURNING id`;
      if (!rows.length) return false;
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
      return true;
    });
    if (!created) return false;
    const view = await this.view(id);
    const url = `${this.options.consoleUrl}/anomalies?id=${id}`;
    await this.sql.begin((tx) =>
      this.webhooks.enqueue(tx, a.kind === 'cost' ? 'cost.anomaly' : 'approval.anomaly', { anomaly: view, url }),
    );
    // Out to Clickland as an OpenTelemetry log record (pino → OTLP): Clickland's alert rule counts these.
    this.log.warn(
      {
        'landledger.event': `${a.kind}.anomaly`,
        'landledger.anomaly.id': id,
        'landledger.anomaly.rule': a.rule,
        'landledger.anomaly.dimension': a.dimension,
        'landledger.anomaly.key': a.key,
        'landledger.anomaly.observed': view.observed,
        'landledger.anomaly.baseline': view.baseline,
        'landledger.anomaly.cost_center': a.costCenter ?? '',
        'landledger.anomaly.dev': String(view.dev),
        'landledger.anomaly.url': url,
      },
      `${a.kind} anomaly: ${a.summary}`,
    );
    return true;
  }
}

// The dev-only spike (spec 007) -----------------------------------------------------------------------------------------

export const DEV_SPIKE_SERVICE = 'landledger-dev-anomaly';

/**
 * A test spike: one provisional row today from the `dev-anomaly` source (never a real source, never in the ledger:
 * provisional rows are today's figures, replaced or removed, not booked). Refused unless LANDLEDGER_DEV_ANOMALY=on.
 */
export async function devSpike(
  sql: Sql,
  audit: AuditLog,
  opts: { enabled: boolean; amount: string; day: string; startedBy: string },
): Promise<{ recordId: string; runId: string }> {
  if (!opts.enabled)
    throw new ApiError(
      'forbidden',
      'The dev anomaly spike is off: set LANDLEDGER_DEV_ANOMALY=on, on this machine only',
    );
  const cost = Money.parse(opts.amount, USD);
  const runId = newId('run');
  const recordId = newId('rec');
  const day = opts.day;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO ingest_runs (id, source, kind, day, params, started_by)
      VALUES (${runId}, 'dev-anomaly', 'manual', ${day}, ${tx.json({ provisional: true, devSpike: true, amount: opts.amount })}, ${opts.startedBy})`;
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
  return { recordId, runId };
}

/** Takes every dev-anomaly row out: they were provisional, so nothing in the ledger changes. Audited. */
export async function devReverse(
  sql: Sql,
  audit: AuditLog,
  opts: { enabled: boolean; startedBy: string },
): Promise<{ removed: number; ledger: number }> {
  if (!opts.enabled)
    throw new ApiError(
      'forbidden',
      'The dev anomaly spike is off: set LANDLEDGER_DEV_ANOMALY=on, on this machine only',
    );
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

// Clickland's alert rule (spec 007) -----------------------------------------------------------------------------------

export const CLICKLAND_ALERT = {
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
  runbookUrl: 'http://localhost:4811/anomalies',
} as const;

/**
 * Installs (or brings up to date) Clickland's alert rule that counts Landledger's `cost.anomaly` log records, with a
 * key that holds `alerts:write`. Through Clickland's API only: Clickland's code is not changed.
 */
export async function installClicklandAlert(
  api: { url: string; alertsKey: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; created: boolean }> {
  if (!api.alertsKey) throw new Error('LANDLEDGER_CLICKLAND_ALERTS_KEY is not set (a Clickland key with alerts:write)');
  const headers = { authorization: `Bearer ${api.alertsKey}`, 'content-type': 'application/json' };
  const list = await fetchImpl(`${api.url}/api/alerts`, { headers });
  if (!list.ok) throw new Error(`Clickland GET /api/alerts: ${list.status}`);
  const { alerts } = (await list.json()) as { alerts: { id: string; name: string }[] };
  const found = alerts.find((a) => a.name === CLICKLAND_ALERT.name);
  const res = await fetchImpl(`${api.url}/api/alerts${found ? `/${found.id}` : ''}`, {
    method: found ? 'PUT' : 'POST',
    headers,
    body: JSON.stringify(CLICKLAND_ALERT),
  });
  if (!res.ok) throw new Error(`Clickland ${found ? 'PUT' : 'POST'} /api/alerts: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return { id: body.id, created: !found };
}
