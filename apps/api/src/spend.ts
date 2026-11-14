/**
 * The read side of wave 1 (docs/ui.md, specs 002 and 003): spend grouped by any dimension (Explore), the Overview's
 * month to date, forecast, budget and burn, and Budgets. Exact: every amount is summed in micro-units and written as a
 * six-decimal string. Records are read with their direct allocation (the newest generation of their month); today's
 * provisional rows, and anything entered since the last generation, are allocated as they are read.
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
import { ApiError } from './errors.js';
import type { RateCards } from './ratecards.js';

const DAY_MS = 86_400_000;
const USD = REPORTING_CURRENCY;
const zero = () => Money.zero(USD);
export const amount = (m: Money): Amount => m.toDecimal().toFixed(6, 'halfEven');

/** One row of spend: a cost record (or provisional row) with its allocation. */
export interface Line {
  recordId: string;
  day: string;
  month: string;
  basis: 'estimated' | 'invoiced';
  provisional: boolean;
  source: string;
  amount: Money;
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
  unclassified: 'Not classified',
};

const str = (t: Record<string, unknown>, k: string) => (typeof t[k] === 'string' ? (t[k] as string) : '');

export interface CostCenterInfo {
  code: string;
  name: string;
  owner: string | null;
}

export const ccLabel = (code: string, ccs: Map<string, CostCenterInfo>) =>
  code === SHARED_POOL ? 'Shared pool' : code === UNALLOCATED ? 'Unallocated' : (ccs.get(code)?.name ?? code);

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
      const p = l.plClass ?? 'unclassified';
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

const pct = (part: Money, whole: Money): string =>
  whole.isZero()
    ? '0.0'
    : Decimal.of(part.micros * 1000n)
        .divide(Decimal.of(whole.micros), 0, 'halfEven')
        .divide('10', 1, 'halfEven')
        .toString();

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const monthDays = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

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

export class Spend {
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

  async costCenters(): Promise<Map<string, CostCenterInfo>> {
    const rows = await this.sql<{ code: string; name: string; owner_name: string | null }[]>`
      SELECT DISTINCT ON (code) code, name, owner_name FROM cost_centers ORDER BY code, version DESC`;
    return new Map(rows.map((r) => [r.code, { code: r.code, name: r.name, owner: r.owner_name }]));
  }

  /** Every line charged from `from` to `to` (UTC days, inclusive), with its direct allocation. */
  async lines(
    from: string,
    to: string,
    provisional = true,
  ): Promise<{ lines: Line[]; book: RuleBook; inputs: AllocInput[] }> {
    const s = this.sql;
    const start = `${from}T00:00:00Z`;
    const end = `${addDays(to, 1)}T00:00:00Z`;
    const cols = s.unsafe(
      'r.record_id, r.billing_period_start, r.charge_period_start, r.basis, r.source, r.tags, r.sku_meter, r.actor_id, r.service_name, r.effective_cost_micros, r.billing_currency, r.service_category, r.service_provider_name, r.resource_name',
    );
    const ledger = await s<Row[]>`
      SELECT ${cols}, a.cost_center, a.team, a.product, a.pl_class, a.capitalisable, a.rule_id
      FROM cost_records r
      LEFT JOIN LATERAL (
        SELECT a.* FROM allocations a JOIN allocation_generations g ON g.id = a.generation_id
        WHERE a.month = (r.billing_period_start AT TIME ZONE 'UTC')::date AND a.record_id = r.record_id
        ORDER BY g.number DESC LIMIT 1) a ON TRUE
      WHERE r.charge_period_start >= ${start}::timestamptz AND r.charge_period_start < ${end}::timestamptz`;
    const prov = provisional
      ? await s<Row[]>`
          SELECT ${cols}, NULL AS cost_center, NULL AS team, NULL AS product, NULL AS pl_class, NULL AS capitalisable, NULL AS rule_id
          FROM provisional_usage r
          WHERE r.charge_period_start >= ${start}::timestamptz AND r.charge_period_start < ${end}::timestamptz`
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
      return {
        recordId: r.record_id,
        day: dayOf(r.charge_period_start),
        month: dayOf(r.billing_period_start).slice(0, 7),
        basis: r.basis,
        provisional: provIds.has(r.record_id),
        source: r.source,
        amount: Money.ofMicros(r.effective_cost_micros, r.billing_currency.trim()),
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

  private window(q: { month?: string; from?: string; to?: string }) {
    const today = this.today();
    if (q.from || q.to) {
      const from = q.from ?? q.to!;
      const to = q.to ?? q.from!;
      if (to < from) throw new ApiError('bad_request', '`to` is on or after `from`');
      if (daysBetween(from, to) > 400) throw new ApiError('bad_request', 'At most 400 days at a time');
      return { from, to };
    }
    const month = q.month ?? today.slice(0, 7);
    const from = `${month}-01`;
    const last = `${month}-${String(monthDays(month)).padStart(2, '0')}`;
    return { from, to: last < today ? last : today < from ? from : today };
  }

  async spend(q: SpendQuery): Promise<SpendResult> {
    const { from, to } = this.window(q);
    const filters = parseFilters(q.filter);
    const len = daysBetween(from, to);
    const prevFrom = addDays(from, -len);
    const ccs = await this.costCenters();
    const loaded = await this.lines(prevFrom, to, q.provisional === 'true');
    let all = loaded.lines;
    const warnings: string[] = [];
    if (q.layer === 'spread') {
      const s = this.spreadLines(all, loaded.inputs, loaded.book);
      all = s.lines;
      warnings.push(...s.warnings.slice(0, 5));
    }
    const current = all.filter((l) => l.day >= from);
    const previous = all.filter((l) => l.day < from);

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

    const pass = (l: Line) => filters.every((f) => keyOf(l, f.dimension, ccs).key === f.value);
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
    for (const l of cur) {
      const k = keyOf(l, q.by, ccs);
      const g = groups.get(k.key) ?? { ...k, est: zero(), inv: zero(), prov: zero(), prev: null, days: new Map() };
      if (l.basis === 'invoiced') g.inv = g.inv.plus(l.amount);
      else g.est = g.est.plus(l.amount);
      if (l.provisional) g.prov = g.prov.plus(l.amount);
      g.days.set(l.day, (g.days.get(l.day) ?? zero()).plus(l.amount));
      groups.set(k.key, g);
    }
    for (const l of prev) {
      const k = keyOf(l, q.by, ccs);
      const g = groups.get(k.key);
      if (g) g.prev = (g.prev ?? zero()).plus(l.amount);
    }
    const total = Money.sum(
      [...groups.values()].map((g) => g.est.plus(g.inv)),
      USD,
    );
    const sorted = [...groups.values()].sort(
      (a, b) => b.est.plus(b.inv).compare(a.est.plus(a.inv)) || a.key.localeCompare(b.key),
    );
    const clicklandUrl = (g: G) =>
      q.by === 'service' && g.key && !g.key.includes('/') && g.key !== 'Cluster idle'
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

  /** Observed hours per source and day, from the newest successful run of each (for the run rate). */
  private async observedHours(from: string, to: string): Promise<Map<string, number>> {
    const rows = await this.sql<{ source: string; day: Date; observed_from: Date | null; observed_to: Date | null }[]>`
      SELECT DISTINCT ON (source, day) source, day, observed_from, observed_to FROM ingest_runs
      WHERE outcome = 'succeeded' AND day BETWEEN ${from} AND ${to}
      ORDER BY source, day, started_at DESC`;
    const out = new Map<string, number>();
    for (const r of rows)
      if (r.observed_from && r.observed_to)
        out.set(
          `${r.source}|${dayOf(r.day)}`,
          Math.max(0, (r.observed_to.getTime() - r.observed_from.getTime()) / 3_600_000),
        );
    return out;
  }

  /**
   * The run rate per day: over the last seven days with figures (today included once an hour is observed), each day's
   * cost per observed hour × 24 (Clickland days that began mid-day are not read as whole days; Landflow's AI cost
   * counts as is). Mid is the mean; low and high the lowest and highest day (±15% with a single day).
   */
  private async runRate(lines: Line[], today: string) {
    const from = addDays(today, -7);
    const hours = await this.observedHours(from, today);
    const nowH = (this.now().getTime() - Date.parse(`${today}T00:00:00Z`)) / 3_600_000;
    const perDay = new Map<string, Map<string, Money>>();
    for (const l of lines) {
      if (l.day < from) continue;
      const m = perDay.get(l.day) ?? new Map<string, Money>();
      m.set(l.source, (m.get(l.source) ?? zero()).plus(l.amount));
      perDay.set(l.day, m);
    }
    const rates: Decimal[] = [];
    const days: string[] = [];
    for (const [d, bySource] of [...perDay.entries()].sort()) {
      let rate = Decimal.ZERO;
      let ok = false;
      for (const [source, cost] of bySource) {
        const fullDay = d === today ? nowH : 24;
        const h = source === 'clickland' ? (hours.get(`${source}|${d}`) ?? fullDay) : fullDay;
        if (h < 1) continue;
        ok = true;
        rate = rate.plus(cost.toDecimal().times('24').divide(h.toFixed(6), 6, 'halfEven'));
      }
      if (ok) {
        rates.push(rate);
        days.push(d);
      }
    }
    if (!rates.length)
      return { low: Decimal.ZERO, mid: Decimal.ZERO, high: Decimal.ZERO, days, basis: 'No figures yet: no run rate' };
    const sum = rates.reduce((a, b) => a.plus(b), Decimal.ZERO);
    const mid = sum.divide(String(rates.length), 6, 'halfEven');
    let low = rates.reduce((a, b) => (b.compare(a) < 0 ? b : a));
    let high = rates.reduce((a, b) => (b.compare(a) > 0 ? b : a));
    if (rates.length === 1) {
      low = mid.times('0.85').round(6, 'halfEven');
      high = mid.times('1.15').round(6, 'halfEven');
    }
    return {
      low,
      mid,
      high,
      days,
      basis: `Run rate of the last ${rates.length} day${rates.length === 1 ? '' : 's'} with figures (${days[0]} to ${days.at(-1)}), per observed hour × 24; range is the lowest and highest day${rates.length === 1 ? ' (±15% with one day)' : ''}`,
    };
  }

  async overview(month?: string): Promise<Overview> {
    const today = this.today();
    const m = month ?? today.slice(0, 7);
    const dim = monthDays(m);
    const from = `${m}-01`;
    const last = `${m}-${String(dim).padStart(2, '0')}`;
    const to = last < today ? last : today;
    const isCurrent = today >= from && today <= last;
    const ccs = await this.costCenters();
    const { lines: all } = await this.lines(
      addDays(from, -7) < addDays(today, -7) ? addDays(from, -7) : addDays(today, -7),
      to,
    );
    const lines = all.filter((l) => l.day >= from && l.day <= to);
    const mtd = Money.sum(
      lines.map((l) => l.amount),
      USD,
    );
    const est = Money.sum(
      lines.filter((l) => l.basis === 'estimated').map((l) => l.amount),
      USD,
    );
    const inv = Money.sum(
      lines.filter((l) => l.basis === 'invoiced').map((l) => l.amount),
      USD,
    );
    const prov = Money.sum(
      lines.filter((l) => l.provisional).map((l) => l.amount),
      USD,
    );

    // Forecast: month to date + the run rate × what is left of the month.
    const rr = isCurrent
      ? await this.runRate(all, today)
      : { low: Decimal.ZERO, mid: Decimal.ZERO, high: Decimal.ZERO, days: [], basis: 'A past month: actuals only' };
    const leftDays = isCurrent
      ? Decimal.parse(((Date.parse(`${last}T00:00:00Z`) + DAY_MS - this.now().getTime()) / DAY_MS).toFixed(6))
      : Decimal.ZERO;
    const project = (rate: Decimal) => mtd.plus(Money.fromDecimal(rate.times(leftDays).round(6, 'halfEven'), USD));
    const forecast = project(rr.mid);

    const budgets = await this.budgets.forMonth(m);
    const budgetTotal = budgets.size
      ? Money.sum(
          [...budgets.values()].map((b) => b.amount),
          USD,
        )
      : null;
    const latestImport = await this.budgets.latestImport();

    // Cost centers: month to date, and a forecast from each one's share of the last seven days.
    const recent = all.filter((l) => l.day >= addDays(today, -7));
    const recentTotal = Money.sum(
      recent.map((l) => l.amount),
      USD,
    );
    const codes = new Set([...lines.map((l) => l.costCenter), ...budgets.keys()]);
    const ccLines: CostCenterLine[] = [...codes].map((code) => {
      const mine = lines.filter((l) => l.costCenter === code);
      const actual = Money.sum(
        mine.map((l) => l.amount),
        USD,
      );
      const share = recentTotal.isZero()
        ? Decimal.ZERO
        : Decimal.of(
            Money.sum(
              recent.filter((l) => l.costCenter === code).map((l) => l.amount),
              USD,
            ).micros,
          ).divide(Decimal.of(recentTotal.micros), 12, 'halfEven');
      const f = actual.plus(Money.fromDecimal(rr.mid.times(share).times(leftDays).round(6, 'halfEven'), USD));
      const b = budgets.get(code)?.amount ?? null;
      return {
        code,
        name: ccLabel(code, ccs),
        owner: ccs.get(code)?.owner ?? null,
        monthToDate: amount(actual),
        invoiced: amount(
          Money.sum(
            mine.filter((l) => l.basis === 'invoiced').map((l) => l.amount),
            USD,
          ),
        ),
        budget: b ? amount(b) : null,
        forecast: amount(f),
        reserved: amount(zero()),
        state: stateOf(actual, f, b),
      };
    });
    ccLines.sort((a, b) => Decimal.parse(b.monthToDate).compare(a.monthToDate) || a.code.localeCompare(b.code));

    // Burn: cumulative actual per day, then the forecast line and its range to month end.
    const byDay = new Map<string, Money>();
    for (const l of lines) byDay.set(l.day, (byDay.get(l.day) ?? zero()).plus(l.amount));
    const burn: Overview['burn'] = [];
    let cum = zero();
    for (let d = from, i = 1; d <= last; d = addDays(d, 1), i++) {
      if (d <= to) {
        cum = cum.plus(byDay.get(d) ?? zero());
        burn.push({
          day: d,
          actual: amount(cum),
          forecast: d === to && isCurrent ? amount(cum) : null,
          low: d === to && isCurrent ? amount(cum) : null,
          high: d === to && isCurrent ? amount(cum) : null,
        });
      } else if (isCurrent) {
        const ahead = Decimal.parse(
          ((Date.parse(`${d}T00:00:00Z`) + DAY_MS - this.now().getTime()) / DAY_MS).toFixed(6),
        );
        const at = (r: Decimal) => amount(mtd.plus(Money.fromDecimal(r.times(ahead).round(6, 'halfEven'), USD)));
        burn.push({ day: d, actual: null, forecast: at(rr.mid), low: at(rr.low), high: at(rr.high) });
      }
    }

    const group = (key: (l: Line) => string, label: (k: string) => string) => {
      const map = new Map<string, { a: Money; i: Money }>();
      for (const l of lines) {
        const k = key(l);
        const g = map.get(k) ?? { a: zero(), i: zero() };
        g.a = g.a.plus(l.amount);
        if (l.basis === 'invoiced') g.i = g.i.plus(l.amount);
        map.set(k, g);
      }
      return [...map.entries()]
        .sort((a, b) => b[1].a.compare(a[1].a))
        .map(([k, g]) => ({ key: k, label: label(k), amount: amount(g.a), invoiced: amount(g.i) }));
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
    return {
      month: m,
      today,
      dayOfMonth: isCurrent ? Number(today.slice(8, 10)) : dim,
      daysInMonth: dim,
      currency: USD,
      monthToDate: { total: amount(mtd), estimated: amount(est), invoiced: amount(inv), provisional: amount(prov) },
      forecast: {
        amount: amount(forecast),
        low: amount(project(rr.low)),
        high: amount(project(rr.high)),
        basis: rr.basis,
        perDay: {
          low: amount(Money.fromDecimal(rr.low.round(6, 'halfEven'), USD)),
          mid: amount(Money.fromDecimal(rr.mid.round(6, 'halfEven'), USD)),
          high: amount(Money.fromDecimal(rr.high.round(6, 'halfEven'), USD)),
        },
      },
      budget: {
        amount: budgetTotal ? amount(budgetTotal) : null,
        version: latestImport?.version ?? null,
        source: latestImport?.source ?? null,
        importedAt: latestImport?.importedAt ?? null,
      },
      leftAfterReservations: budgetTotal ? amount(budgetTotal.minus(mtd)) : null,
      reserved: amount(zero()),
      burn,
      costCenters: ccLines,
      byCategory: group(
        (l) => l.serviceCategory,
        (k) => k,
      ),
      byPlClass: group(
        (l) => l.plClass ?? 'unclassified',
        (k) => PL_LABEL[k] ?? k,
      ),
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
    // The months before: budget and actual (direct layer), three back.
    const months: string[] = [];
    for (let i = 3; i >= 1; i--) {
      const [y, mm] = m.split('-').map(Number) as [number, number];
      const d = new Date(Date.UTC(y, mm - 1 - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }
    const history = new Map<string, Map<string, Money>>();
    const budgetsBefore = new Map<string, Map<string, Money>>();
    const { lines } = await this.lines(`${months[0]}-01`, addDays(`${m}-01`, -1), false);
    for (const l of lines) {
      const mm = l.day.slice(0, 7);
      const h = history.get(l.costCenter) ?? new Map<string, Money>();
      h.set(mm, (h.get(mm) ?? zero()).plus(l.amount));
      history.set(l.costCenter, h);
    }
    for (const mm of months)
      for (const [cc, b] of await this.budgets.forMonth(mm))
        budgetsBefore.set(cc, (budgetsBefore.get(cc) ?? new Map()).set(mm, b.amount));
    const periods = await this.sql<{ month: Date; status: string }[]>`SELECT month, status FROM periods`;
    const locked = new Set(periods.filter((p) => p.status === 'locked').map((p) => dayOf(p.month).slice(0, 7)));

    const rows: BudgetLine[] = ov.costCenters.map((c) => {
      const b = budgets.get(c.code)?.amount ?? null;
      const actual = Money.parse(c.monthToDate, USD);
      const f = Money.parse(c.forecast, USD);
      const variance = b ? f.minus(b) : null;
      return {
        ...c,
        available: b ? amount(b.minus(actual)) : null,
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
    const sumOf = (k: 'budget' | 'monthToDate' | 'forecast') =>
      Money.sum(
        rows.map((r) => (r[k] ? Money.parse(r[k]!, USD) : zero())),
        USD,
      );
    const tb = sumOf('budget');
    const ta = sumOf('monthToDate');
    const tf = sumOf('forecast');
    const hasBudget = rows.some((r) => r.budget !== null);
    return {
      month: m,
      currency: USD,
      version: await this.budgets.latestImport(),
      rows,
      totals: {
        budget: amount(tb),
        actual: amount(ta),
        reserved: amount(zero()),
        available: amount(tb.minus(ta)),
        forecast: amount(tf),
        variance: amount(tf.minus(tb)),
        variancePct: hasBudget && !tb.isZero() ? pct(tf.minus(tb), tb) : null,
        state: hasBudget ? stateOf(ta, tf, tb) : 'none',
      },
    };
  }
}

export function stateOf(actual: Money, forecast: Money, budget: Money | null): BudgetState {
  if (!budget) return 'none';
  if (actual.compare(budget) > 0) return 'over';
  if (forecast.compare(budget) > 0) return 'risk';
  return 'ok';
}
