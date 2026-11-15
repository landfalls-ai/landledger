/**
 * The read side of wave 1 (docs/spend.md, specs 002 and 003): spend grouped by any dimension (Explore), the Overview's
 * month to date, forecast, budget and burn, and Budgets. Exact: every amount is summed in micro-units and written as a
 * six-decimal string. Records are read with their direct allocation (the newest generation of their month); today's
 * provisional rows, and anything entered since the last generation, are allocated as they are read.
 *
 * Two ways to choose records: a **month** is every record booked in it (its billing period), so a locked month never
 * changes and a correction to a locked month is reported on its own line in the month it was booked; a **range of
 * days** (`from`/`to`) is every record charged on those days, wherever it was booked.
 */
import {
  type AllocInput,
  allocateDirect,
  type DirectRow,
  SHARED_POOL,
  spread,
  UNALLOCATED,
} from '@landledger/allocation';
import {
  type Amount,
  type BudgetLine,
  type BudgetState,
  type BudgetsView,
  type CostCenterLine,
  CORRECTIONS,
  DIMENSION_LABEL,
  type Dimension,
  DRILL,
  type Overview,
  type SpendGroup,
  type SpendQuery,
  type SpendResult,
} from '@landledger/contracts';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import { type Allocation, allocInputOf, type AllocRow, type RuleBook } from './allocation.js';
import type { Budgets } from './budgets.js';
import { day as dayOf, type Sql } from './db.js';
import { band, commitmentsIn, halfWidth, reservedIn, runningIncrements, Z90 } from './forecast.js';
import { ApiError } from './errors.js';
import { devExcluded, hiddenSql } from './read-rule.js';
import type { RateCards } from './ratecards.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const USD = REPORTING_CURRENCY;
const zero = () => Money.zero(USD);
export const amount = (m: Money): Amount => m.toDecimal().toFixed(6, 'halfEven');

/** The run rate's window: the last seven UTC days, today included. */
export const RUN_RATE_DAYS = 7;
/** A source needs this many full observed days in the window before Landledger forecasts from it. */
export const MIN_FULL_DAYS = 3;
/** A day is fully observed when its source covered at least this many hours of it. */
export const FULL_DAY_HOURS = 23;

export { CORRECTIONS };
const CORRECTIONS_LABEL = 'Corrections to locked months';
const CORRECTIONS_SUB = 'Charged in an earlier, locked month; booked in this one';

/** One row of spend: a cost record (or provisional row) with its allocation. */
export interface Line {
  recordId: string;
  /** The UTC day it was charged. */
  day: string;
  /** The month it is booked in (its billing period). */
  month: string;
  /** In a month's view, the day it counts on: the charge day, or for a correction the day it was booked. */
  postDay: string;
  basis: 'estimated' | 'invoiced';
  provisional: boolean;
  /** `ChargeClass = Correction`: a correction to a locked month, booked in a later month. */
  correction: boolean;
  source: string;
  amount: Money;
  /** Consumed quantity and its unit (a forecast's driver, spec 006); null when the record has none. */
  quantity: Decimal | null;
  unit: string | null;
  tags: Record<string, unknown>;
  serviceName: string;
  serviceCategory: string;
  providerName: string;
  resourceName: string | null;
  costCenter: string;
  team: string | null;
  product: string | null;
  plClass: string | null;
  capitalisable: boolean;
  ruleId: string | null;
}

type Row = AllocRow & {
  charge_class: string | null;
  consumed_quantity: string | null;
  consumed_unit: string | null;
  recorded_at: Date;
  service_category: string;
  service_provider_name: string;
  resource_name: string | null;
  cost_center: string | null;
  team: string | null;
  product: string | null;
  pl_class: string | null;
  capitalisable: boolean | null;
  rule_id: string | null;
};

const RESOURCE_LABEL: Record<string, string> = {
  cpu: 'CPU',
  memory: 'Memory',
  storage: 'Storage',
  network: 'Network',
  ai: 'AI tokens',
};
const PL_LABEL: Record<string, string> = {
  cost_of_revenue: 'Cost of revenue',
  rnd: 'R&D',
  sm: 'Sales & marketing',
  ga: 'G&A',
  shared: 'Shared pool',
  unclassified: 'Not classified',
  correction: CORRECTIONS_LABEL,
};

const str = (t: Record<string, unknown>, k: string) => (typeof t[k] === 'string' ? (t[k] as string) : '');

export interface CostCenterInfo {
  code: string;
  name: string;
  owner: string | null;
}

export const ccLabel = (code: string, ccs: Map<string, CostCenterInfo>) =>
  code === SHARED_POOL
    ? 'Shared pool'
    : code === UNALLOCATED
      ? 'Unallocated'
      : code === CORRECTIONS
        ? CORRECTIONS_LABEL
        : (ccs.get(code)?.name ?? code);

/** A line's P&L class for the split: its rule's, or the shared pool (idle and shared services), or none. */
export const plClassOf = (l: Line): string => l.plClass ?? (l.costCenter === SHARED_POOL ? 'shared' : 'unclassified');

/** A line's key, label and second line under a dimension. */
export function keyOf(
  l: Line,
  by: Dimension,
  ccs: Map<string, CostCenterInfo>,
): { key: string; label: string; sub: string | null } {
  const t = l.tags;
  switch (by) {
    case 'costCenter':
      return {
        key: l.costCenter,
        label: ccLabel(l.costCenter, ccs),
        sub:
          l.costCenter === SHARED_POOL
            ? 'Idle capacity and shared services'
            : l.costCenter === UNALLOCATED
              ? 'No rule matched'
              : l.costCenter,
      };
    case 'team':
      return { key: l.team ?? '(none)', label: l.team ?? 'No team', sub: null };
    case 'product':
      return { key: l.product ?? '(none)', label: l.product ?? 'No product', sub: null };
    case 'service': {
      const s = str(t, 'service') || l.serviceName;
      return { key: s, label: s, sub: str(t, 'namespace') || l.serviceName };
    }
    case 'namespace': {
      const n = str(t, 'namespace');
      return {
        key: n || '(none)',
        label: n || 'No namespace',
        sub: n.startsWith('compose:') ? 'Docker compose project' : n ? 'Kubernetes namespace' : null,
      };
    }
    case 'agent': {
      const a = str(t, 'agent');
      return { key: a || '(none)', label: a ? str(t, 'agentName') || a : 'No agent', sub: a || null };
    }
    case 'model': {
      const m = str(t, 'model');
      return { key: m || '(none)', label: m || 'Not a model', sub: m ? str(t, 'provider') : null };
    }
    case 'provider': {
      const p = l.providerName;
      return { key: p, label: p, sub: null };
    }
    case 'plClass': {
      const p = plClassOf(l);
      return { key: p, label: PL_LABEL[p] ?? p, sub: null };
    }
    case 'category':
      return { key: l.serviceCategory, label: l.serviceCategory, sub: null };
    case 'resource': {
      const r = str(t, 'resource') || 'other';
      const idle = str(t, 'idle') === 'true';
      return { key: idle ? `${r}:idle` : r, label: `${RESOURCE_LABEL[r] ?? r}${idle ? ' (idle)' : ''}`, sub: null };
    }
    case 'workflow': {
      const w = str(t, 'workflow');
      return { key: w || '(none)', label: w ? str(t, 'workflowName') || w : 'No workflow', sub: w || null };
    }
  }
}

const correctionsKey = { key: CORRECTIONS, label: CORRECTIONS_LABEL, sub: CORRECTIONS_SUB };

const pct = (part: Money, whole: Money): string =>
  whole.isZero()
    ? '0.0'
    : Decimal.of(part.micros * 1000n)
        .divide(Decimal.of(whole.micros), 0, 'halfEven')
        .divide('10', 1, 'halfEven')
        .toString();

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
export const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const monthDays = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
export const addMonths = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const hoursOf = (ms: number) => Decimal.of(BigInt(Math.max(0, Math.round(ms)))).divide('3600000', 9, 'halfEven');

function parseFilters(f: SpendQuery['filter']): { dimension: Dimension; value: string }[] {
  const list = (Array.isArray(f) ? f : f ? [f] : [])
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean);
  return list.map((x) => {
    const i = x.indexOf(':');
    const dim = x.slice(0, i) as Dimension;
    if (i < 1 || !(dim in DIMENSION_LABEL))
      throw new ApiError('bad_request', `A filter is dimension:value, e.g. costCenter:ENG-PLATFORM (got ${x})`);
    return { dimension: dim, value: x.slice(i + 1) };
  });
}

/** Which records a read takes: the months they are booked in, or the days they were charged. */
export type Selection = { fromMonth: string; toMonth: string } | { from: string; to: string };

/** A source's observed hours per day (from its runs) and its run rate. */
export interface SourceRate {
  source: string;
  since: string | null;
  fullDays: number;
  hours: Decimal;
  cost: Money;
  /** Cost per observed hour; null without observed hours. */
  perHour: Decimal | null;
  /** The lowest and highest cost per hour of its full observed days. */
  low: Decimal | null;
  high: Decimal | null;
  /** Each full observed day's cost (the band's spread, spec 006). */
  fullCosts: Money[];
  /** Consumed quantity per observed day, per unit (the source's drivers, spec 006). */
  drivers: { unit: string; perDay: Decimal }[];
}

export interface RunRate {
  enough: boolean;
  sources: SourceRate[];
  /** Σ per-hour rates (null when not enough data). */
  perHour: { low: Decimal; mid: Decimal; high: Decimal } | null;
  dataSince: string | null;
  basis: string;
}

/**
 * The run rate (docs/spend.md): per source, Σ cost ÷ Σ observed hours over the last seven days (today's partial day
 * weighs by its hours, not as a day). With fewer than three full observed days for any source there is no forecast.
 * The range is the lowest and highest full day's cost per hour, per source, summed.
 */
export function runRateOf(
  lines: readonly Line[],
  observed: ReadonlyMap<string, Map<string, number>>,
  since: ReadonlyMap<string, string>,
  window: { from: string; to: string },
): RunRate {
  const sources = new Set<string>([...observed.keys()]);
  const cost = new Map<string, Map<string, Money>>();
  for (const l of lines) {
    if (l.day < window.from || l.day > window.to) continue;
    sources.add(l.source);
    const m = cost.get(l.source) ?? new Map<string, Money>();
    m.set(l.day, (m.get(l.day) ?? zero()).plus(l.amount));
    cost.set(l.source, m);
  }
  const rates: SourceRate[] = [...sources].sort().map((source) => {
    const hours = observed.get(source) ?? new Map<string, number>();
    const days = cost.get(source) ?? new Map<string, Money>();
    let h = Decimal.ZERO;
    let c = zero();
    const fullRates: Decimal[] = [];
    const fullCosts: Money[] = [];
    let fullDays = 0;
    for (const [d, ms] of hours) {
      if (d < window.from || d > window.to) continue;
      const dh = hoursOf(ms);
      h = h.plus(dh);
      const dc = days.get(d) ?? zero();
      c = c.plus(dc);
      if (ms >= FULL_DAY_HOURS * HOUR_MS) {
        fullDays++;
        fullRates.push(dc.toDecimal().divide(dh, 12, 'halfEven'));
        fullCosts.push(dc);
      }
    }
    // Cost on a day no run observed (none in the window today) is left out: a rate is cost over the hours it covers.
    const perHour = h.isZero() ? null : c.toDecimal().divide(h, 12, 'halfEven');
    const low = fullRates.length ? fullRates.reduce((a, b) => (b.compare(a) < 0 ? b : a)) : null;
    const high = fullRates.length ? fullRates.reduce((a, b) => (b.compare(a) > 0 ? b : a)) : null;
    // Drivers: what the source consumed per observed day, by unit, over the days it observed.
    const qty = new Map<string, Decimal>();
    for (const l of lines)
      if (l.source === source && l.unit && l.quantity && l.day >= window.from && l.day <= window.to && hours.has(l.day))
        qty.set(l.unit, (qty.get(l.unit) ?? Decimal.ZERO).plus(l.quantity));
    const observedDays = h.isZero() ? null : h.divide('24', 12, 'halfEven');
    const drivers = observedDays
      ? [...qty.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([unit, q]) => ({ unit, perDay: q.divide(observedDays, 6, 'halfEven') }))
      : [];
    return {
      source,
      since: since.get(source) ?? null,
      fullDays,
      hours: h,
      cost: c,
      perHour,
      low,
      high,
      fullCosts,
      drivers,
    };
  });
  const enough = rates.length > 0 && rates.every((r) => r.fullDays >= MIN_FULL_DAYS && r.perHour !== null);
  const dataSince = rates.map((r) => r.since).reduce<string | null>((a, b) => (b && (!a || b > a) ? b : a), null);
  const sum = (f: (r: SourceRate) => Decimal) => rates.reduce((a, r) => a.plus(f(r)), Decimal.ZERO);
  const short = rates.filter((r) => r.fullDays < MIN_FULL_DAYS).map((r) => `${r.source} has ${r.fullDays}`);
  return {
    enough,
    sources: rates,
    perHour: enough ? { low: sum((r) => r.low!), mid: sum((r) => r.perHour!), high: sum((r) => r.high!) } : null,
    dataSince,
    basis: enough
      ? `Run rate per source over ${window.from} to ${window.to}: Σ cost ÷ Σ observed hours (${rates.map((r) => `${r.source} ${r.hours.toFixed(1, 'halfEven')} h`).join(', ')}); the band from how much the full days vary`
      : rates.length
        ? `Not enough data yet: a forecast needs ${MIN_FULL_DAYS} full observed days of each source in the last ${RUN_RATE_DAYS} (${short.join(', ')})`
        : 'Not enough data yet: no source has been read in the last seven days',
  };
}

/** Where a cost center stands: over (a fact), else at risk or on track by the forecast, else too early to say. */
export function stateOf(actual: Money, forecast: Money | null, budget: Money | null): BudgetState {
  if (!budget) return 'none';
  if (actual.compare(budget) > 0) return 'over';
  if (!forecast) return 'early';
  if (forecast.compare(budget) > 0) return 'risk';
  return 'ok';
}

/** A line's amount, in the reporting currency or refused: nothing converts silently (spec 001). */
export function reportingAmount(micros: string, currency: string, recordId: string): Money {
  const code = currency.trim();
  if (code !== USD)
    throw new ApiError(
      'internal',
      `Record ${recordId} is in ${code}: reports are in ${USD}, and a record in another currency is converted at ingest (x_FxRateId), never when read`,
    );
  return Money.ofMicros(micros, code);
}

export class Spend {
  /** Set by services: what contracts hold in a month from a day (Contracts.contractedIn), in the forecast. */
  contractedIn: ((month: string, fromDay: string) => Promise<Money>) | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly allocation: Allocation,
    private readonly budgets: Budgets,
    private readonly rateCards: RateCards,
    private readonly clicklandConsoleUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  today() {
    return this.now().toISOString().slice(0, 10);
  }

  /** What approved requests still hold in a month, per cost center: each reservation's amount less what it consumed. */
  async reservedByCostCenter(month: string): Promise<Map<string, Money>> {
    const rows = await this.sql<{ cost_center: string; micros: string }[]>`
      SELECT cost_center, sum(greatest(amount_micros - consumed_micros, 0))::text AS micros FROM reservations
      WHERE status = 'reserved' AND month = ${`${month}-01`} GROUP BY cost_center`;
    return new Map(rows.map((r) => [r.cost_center, Money.ofMicros(r.micros, USD)]));
  }

  async costCenters(): Promise<Map<string, CostCenterInfo>> {
    const rows = await this.sql<{ code: string; name: string; owner_name: string | null }[]>`
      SELECT DISTINCT ON (code) code, name, owner_name FROM cost_centers ORDER BY code, version DESC`;
    return new Map(rows.map((r) => [r.code, { code: r.code, name: r.name, owner: r.owner_name }]));
  }

  /**
   * The lines a selection holds, with their direct allocation: the months they are booked in (`fromMonth` to
   * `toMonth`, with those months' provisional rows), or the days they were charged (`from` to `to`, inclusive).
   */
  async lines(
    sel: Selection,
    provisional = true,
    opts: { includeDev?: boolean } = {},
  ): Promise<{ lines: Line[]; book: RuleBook; inputs: AllocInput[] }> {
    const s = this.sql;
    const byMonth = 'fromMonth' in sel;
    const start = byMonth ? `${sel.fromMonth}-01T00:00:00Z` : `${sel.from}T00:00:00Z`;
    const end = byMonth ? `${addMonths(sel.toMonth, 1)}-01T00:00:00Z` : `${addDays(sel.to, 1)}T00:00:00Z`;
    const cols = s.unsafe(
      'r.record_id, r.billing_period_start, r.charge_period_start, r.charge_class, r.recorded_at, r.basis, r.source, r.tags, r.sku_meter, r.actor_id, r.service_name, r.effective_cost_micros, r.billing_currency, r.service_category, r.service_provider_name, r.resource_name, r.consumed_quantity::text AS consumed_quantity, r.consumed_unit',
    );
    const where = byMonth
      ? s`r.billing_period_start >= ${start}::timestamptz AND r.billing_period_start < ${end}::timestamptz`
      : s`r.charge_period_start >= ${start}::timestamptz AND r.charge_period_start < ${end}::timestamptz`;
    const dev = devExcluded(s, !!opts.includeDev);
    const ledger = await s<Row[]>`
      SELECT ${cols}, a.cost_center, a.team, a.product, a.pl_class, a.capitalisable, a.rule_id
      FROM cost_records r
      LEFT JOIN LATERAL (
        SELECT a.* FROM allocations a JOIN allocation_generations g ON g.id = a.generation_id
        WHERE a.month = (r.billing_period_start AT TIME ZONE 'UTC')::date AND a.record_id = r.record_id
        ORDER BY g.number DESC LIMIT 1) a ON TRUE
      WHERE ${where} AND ${dev}
        -- An estimate an invoice line replaces is never added to it (invoice_estimate_links, 0006, 0012, 0013): left
        -- out while the invoiced entry its split or late link names was live as of the estimate's own billing month,
        -- so a re-entered invoice keeps it replaced, a void in an open month gives it back, and a locked month never
        -- moves (read-rule.ts). A dev fixture's records and the dev-anomaly spike count nowhere.
        AND NOT (r.basis = 'estimated' AND ${hiddenSql(s)})`;
    // Provisional rows are booked in the month they are charged in, so both selections read them by charge day.
    const prov = provisional
      ? await s<Row[]>`
          SELECT ${cols}, NULL AS cost_center, NULL AS team, NULL AS product, NULL AS pl_class, NULL AS capitalisable, NULL AS rule_id
          FROM provisional_usage r
          WHERE r.charge_period_start >= ${start}::timestamptz AND r.charge_period_start < ${end}::timestamptz
            AND ${dev}`
      : [];
    const book = await this.allocation.book();
    const pending = [...ledger.filter((r) => r.cost_center === null), ...prov];
    const direct = new Map<string, DirectRow>(
      allocateDirect(pending.map(allocInputOf), (d) => book.versionOn(d)).map((d) => [d.recordId, d]),
    );
    const provIds = new Set(prov.map((r) => r.record_id));
    const inputs: AllocInput[] = [];
    const lines = [...ledger, ...prov].map((r): Line => {
      const d = r.cost_center === null ? direct.get(r.record_id)! : null;
      inputs.push(allocInputOf(r));
      const month = dayOf(r.billing_period_start).slice(0, 7);
      const charged = dayOf(r.charge_period_start);
      const correction = r.charge_class === 'Correction';
      const booked = r.recorded_at.toISOString().slice(0, 10);
      const monthEnd = `${month}-${String(monthDays(month)).padStart(2, '0')}`;
      return {
        recordId: r.record_id,
        day: charged,
        month,
        postDay: correction
          ? booked < `${month}-01`
            ? `${month}-01`
            : booked > monthEnd
              ? monthEnd
              : booked
          : charged,
        basis: r.basis,
        provisional: provIds.has(r.record_id),
        correction,
        source: r.source,
        amount: reportingAmount(r.effective_cost_micros, r.billing_currency, r.record_id),
        quantity: r.consumed_quantity ? Decimal.parse(r.consumed_quantity) : null,
        unit: r.consumed_unit,
        tags: (r.tags ?? {}) as Record<string, unknown>,
        serviceName: r.service_name,
        serviceCategory: r.service_category,
        providerName: r.service_provider_name,
        resourceName: r.resource_name,
        costCenter: d ? d.costCenter : r.cost_center!,
        team: d ? d.team : r.team,
        product: d ? d.product : r.product,
        plClass: d ? d.plClass : r.pl_class,
        capitalisable: d ? d.capitalisable : !!r.capitalisable,
        ruleId: d ? d.ruleId : r.rule_id,
      };
    });
    return { lines, book, inputs };
  }

  /** The spread layer of `lines`: shared-pool lines split among cost centers by the share rules in effect. */
  spreadLines(lines: Line[], inputs: AllocInput[], book: RuleBook): { lines: Line[]; warnings: string[] } {
    const byId = new Map(lines.map((l) => [l.recordId, l]));
    const direct: DirectRow[] = lines.map((l) => ({
      recordId: l.recordId,
      day: l.day,
      amount: l.amount,
      costCenter: l.costCenter,
      team: l.team,
      product: l.product,
      plClass: (l.plClass as DirectRow['plClass']) ?? null,
      capitalisable: l.capitalisable,
      ruleId: l.ruleId,
      ruleSetVersionId: null,
    }));
    const out = spread(inputs, direct, (d) => book.sharesOn(d));
    return {
      lines: out.rows.map((r) => ({
        ...byId.get(r.recordId)!,
        amount: r.amount,
        costCenter: r.costCenter,
        ruleId: r.spread ? `share:${r.spread.shareRuleId}` : r.ruleId,
      })),
      warnings: out.warnings,
    };
  }

  /** A month (booked in it, up to today) or a range of charge days. */
  private window(q: { month?: string; from?: string; to?: string }) {
    const today = this.today();
    if (q.from || q.to) {
      const from = q.from ?? q.to!;
      const to = q.to ?? q.from!;
      if (to < from) throw new ApiError('bad_request', '`to` is on or after `from`');
      if (daysBetween(from, to) > 400) throw new ApiError('bad_request', 'At most 400 days at a time');
      return { kind: 'charge' as const, from, to, month: null };
    }
    const month = q.month ?? today.slice(0, 7);
    const from = `${month}-01`;
    const last = `${month}-${String(monthDays(month)).padStart(2, '0')}`;
    return { kind: 'billing' as const, from, to: last < today ? last : today < from ? from : today, month };
  }

  async spend(q: SpendQuery): Promise<SpendResult> {
    const w = this.window(q);
    const { from, to } = w;
    const filters = parseFilters(q.filter);
    const len = daysBetween(from, to);
    const ccs = await this.costCenters();
    const prov = q.provisional === 'true';
    let current: Line[];
    let previous: Line[];
    let book: RuleBook;
    let inputs: AllocInput[];
    if (w.kind === 'billing') {
      // This month's bookings; the window before is last month's bookings over the same days (all of it once a month
      // is complete).
      const prevMonth = addMonths(w.month, -1);
      const loaded = await this.lines({ fromMonth: prevMonth, toMonth: w.month }, prov);
      ({ book, inputs } = loaded);
      current = loaded.lines.filter((l) => l.month === w.month);
      const complete = len === monthDays(w.month);
      const prevTo = addDays(`${prevMonth}-01`, len - 1);
      previous = loaded.lines.filter((l) => l.month === prevMonth && (complete || l.postDay <= prevTo));
    } else {
      const loaded = await this.lines({ from: addDays(from, -len), to }, prov);
      ({ book, inputs } = loaded);
      current = loaded.lines.filter((l) => l.day >= from);
      previous = loaded.lines.filter((l) => l.day < from);
    }
    const warnings: string[] = [];
    if (q.layer === 'spread') {
      const all = [...current, ...previous];
      const s = this.spreadLines(all, inputs, book);
      const ids = new Set(current.map((l) => l.recordId));
      current = s.lines.filter((l) => ids.has(l.recordId));
      previous = s.lines.filter((l) => !ids.has(l.recordId));
      warnings.push(...s.warnings.slice(0, 5));
    }

    // The 80% measure, before filters.
    let direct = zero();
    let pool = zero();
    let unalloc = zero();
    for (const l of current) {
      if (l.costCenter === SHARED_POOL) pool = pool.plus(l.amount);
      else if (l.costCenter === UNALLOCATED) unalloc = unalloc.plus(l.amount);
      else direct = direct.plus(l.amount);
    }
    const whole = direct.plus(pool).plus(unalloc);

    // In a month's view corrections to locked months are their own line; a filter on that line (`…:CORRECTIONS`)
    // shows them grouped like any other spend.
    const separate = w.kind === 'billing';
    const correctionsOnly = filters.some((f) => f.value === CORRECTIONS);
    const realFilters = filters.filter((f) => f.value !== CORRECTIONS);
    const pass = (l: Line) =>
      (!correctionsOnly || l.correction) && realFilters.every((f) => keyOf(l, f.dimension, ccs).key === f.value);
    const keyFor = (l: Line) => (separate && l.correction && !correctionsOnly ? correctionsKey : keyOf(l, q.by, ccs));
    const cur = current.filter(pass);
    const prev = previous.filter(pass);

    type G = {
      key: string;
      label: string;
      sub: string | null;
      est: Money;
      inv: Money;
      prov: Money;
      prev: Money | null;
      days: Map<string, Money>;
    };
    const groups = new Map<string, G>();
    const dayOfLine = (l: Line) => (separate ? l.postDay : l.day);
    for (const l of cur) {
      const k = keyFor(l);
      const g = groups.get(k.key) ?? { ...k, est: zero(), inv: zero(), prov: zero(), prev: null, days: new Map() };
      if (l.basis === 'invoiced') g.inv = g.inv.plus(l.amount);
      else g.est = g.est.plus(l.amount);
      if (l.provisional) g.prov = g.prov.plus(l.amount);
      const d = dayOfLine(l);
      g.days.set(d, (g.days.get(d) ?? zero()).plus(l.amount));
      groups.set(k.key, g);
    }
    for (const l of prev) {
      const g = groups.get(keyFor(l).key);
      if (g) g.prev = (g.prev ?? zero()).plus(l.amount);
    }
    const total = Money.sum(
      [...groups.values()].map((g) => g.est.plus(g.inv)),
      USD,
    );
    const sorted = [...groups.values()].sort(
      (a, b) =>
        Number(a.key === CORRECTIONS) - Number(b.key === CORRECTIONS) ||
        b.est.plus(b.inv).compare(a.est.plus(a.inv)) ||
        a.key.localeCompare(b.key),
    );
    const clicklandUrl = (g: G) =>
      q.by === 'service' && g.key && !g.key.includes('/') && g.key !== 'Cluster idle' && g.key !== CORRECTIONS
        ? `${this.clicklandConsoleUrl}/services/${encodeURIComponent(g.key)}`
        : null;
    const out: SpendGroup[] = sorted.map((g) => ({
      key: g.key,
      label: g.label,
      sub: g.sub,
      estimated: amount(g.est),
      invoiced: amount(g.inv),
      total: amount(g.est.plus(g.inv)),
      previous: g.prev ? amount(g.prev) : null,
      share: pct(g.est.plus(g.inv), total),
      provisional: amount(g.prov),
      clicklandUrl: clicklandUrl(g),
    }));

    const days: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const top = sorted.slice(0, 5);
    const series = top.map((g) => ({
      key: g.key,
      label: g.label,
      values: days.map((d) => amount(g.days.get(d) ?? zero())),
    }));
    if (sorted.length > 5)
      series.push({
        key: 'other',
        label: `${sorted.length - 5} more`,
        values: days.map((d) =>
          amount(
            Money.sum(
              sorted.slice(5).map((g) => g.days.get(d) ?? zero()),
              USD,
            ),
          ),
        ),
      });
    const prevTotal = prev.length
      ? Money.sum(
          prev.map((l) => l.amount),
          USD,
        )
      : null;
    const sum = (f: (l: Line) => boolean) =>
      Money.sum(
        cur.filter(f).map((l) => l.amount),
        USD,
      );
    return {
      from,
      to,
      basis: w.kind,
      by: q.by,
      layer: q.layer,
      filters,
      currency: USD,
      total: {
        estimated: amount(sum((l) => l.basis === 'estimated')),
        invoiced: amount(sum((l) => l.basis === 'invoiced')),
        total: amount(total),
        provisional: amount(sum((l) => l.provisional)),
        previous: prevTotal ? amount(prevTotal) : null,
        corrections: amount(separate ? sum((l) => l.correction) : zero()),
      },
      groups: out,
      daily: { days, series },
      attribution: {
        direct: amount(direct),
        sharedPool: amount(pool),
        unallocated: amount(unalloc),
        total: amount(whole),
        directShare: pct(direct, whole),
      },
      drill: DRILL[q.by] ?? null,
      warnings,
    };
  }

  /**
   * Observed milliseconds per source and day, from the newest successful run of each: the window its source covered
   * (Clickland: first to last sample; Landflow: the part of the day it read). Landflow runs from before the window was
   * recorded count as the day up to when they read it.
   */
  async observed(
    from: string,
    to: string,
  ): Promise<{ hours: Map<string, Map<string, number>>; since: Map<string, string> }> {
    const rows = await this.sql<
      { source: string; day: Date; observed_from: Date | null; observed_to: Date | null; finished_at: Date | null }[]
    >`
      SELECT DISTINCT ON (source, day) source, day, observed_from, observed_to, finished_at FROM ingest_runs
      WHERE outcome = 'succeeded' AND day BETWEEN ${from} AND ${to} AND source IN ('landflow', 'clickland')
      ORDER BY source, day, started_at DESC`;
    const hours = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const d = dayOf(r.day);
      const start = Date.parse(`${d}T00:00:00Z`);
      let ms: number | null = null;
      if (r.observed_from && r.observed_to) ms = r.observed_to.getTime() - r.observed_from.getTime();
      else if (r.source === 'landflow' && r.finished_at) ms = Math.min(start + DAY_MS, r.finished_at.getTime()) - start;
      if (ms === null) continue;
      const m = hours.get(r.source) ?? new Map<string, number>();
      m.set(d, Math.max(0, Math.min(ms, DAY_MS)));
      hours.set(r.source, m);
    }
    // Data since: the first sample a run saw. A Clickland run that saw nothing (before collection started) doesn't
    // count; Landflow's events are final when written, so a run's day counts even when it had no calls.
    const first = await this.sql<{ source: string; since: Date }[]>`
      SELECT source, min(CASE WHEN source = 'landflow' THEN coalesce(observed_from, day::timestamptz) ELSE observed_from END) AS since
      FROM ingest_runs
      WHERE outcome = 'succeeded' AND source IN ('landflow', 'clickland')
      GROUP BY source HAVING min(CASE WHEN source = 'landflow' THEN coalesce(observed_from, day::timestamptz) ELSE observed_from END) IS NOT NULL`;
    return { hours, since: new Map(first.map((r) => [r.source, r.since.toISOString()])) };
  }

  /** The run rate now (the last seven days), as Overview takes it. */
  async runRateNow(): Promise<RunRate> {
    const today = this.today();
    const window = { from: addDays(today, -(RUN_RATE_DAYS - 1)), to: today };
    const recent = (await this.lines(window)).lines;
    const obs = await this.observed(window.from, window.to);
    return runRateOf(recent, obs.hours, obs.since, window);
  }

  /** Every cost center's budget for a month, summed; null when no budget names the month. */
  async budgetTotal(month: string): Promise<Money | null> {
    const budgets = await this.budgets.forMonth(month);
    return budgets.size
      ? Money.sum(
          [...budgets.values()].map((b) => b.amount),
          USD,
        )
      : null;
  }

  async overview(month?: string): Promise<Overview> {
    const today = this.today();
    const nowMs = this.now().getTime();
    const m = month ?? today.slice(0, 7);
    const dim = monthDays(m);
    const from = `${m}-01`;
    const last = `${m}-${String(dim).padStart(2, '0')}`;
    const to = last < today ? last : today;
    const isCurrent = today >= from && today <= last;
    const ccs = await this.costCenters();
    // The month: what is booked in it. The run rate: what was charged in the last seven days.
    const { lines } = await this.lines({ fromMonth: m, toMonth: m });
    const window = { from: addDays(today, -(RUN_RATE_DAYS - 1)), to: today };
    const recent = isCurrent ? (await this.lines(window)).lines : [];
    const sumOf = (ls: readonly Line[]) =>
      Money.sum(
        ls.map((l) => l.amount),
        USD,
      );
    const mtd = sumOf(lines);
    const est = sumOf(lines.filter((l) => l.basis === 'estimated'));
    const inv = sumOf(lines.filter((l) => l.basis === 'invoiced'));
    const prov = sumOf(lines.filter((l) => l.provisional));
    const corr = sumOf(lines.filter((l) => l.correction));

    // Forecast: month to date + each source's cost per observed hour × the hours left in the month.
    const obs = await this.observed(window.from, window.to);
    const rr = isCurrent ? runRateOf(recent, obs.hours, obs.since, window) : null;
    const monthStartMs = Date.parse(`${from}T00:00:00Z`);
    const monthEndMs = Date.parse(`${last}T00:00:00Z`) + DAY_MS;
    const hoursLeft = isCurrent ? hoursOf(monthEndMs - nowMs) : Decimal.ZERO;
    const project = (perHour: Decimal) =>
      mtd.plus(Money.fromDecimal(perHour.times(hoursLeft).round(6, 'halfEven'), USD));
    const ready = rr?.enough ? rr.perHour! : null;
    // The band (spec 006): z₀.₉ × σ × √(days left), σ from how much each source's full days vary.
    const daysLeft = hoursLeft.divide('24', 12, 'halfEven');
    const fullCosts = rr?.enough ? rr.sources.map((s) => s.fullCosts) : [];
    const p = ready ? band(project(ready.mid), halfWidth(fullCosts, daysLeft), mtd) : null;
    // Beyond the run rate (spec 006, one formula with the year ahead): reservations still held and approved monthly
    // requests beyond them, each less what the run rate already projects of it, and what contracts hold, for the rest
    // of this month (from tomorrow).
    const tomorrow = addDays(today, 1);
    const running = isCurrent ? await runningIncrements(this.sql, this, today) : new Map<string, Money>();
    const commits = isCurrent ? await commitmentsIn(this.sql, m, tomorrow, running) : [];
    const committed = Money.sum(
      commits.map((c) => c.amount),
      USD,
    );
    const held = isCurrent ? await reservedIn(this.sql, m, tomorrow, running) : null;
    const reservedNet = held ? Money.sum(held.net.values(), USD) : zero();
    const contracted = isCurrent && this.contractedIn ? await this.contractedIn(m, tomorrow) : zero();
    const beyond = reservedNet.plus(committed).plus(contracted);
    const forecast = isCurrent ? (p ? p.p50.plus(beyond) : null) : mtd;

    const budgets = await this.budgets.forMonth(m);
    const reserved = await this.reservedByCostCenter(m);
    const reservedTotal = Money.sum(reserved.values(), USD);
    const budgetTotal = budgets.size
      ? Money.sum(
          [...budgets.values()].map((b) => b.amount),
          USD,
        )
      : null;
    const imports = await this.budgets.imports([...new Set([...budgets.values()].map((b) => b.version))]);

    // Cost centers: month to date, and a forecast at each one's own cost per observed hour, per source.
    const ccOf = (l: Line) => (l.correction ? CORRECTIONS : l.costCenter);
    const codes = new Set([
      ...lines.map(ccOf),
      ...budgets.keys(),
      ...reserved.keys(),
      ...commits.map((c) => c.costCenter),
    ]);
    const ccRate = (code: string) => {
      if (!rr?.enough) return null;
      let r = Decimal.ZERO;
      for (const s of rr.sources) {
        const c = sumOf(recent.filter((l) => l.source === s.source && l.costCenter === code && !l.correction));
        if (!s.hours.isZero()) r = r.plus(c.toDecimal().divide(s.hours, 12, 'halfEven'));
      }
      return r;
    };
    const ccLines: CostCenterLine[] = [...codes].map((code) => {
      const mine = lines.filter((l) => ccOf(l) === code);
      const actual = sumOf(mine);
      const rate = code === CORRECTIONS ? Decimal.ZERO : ccRate(code);
      const ccCommitted = Money.sum(
        commits.filter((c) => c.costCenter === code).map((c) => c.amount),
        USD,
      );
      const ccReservedNet = held?.net.get(code) ?? zero();
      const f = !isCurrent
        ? actual
        : rate === null
          ? null
          : actual
              .plus(Money.fromDecimal(rate.times(hoursLeft).round(6, 'halfEven'), USD))
              .plus(ccReservedNet)
              .plus(ccCommitted);
      const b = budgets.get(code)?.amount ?? null;
      // Without a run rate, what is spent, reserved and committed can still put it over (review of wave 3).
      const plain = stateOf(actual, f, b);
      const held2 = actual.plus(reserved.get(code) ?? zero()).plus(ccCommitted);
      const state = plain === 'early' && b && held2.compare(b) > 0 ? 'risk' : plain;
      return {
        code,
        name: ccLabel(code, ccs),
        owner: ccs.get(code)?.owner ?? null,
        monthToDate: amount(actual),
        invoiced: amount(sumOf(mine.filter((l) => l.basis === 'invoiced'))),
        budget: b ? amount(b) : null,
        forecast: f ? amount(f) : null,
        reserved: amount(reserved.get(code) ?? zero()),
        committed: amount(ccCommitted),
        state,
      };
    });
    ccLines.sort(
      (a, b) =>
        Number(a.code === CORRECTIONS) - Number(b.code === CORRECTIONS) ||
        Decimal.parse(b.monthToDate).compare(a.monthToDate) ||
        a.code.localeCompare(b.code),
    );

    // Burn: cumulative actual per day (corrections on the day they were booked), then the forecast to month end.
    const byDay = new Map<string, Money>();
    for (const l of lines) byDay.set(l.postDay, (byDay.get(l.postDay) ?? zero()).plus(l.amount));
    const burn: Overview['burn'] = [];
    let cum = zero();
    for (let d = from; d <= last; d = addDays(d, 1)) {
      if (d <= to) {
        cum = cum.plus(byDay.get(d) ?? zero());
        const end = d === to && ready;
        burn.push({
          day: d,
          actual: amount(cum),
          forecast: end ? amount(cum) : null,
          low: end ? amount(cum) : null,
          high: end ? amount(cum) : null,
        });
      } else if (ready) {
        const ahead = hoursOf(Date.parse(`${d}T00:00:00Z`) + DAY_MS - nowMs);
        const mid = mtd.plus(Money.fromDecimal(ready.mid.times(ahead).round(6, 'halfEven'), USD));
        const b = band(mid, halfWidth(fullCosts, ahead.divide('24', 12, 'halfEven')), mtd);
        burn.push({ day: d, actual: null, forecast: amount(b.p50), low: amount(b.p10), high: amount(b.p90) });
      } else burn.push({ day: d, actual: null, forecast: null, low: null, high: null });
    }

    const group = (key: (l: Line) => string, label: (k: string) => string) => {
      const map = new Map<string, { a: Money; i: Money }>();
      for (const l of lines) {
        const k = l.correction ? 'correction' : key(l);
        const g = map.get(k) ?? { a: zero(), i: zero() };
        g.a = g.a.plus(l.amount);
        if (l.basis === 'invoiced') g.i = g.i.plus(l.amount);
        map.set(k, g);
      }
      return [...map.entries()]
        .sort((a, b) => Number(a[0] === 'correction') - Number(b[0] === 'correction') || b[1].a.compare(a[1].a))
        .map(([k, g]) => ({
          key: k,
          label: k === 'correction' ? CORRECTIONS_LABEL : label(k),
          amount: amount(g.a),
          invoiced: amount(g.i),
        }));
    };

    let direct = zero();
    let pool = zero();
    let unalloc = zero();
    for (const l of lines) {
      if (l.costCenter === SHARED_POOL) pool = pool.plus(l.amount);
      else if (l.costCenter === UNALLOCATED) unalloc = unalloc.plus(l.amount);
      else direct = direct.plus(l.amount);
    }

    const runs = await this.sql<
      { source: string; day: Date; finished_at: Date | null; outcome: string; warnings: string[] }[]
    >`
      SELECT DISTINCT ON (source) source, day, finished_at, outcome, warnings FROM ingest_runs
      WHERE source IN ('landflow', 'clickland') ORDER BY source, started_at DESC`;
    const rc = await this.rateCards.latest();
    // How much of the month the figures observe: from the 1st (or the newest source's first data) to now.
    const dataSince = rr?.dataSince ?? [...obs.since.values()].sort().at(-1) ?? null;
    const spanFrom = Math.max(monthStartMs, dataSince ? Date.parse(dataSince) : monthStartMs);
    const spanTo = Math.min(monthEndMs, nowMs);
    const observedShare = Decimal.of(BigInt(Math.max(0, spanTo - spanFrom)) * 1000n)
      .divide(Decimal.of(BigInt(monthEndMs - monthStartMs)), 0, 'halfEven')
      .divide('10', 1, 'halfEven')
      .toString();
    const perDay = (r: Decimal) => amount(Money.fromDecimal(r.times('24').round(6, 'halfEven'), USD));
    return {
      month: m,
      today,
      dayOfMonth: isCurrent ? Number(today.slice(8, 10)) : dim,
      daysInMonth: dim,
      currency: USD,
      monthToDate: {
        total: amount(mtd),
        estimated: amount(est),
        invoiced: amount(inv),
        provisional: amount(prov),
        corrections: amount(corr),
      },
      forecast: {
        status: !isCurrent ? 'past' : ready ? 'ok' : 'insufficient',
        amount: forecast ? amount(forecast) : null,
        low: p ? amount(p.p10.plus(beyond)) : !isCurrent ? amount(mtd) : null,
        high: p ? amount(p.p90.plus(beyond)) : !isCurrent ? amount(mtd) : null,
        p10: p ? amount(p.p10) : null,
        p50: p ? amount(p.p50) : null,
        p90: p ? amount(p.p90) : null,
        band: p
          ? `P10–P90: P50 ± ${Z90} × σ × √${daysLeft.toFixed(1, 'halfEven')} days left; σ² is the sum of each source's variance over its full days (${rr!.sources.map((x) => `${x.source} ${x.fullCosts.length}`).join(', ')})`
          : null,
        committed: amount(committed),
        reserved: amount(reservedNet),
        contracted: amount(contracted),
        commitments: commits.map((c) => ({
          requestId: c.requestId,
          number: c.number,
          title: c.title,
          costCenter: c.costCenter,
          amount: amount(c.amount),
        })),
        drivers: (rr?.sources ?? []).flatMap((x) =>
          x.drivers.map((d) => ({
            source: x.source,
            unit: d.unit,
            perDay: d.perDay.toFixed(6, 'halfEven'),
            costPerDay: x.perHour
              ? amount(Money.fromDecimal(x.perHour.times('24').round(6, 'halfEven'), USD))
              : '0.000000',
          })),
        ),
        basis: rr ? rr.basis : 'A past month: actuals only',
        perDay: ready ? { low: perDay(ready.low), mid: perDay(ready.mid), high: perDay(ready.high) } : null,
        dataSince,
        observedShare,
        sources: (rr?.sources ?? []).map((s) => ({
          source: s.source,
          since: s.since,
          fullDays: s.fullDays,
          observedHours: s.hours.toFixed(1, 'halfEven'),
          perHour: s.perHour ? s.perHour.toFixed(6, 'halfEven') : null,
        })),
      },
      budget: {
        amount: budgetTotal ? amount(budgetTotal) : null,
        versions: imports.map((i) => i.version),
        source: imports[0]?.source ?? null,
        importedAt: imports[0]?.importedAt ?? null,
        origin: imports.some((i) => i.origin === 'dev-seed') ? 'dev-seed' : (imports[0]?.origin ?? null),
      },
      leftAfterReservations: budgetTotal ? amount(budgetTotal.minus(mtd).minus(reservedTotal)) : null,
      reserved: amount(reservedTotal),
      burn,
      costCenters: ccLines,
      byCategory: group(
        (l) => l.serviceCategory,
        (k) => k,
      ),
      byPlClass: group(plClassOf, (k) => PL_LABEL[k] ?? k),
      attribution: {
        direct: amount(direct),
        sharedPool: amount(pool),
        unallocated: amount(unalloc),
        total: amount(mtd),
        directShare: pct(direct, mtd),
      },
      runs: runs.map((r) => ({
        source: r.source,
        day: dayOf(r.day),
        finishedAt: r.finished_at?.toISOString() ?? null,
        outcome: r.outcome,
        warnings: r.warnings,
      })),
      rateCard: rc
        ? {
            version: rc.version,
            status: rc.approved_at ? 'approved' : 'proposed',
            approvedBy: rc.approver ?? rc.approved_by,
          }
        : { version: null, status: 'none', approvedBy: null },
    };
  }

  async budgetsView(month?: string): Promise<BudgetsView> {
    const ov = await this.overview(month);
    const m = ov.month;
    const budgets = await this.budgets.forMonth(m);
    // The months before: budget and actual by what was booked in each (direct layer), three back.
    const months = [3, 2, 1].map((i) => addMonths(m, -i));
    const history = new Map<string, Map<string, Money>>();
    const budgetsBefore = new Map<string, Map<string, Money>>();
    const { lines } = await this.lines({ fromMonth: months[0]!, toMonth: months[2]! }, false);
    for (const l of lines) {
      const cc = l.correction ? CORRECTIONS : l.costCenter;
      const h = history.get(cc) ?? new Map<string, Money>();
      h.set(l.month, (h.get(l.month) ?? zero()).plus(l.amount));
      history.set(cc, h);
    }
    for (const mm of months)
      for (const [cc, b] of await this.budgets.forMonth(mm))
        budgetsBefore.set(cc, (budgetsBefore.get(cc) ?? new Map()).set(mm, b.amount));
    const periods = await this.sql<{ month: Date; status: string }[]>`SELECT month, status FROM periods`;
    const locked = new Set(periods.filter((p) => p.status === 'locked').map((p) => dayOf(p.month).slice(0, 7)));

    const rows: BudgetLine[] = ov.costCenters.map((c) => {
      const b = budgets.get(c.code)?.amount ?? null;
      const actual = Money.parse(c.monthToDate, USD);
      const held = Money.parse(c.reserved, USD);
      const f = c.forecast ? Money.parse(c.forecast, USD) : null;
      const variance = b && f ? f.minus(b) : null;
      return {
        ...c,
        // Budget left: budget − actuals − what approved requests still hold.
        available: b ? amount(b.minus(actual).minus(held)) : null,
        variance: variance ? amount(variance) : null,
        variancePct: b && variance && !b.isZero() ? pct(variance, b) : null,
        months: months.map((mm) => ({
          month: mm,
          budget: budgetsBefore.get(c.code)?.get(mm) ? amount(budgetsBefore.get(c.code)!.get(mm)!) : null,
          actual: amount(history.get(c.code)?.get(mm) ?? zero()),
          locked: locked.has(mm),
        })),
      };
    });
    const total = (k: 'budget' | 'monthToDate') =>
      Money.sum(
        rows.map((r) => (r[k] ? Money.parse(r[k]!, USD) : zero())),
        USD,
      );
    const tb = total('budget');
    const ta = total('monthToDate');
    const tr = Money.sum(
      rows.map((r) => Money.parse(r.reserved, USD)),
      USD,
    );
    const tf = rows.every((r) => r.forecast !== null)
      ? Money.sum(
          rows.map((r) => Money.parse(r.forecast!, USD)),
          USD,
        )
      : null;
    const hasBudget = rows.some((r) => r.budget !== null);
    return {
      month: m,
      currency: USD,
      versions: await this.budgets.imports(ov.budget.versions),
      rows,
      totals: {
        budget: amount(tb),
        actual: amount(ta),
        reserved: amount(tr),
        available: amount(tb.minus(ta).minus(tr)),
        forecast: tf ? amount(tf) : null,
        variance: tf && hasBudget ? amount(tf.minus(tb)) : null,
        variancePct: tf && hasBudget && !tb.isZero() ? pct(tf.minus(tb), tb) : null,
        state: hasBudget ? stateOf(ta, tf, tb) : 'none',
      },
    };
  }
}
