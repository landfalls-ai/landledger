/**
 * @landledger/allocation (spec 003): whose each cost is. Ordered rules map a record to a cost center, team, product,
 * P&L class and the capitalisable flag (the first match wins), or to the shared pool; a record no rule matches is
 * unallocated. Cluster idle goes to the shared pool unless a rule names idle. The `direct` layer puts every record in
 * exactly one place; the `spread` layer redistributes the shared pool by share rules (weighted per resource, even, or
 * fixed percentages), with coefficients over the whole day before any filter. Every split is `split` (largest
 * remainder), so each layer adds up exactly to the records. Pure: no database, no clock.
 */
import { Decimal, Money, split, splitEvenly } from '@landledger/money';

export const SHARED_POOL = 'SHARED-POOL';
export const UNALLOCATED = 'UNALLOCATED';
export const PL_CLASSES = ['cost_of_revenue', 'rnd', 'sm', 'ga'] as const;
export type PlClass = (typeof PL_CLASSES)[number];

/** What a rule can select on. Resource: what the record measures. */
export type Resource = 'cpu' | 'memory' | 'storage' | 'network' | 'ai';

/** A record's attributes for matching, read from its FOCUS columns and tags. Empty strings are "not set". */
export interface Attrs {
  source: string;
  resource: Resource;
  idle: boolean;
  cluster: string;
  service: string;
  provider: string;
  model: string;
  namespace: string;
  workload: string;
  container: string;
  composeProject: string;
  composeService: string;
  workflow: string;
  workflowName: string;
  agent: string;
  agentName: string;
  actor: string;
  meter: string;
  labels: Record<string, string>;
}

/** Every field optional; all given must match. Values are case-insensitive and take `*` as a wildcard. */
export interface Selector {
  source?: string;
  resource?: Resource;
  idle?: boolean;
  cluster?: string;
  service?: string;
  provider?: string;
  model?: string;
  namespace?: string;
  workload?: string;
  container?: string;
  composeProject?: string;
  composeService?: string;
  /** A Landflow workflow, by id or name. */
  workflow?: string;
  /** A Landflow agent, by id or name. */
  agent?: string;
  actor?: string;
  meter?: string;
  label?: { key: string; value: string };
}

export interface Target {
  costCenter: string;
  team?: string | null;
  product?: string | null;
  plClass: PlClass;
  capitalisable: boolean;
}

export interface Rule {
  id: string;
  /** For people: what the rule is for. */
  name: string;
  selector: Selector;
  /** Where matches go; absent when `shared` sends them to the shared pool. */
  target?: Target;
  shared?: boolean;
  /** The shared pool's P&L class for these rows. */
  plClass?: PlClass;
}

export interface ShareRule {
  id: string;
  method: 'weighted' | 'even' | 'fixed';
  /** `even` and `fixed`: the cost centers that receive. `weighted`: every cost center with direct cost receives. */
  recipients?: string[];
  /** `fixed`: percentages per cost center, summing to 100. */
  percentages?: { costCenter: string; percent: string }[];
}

export interface RuleSetVersion {
  id: string;
  rules: Rule[];
  shares: ShareRule[];
}

export interface AllocInput {
  recordId: string;
  /** UTC charge day, `YYYY-MM-DD`. */
  day: string;
  amount: Money;
  attrs: Attrs;
}

export interface DirectRow {
  recordId: string;
  day: string;
  amount: Money;
  costCenter: string;
  team: string | null;
  product: string | null;
  plClass: PlClass | null;
  capitalisable: boolean;
  ruleId: string | null;
  ruleSetVersionId: string | null;
}

const glob = (pattern: string, value: string): boolean => {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (p === '*') return v !== '';
  if (!p.includes('*')) return p === v;
  const re = new RegExp(`^${p.split('*').map(escape).join('.*')}$`);
  return re.test(v);
};
const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

const STRING_FIELDS = [
  'source',
  'cluster',
  'service',
  'provider',
  'model',
  'namespace',
  'workload',
  'container',
  'composeProject',
  'composeService',
  'actor',
  'meter',
] as const;

/** True when every field the selector gives matches the record. An empty selector matches nothing. */
export function matches(selector: Selector, a: Attrs): boolean {
  let any = false;
  for (const f of STRING_FIELDS) {
    const p = selector[f];
    if (p === undefined) continue;
    any = true;
    if (!glob(p, a[f])) return false;
  }
  if (selector.resource !== undefined) {
    any = true;
    if (selector.resource !== a.resource) return false;
  }
  if (selector.idle !== undefined) {
    any = true;
    if (selector.idle !== a.idle) return false;
  }
  if (selector.workflow !== undefined) {
    any = true;
    if (!glob(selector.workflow, a.workflow) && !glob(selector.workflow, a.workflowName)) return false;
  }
  if (selector.agent !== undefined) {
    any = true;
    if (!glob(selector.agent, a.agent) && !glob(selector.agent, a.agentName)) return false;
  }
  if (selector.label !== undefined) {
    any = true;
    const v = a.labels[selector.label.key];
    if (v === undefined || !glob(selector.label.value, v)) return false;
  }
  return any;
}

/**
 * The first rule that matches, else null. Idle rows are only matched by rules that select `idle: true`; every other
 * rule skips them, so idle stays in the shared pool unless finance says otherwise.
 */
export function firstMatch(rules: readonly Rule[], a: Attrs): Rule | null {
  for (const rule of rules) {
    if (a.idle && rule.selector.idle !== true) continue;
    if (matches(rule.selector, a)) return rule;
  }
  return null;
}

/** The direct layer: each record once, whole, to its target, the shared pool or unallocated. */
export function allocateDirect(
  records: readonly AllocInput[],
  versionFor: (day: string) => RuleSetVersion | null,
): DirectRow[] {
  return records.map((r) => {
    const version = versionFor(r.day);
    const rule = version ? firstMatch(version.rules, r.attrs) : null;
    const base = { recordId: r.recordId, day: r.day, amount: r.amount, ruleSetVersionId: version?.id ?? null };
    if (rule?.target)
      return {
        ...base,
        costCenter: rule.target.costCenter,
        team: rule.target.team ?? null,
        product: rule.target.product ?? null,
        plClass: rule.target.plClass,
        capitalisable: rule.target.capitalisable,
        ruleId: rule.id,
      };
    if (rule?.shared || (!rule && r.attrs.idle))
      return {
        ...base,
        costCenter: SHARED_POOL,
        team: null,
        product: null,
        plClass: rule?.plClass ?? null,
        capitalisable: false,
        ruleId: rule?.id ?? 'idle',
      };
    return {
      ...base,
      costCenter: UNALLOCATED,
      team: null,
      product: null,
      plClass: null,
      capitalisable: false,
      ruleId: null,
    };
  });
}

export interface SpreadRow extends DirectRow {
  /** Set on the parts of a shared-pool row: the share rule and the coefficient used. */
  spread: { shareRuleId: string; weight: string } | null;
}

export interface SpreadResult {
  rows: SpreadRow[];
  warnings: string[];
}

/** What spreading groups by: the resource of a cluster row on its day and cluster; AI rows by day. */
const poolKey = (r: AllocInput) =>
  r.attrs.resource === 'ai' ? `${r.day}|ai` : `${r.day}|${r.attrs.cluster}|${r.attrs.resource}`;

/**
 * The spread layer: rows outside the shared pool stay as they are; each shared-pool row is split among cost centers
 * by the first share rule. `weighted` (OpenCost's idle rule): by each cost center's direct cost of the same resource on
 * the same day and cluster (AI rows: by direct AI cost that day), computed over all of the day's records before any
 * filter; `even`: equal parts to the listed cost centers; `fixed`: the agreed percentages. The shared pool and
 * unallocated never receive. A row with no recipient stays in the shared pool, with a warning.
 */
export function spread(
  records: readonly AllocInput[],
  direct: readonly DirectRow[],
  sharesFor: (day: string) => readonly ShareRule[],
): SpreadResult {
  const byId = new Map(records.map((r) => [r.recordId, r]));
  const warnings: string[] = [];
  // Coefficients for `weighted`: direct cost per pool key and cost center, over every record of the day.
  const weights = new Map<string, Map<string, bigint>>();
  for (const d of direct) {
    if (d.costCenter === SHARED_POOL || d.costCenter === UNALLOCATED) continue;
    const key = poolKey(byId.get(d.recordId)!);
    const m = weights.get(key) ?? new Map<string, bigint>();
    m.set(d.costCenter, (m.get(d.costCenter) ?? 0n) + d.amount.micros);
    weights.set(key, m);
  }
  const out: SpreadRow[] = [];
  const warned = new Set<string>();
  for (const d of direct) {
    if (d.costCenter !== SHARED_POOL) {
      out.push({ ...d, spread: null });
      continue;
    }
    const rule = sharesFor(d.day)[0];
    const parts = rule ? sharesOf(rule, weights.get(poolKey(byId.get(d.recordId)!))) : null;
    if (!rule || !parts || parts.length === 0) {
      const key = `${d.day}|${rule?.id ?? 'none'}`;
      if (!warned.has(key)) {
        warned.add(key);
        warnings.push(
          rule
            ? `${d.day}: shared pool rows with no recipient under share rule ${rule.id} stay in the shared pool`
            : `${d.day}: no share rule; the shared pool stays on its own`,
        );
      }
      out.push({ ...d, spread: null });
      continue;
    }
    const amounts = split(
      d.amount,
      parts.map((p) => p.weight),
    );
    parts.forEach((p, i) => {
      if (amounts[i]!.isZero() && !d.amount.isZero()) return;
      out.push({
        ...d,
        amount: amounts[i]!,
        costCenter: p.costCenter,
        spread: { shareRuleId: rule.id, weight: p.weight.toString() },
      });
    });
  }
  return { rows: out, warnings };
}

function sharesOf(
  rule: ShareRule,
  direct: Map<string, bigint> | undefined,
): { costCenter: string; weight: Decimal }[] | null {
  const ok = (cc: string) => cc !== SHARED_POOL && cc !== UNALLOCATED;
  if (rule.method === 'weighted') {
    const entries = [...(direct ?? new Map()).entries()]
      .filter(([cc, w]) => ok(cc) && w > 0n && (!rule.recipients || rule.recipients.includes(cc)))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.length ? entries.map(([costCenter, w]) => ({ costCenter, weight: Decimal.of(w) })) : null;
  }
  if (rule.method === 'even') {
    const list = (rule.recipients ?? []).filter(ok);
    return list.length ? list.map((costCenter) => ({ costCenter, weight: Decimal.ONE })) : null;
  }
  const list = (rule.percentages ?? []).filter((p) => ok(p.costCenter));
  return list.length ? list.map((p) => ({ costCenter: p.costCenter, weight: Decimal.parse(p.percent) })) : null;
}

/** Checks a rule set before it is proposed: unique ids, targets or shared, percentages summing to 100. */
export function validateRuleSet(v: { rules: Rule[]; shares: ShareRule[] }, costCenters: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const r of v.rules) {
    if (ids.has(r.id)) problems.push(`rule ${r.id} appears twice`);
    ids.add(r.id);
    if (!r.target && !r.shared) problems.push(`rule ${r.id} has neither a target nor shared`);
    if (r.target && !costCenters.has(r.target.costCenter))
      problems.push(`rule ${r.id} names cost center ${r.target.costCenter}, which doesn't exist`);
    if (Object.keys(r.selector).length === 0) problems.push(`rule ${r.id} selects nothing`);
  }
  for (const s of v.shares) {
    if (s.method === 'fixed') {
      const total = (s.percentages ?? []).reduce((t, p) => t.plus(p.percent), Decimal.ZERO);
      if (!total.equals('100')) problems.push(`share rule ${s.id}: percentages add up to ${total.toString()}, not 100`);
    }
    if (s.method === 'even' && !(s.recipients ?? []).length) problems.push(`share rule ${s.id} lists no recipient`);
    for (const cc of [...(s.recipients ?? []), ...(s.percentages ?? []).map((p) => p.costCenter)])
      if (!costCenters.has(cc)) problems.push(`share rule ${s.id} names cost center ${cc}, which doesn't exist`);
  }
  return problems;
}

/** Sums amounts in micro-units by a key (exact). */
export function totalBy<T>(rows: readonly T[], key: (r: T) => string, amount: (r: T) => Money): Map<string, Money> {
  const out = new Map<string, Money>();
  for (const r of rows) {
    const k = key(r);
    const a = amount(r);
    out.set(k, (out.get(k) ?? Money.zero(a.currency)).plus(a));
  }
  return out;
}

export { splitEvenly };
