/**
 * @landledger/pricing (spec 002): the rate card in effect on a day, AI calls priced per call, and a cluster's capacity
 * split into allocated rows and idle. Exact: prices and quantities are `Decimal`s, amounts `Money` rounded half-even
 * to the micro-unit once per product (docs/money.md).
 */
import { Decimal, Money, Quantity, Rate } from '@landledger/money';

/** One price line of an approved rate card version (`rate_lines`). */
export interface PriceLine {
  id: string;
  skuId: string;
  skuPriceId: string;
  skuMeter: string;
  label: string;
  provider: string | null;
  model: string | null;
  /** FOCUS Unit Format: `Core-Hours`, `GiB-Hours`, `GB-Months`, `GB`, `1000000 Tokens`. */
  pricingUnit: string;
  unitPrice: Decimal;
  currency: string;
  details: Record<string, unknown> | null;
}

export interface PricedVersion {
  id: string;
  version: number;
  effectiveFrom: string;
  /** Exclusive; null while it is the current version. */
  effectiveTo: string | null;
  hoursPerMonth: Decimal;
  lines: PriceLine[];
}

/** Approved rate card versions, looked up by UTC day. */
export class RateBook {
  constructor(readonly versions: readonly PricedVersion[]) {}

  /** The approved version effective on `day` (`YYYY-MM-DD`), or null when none is. */
  versionOn(day: string): PricedVersion | null {
    return this.versions.find((v) => v.effectiveFrom <= day && (v.effectiveTo === null || day < v.effectiveTo)) ?? null;
  }
}

export const rateOf = (line: PriceLine): Rate => Rate.of(line.unitPrice, line.currency, line.pricingUnit);

// Cluster ------------------------------------------------------------------------------------------------------------

export type ClusterResource = 'cpu' | 'memory' | 'storage' | 'egress';

/** The SKUs of the cluster lines (rate card v1, docs/plan.md decision 3). */
export const CLUSTER_SKUS: Record<ClusterResource, string> = {
  cpu: 'landledger:k8s:cpu',
  memory: 'landledger:k8s:memory',
  storage: 'landledger:k8s:storage',
  egress: 'landledger:network:egress',
};

export function clusterLine(version: PricedVersion, resource: ClusterResource): PriceLine | null {
  return version.lines.find((l) => l.skuId === CLUSTER_SKUS[resource]) ?? null;
}

export interface ClusterRowInput {
  key: string;
  /** Allocated quantity in the line's unit (Σ per-sample max(request, usage) for Kubernetes; used for Docker). */
  allocated: Decimal;
}

export interface PricedClusterRow {
  key: string;
  quantity: Decimal;
  cost: Money;
}

export interface PricedCluster {
  rows: PricedClusterRow[];
  /** Capacity − Σ allocated, at the remainder of capacity × rate − Σ row costs; null without capacity (Docker). */
  idle: { quantity: Decimal; cost: Money } | null;
  /** capacity × rate, rounded once; the rows and idle add up to it exactly. Null without capacity. */
  capacityCost: Money | null;
  warnings: string[];
}

/**
 * Prices one resource of one cluster for a day (OpenCost's model, docs/research.md D1): each workload container's
 * allocated quantity × rate, and an idle row for capacity − Σ allocated. The idle cost is capacity × rate − Σ row
 * costs, so the rows and idle add up exactly to capacity × rate. Negative idle (more allocated than allocatable) is
 * kept as it is, with a warning (OpenCost clamps it; Landledger doesn't hide it). Without capacity there is no idle.
 */
export function priceCluster(input: {
  resource: ClusterResource;
  line: PriceLine;
  capacity: Decimal | null;
  rows: readonly ClusterRowInput[];
  label?: string;
}): PricedCluster {
  const rate = rateOf(input.line);
  const rows = input.rows.map((r) => ({
    key: r.key,
    quantity: r.allocated,
    cost: Money.fromProduct(rate, Quantity.of(r.allocated, input.line.pricingUnit)),
  }));
  const warnings: string[] = [];
  if (input.capacity === null) return { rows, idle: null, capacityCost: null, warnings };
  const capacityCost = Money.fromProduct(rate, Quantity.of(input.capacity, input.line.pricingUnit));
  const allocated = rows.reduce((s, r) => s.plus(r.quantity), Decimal.ZERO);
  const idleQuantity = input.capacity.minus(allocated);
  const idleCost = capacityCost.minus(
    Money.sum(
      rows.map((r) => r.cost),
      rate.currency,
    ),
  );
  if (idleQuantity.isNegative())
    warnings.push(
      `${input.label ?? input.resource}: allocated ${allocated.toString()} is more than the capacity ${input.capacity.toString()} ${input.line.pricingUnit}; idle is negative and kept as it is`,
    );
  return { rows, idle: { quantity: idleQuantity, cost: idleCost }, capacityCost, warnings };
}

/** GiB-hours of a claim's capacity as GB-months (FOCUS `GB-Months`): × 1.073741824 GB per GiB ÷ hours per month. */
export function gibHoursToGbMonths(gibHours: Decimal, hoursPerMonth: Decimal): Decimal {
  return gibHours.times('1.073741824').divide(hoursPerMonth, 12, 'halfEven');
}

// AI -----------------------------------------------------------------------------------------------------------------

export type AiMeter = 'input' | 'output' | 'cacheRead' | 'cacheWrite';
export const AI_METERS: readonly AiMeter[] = ['input', 'cacheRead', 'cacheWrite', 'output'];
export const AI_METER_NAME: Record<AiMeter, string> = {
  input: 'Input Tokens',
  output: 'Output Tokens',
  cacheRead: 'Cache Read Tokens',
  cacheWrite: 'Cache Write Tokens',
};

/** The lines that price one model: the base tier and, for some models, a long-context tier for prompts over `above`. */
export interface AiPrice {
  provider: string;
  /** The rate card's model id (a prefix of the call's model when matched by prefix); `*` for a provider-wide line. */
  model: string;
  skuId: string;
  base: Partial<Record<AiMeter, PriceLine>>;
  long: { above: bigint; lines: Partial<Record<AiMeter, PriceLine>> } | null;
}

/** Providers that run on this machine's own hardware: priced only by their own lines (Landflow's rule). */
export const LOCAL_PROVIDERS = new Set(['ollama']);

const normal = (model: string) =>
  model
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9_.-]+\//, '');

const meterOf = (l: PriceLine): AiMeter | null => {
  const m = l.details?.['Meter'];
  return m === 'input' || m === 'output' || m === 'cacheRead' || m === 'cacheWrite' ? m : null;
};
const isLong = (l: PriceLine) => l.details?.['Tier'] === 'long-context';

function priceFor(lines: PriceLine[], provider: string, model: string): AiPrice {
  const base: Partial<Record<AiMeter, PriceLine>> = {};
  const longLines: Partial<Record<AiMeter, PriceLine>> = {};
  let above: bigint | null = null;
  for (const l of lines) {
    const meter = meterOf(l);
    if (!meter) continue;
    if (isLong(l)) {
      longLines[meter] = l;
      const a = l.details?.['Above'];
      if (typeof a === 'string' && /^\d+$/.test(a)) above = BigInt(a);
    } else base[meter] = l;
  }
  return {
    provider,
    model,
    skuId: lines[0]!.skuId,
    base,
    long: above !== null && longLines.input ? { above, lines: longLines } : null,
  };
}

/**
 * The lines for a call's provider and model, Landflow's lookup (`ai-usage/prices.ts`): the exact model id, then the
 * longest model id that is a prefix of it (dated snapshots), within the provider, then across providers (a proxy
 * serving another vendor's model); `vendor/` prefixes are ignored. A local provider (Ollama) is priced only by its own
 * lines, and a line with no model prices every model of its provider. Null when nothing matches.
 */
export function findAiPrice(version: PricedVersion, provider: string, model: string): AiPrice | null {
  const id = normal(model);
  const system = provider.trim().toLowerCase();
  const ai = version.lines.filter((l) => l.provider !== null && meterOf(l) !== null);
  const groups = new Map<string, PriceLine[]>();
  for (const l of ai) {
    const key = `${l.provider!.toLowerCase()}\u0000${l.model === null ? '*' : normal(l.model)}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const entries = [...groups.entries()].map(([k, lines]) => {
    const [p, m] = k.split('\u0000') as [string, string];
    return { provider: p, model: m, lines };
  });
  for (const sameProvider of [true, false]) {
    if (!sameProvider && LOCAL_PROVIDERS.has(system)) break;
    const candidates = entries.filter((e) => (sameProvider ? e.provider === system : true) && e.model !== '*');
    const exact = candidates.find((e) => e.model === id);
    if (exact) return priceFor(exact.lines, exact.provider, exact.model);
    const prefix = candidates.filter((e) => id.startsWith(e.model)).sort((a, b) => b.model.length - a.model.length)[0];
    if (prefix) return priceFor(prefix.lines, prefix.provider, prefix.model);
    if (sameProvider) {
      const any = entries.find((e) => e.provider === system && e.model === '*');
      if (any) return priceFor(any.lines, any.provider, '*');
    }
  }
  return null;
}

/** One AI call's tokens. `cacheRead` and `cacheWrite` are parts of `input`, or null when the event doesn't say. */
export interface AiCall {
  input: bigint;
  output: bigint;
  cacheRead: bigint | null;
  cacheWrite: bigint | null;
}

export interface AiPart {
  meter: AiMeter;
  line: PriceLine;
  tokens: bigint;
}

/**
 * The priced parts of one call (Landflow's `estimateCost`, exact): a prompt over the long-context threshold is priced
 * at that tier, all of it; cache reads and writes (when the event carries them) at the cache prices, or the input
 * price when the model has none; the rest of the input at the input price; output at the output price. When the event
 * doesn't carry cache tokens, the whole input is priced at the input price and the day's per-model adjustment
 * (spec 002, D11) corrects it. Parts with zero tokens are left out.
 */
export function priceAiCall(price: AiPrice, call: AiCall): AiPart[] {
  const tier = price.long && call.input > price.long.above ? price.long.lines : price.base;
  const input = tier.input;
  if (!input) throw new RangeError(`${price.skuId} has no input price line`);
  const parts: AiPart[] = [];
  const add = (meter: AiMeter, line: PriceLine, tokens: bigint) => {
    if (tokens > 0n) parts.push({ meter: line === input ? 'input' : meter, line, tokens });
  };
  if (call.cacheRead === null || call.cacheWrite === null) add('input', input, call.input);
  else {
    const cached = min(call.input, call.cacheRead + call.cacheWrite);
    const read = min(call.cacheRead, cached);
    const write = cached - read;
    add('input', input, call.input - cached);
    add('cacheRead', tier.cacheRead ?? input, read);
    add('cacheWrite', tier.cacheWrite ?? input, write);
  }
  const output = tier.output;
  if (call.output > 0n) {
    if (!output) throw new RangeError(`${price.skuId} has no output price line`);
    add('output', output, call.output);
  }
  return parts;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** tokens × the line's price per `1000000 Tokens`, rounded half-even to the micro-unit once. */
export function tokensCost(line: PriceLine, tokens: Decimal): Money {
  return Money.fromProduct(rateOf(line), Quantity.of(tokens, 'Tokens'));
}

/** Tokens as the line's pricing quantity (2,400,000 Tokens at a price per `1000000 Tokens` is 2.4). */
export function pricingQuantity(line: PriceLine, tokens: Decimal): Decimal {
  return Quantity.of(tokens, 'Tokens').in(line.pricingUnit).value;
}

/**
 * The cache adjustment for a model and day whose events didn't carry cache tokens (spec 002, D11): those tokens were
 * priced at the input price; this moves them to the cache prices. One part per cache meter, as a unit price (the
 * difference, never negative in the table) and a signed token quantity: reads are cheaper than input, so their
 * quantity is negative; writes usually cost more, so theirs is positive.
 */
export function cacheAdjustment(
  price: AiPrice,
  tokens: { cacheRead: bigint; cacheWrite: bigint },
): { meter: 'cacheRead' | 'cacheWrite'; line: PriceLine; unitPrice: Decimal; tokens: bigint }[] {
  const input = price.base.input;
  if (!input) return [];
  const out: { meter: 'cacheRead' | 'cacheWrite'; line: PriceLine; unitPrice: Decimal; tokens: bigint }[] = [];
  for (const meter of ['cacheRead', 'cacheWrite'] as const) {
    const n = tokens[meter];
    const line = price.base[meter];
    if (n <= 0n || !line) continue;
    const diff = line.unitPrice.minus(input.unitPrice);
    if (diff.isZero()) continue;
    out.push({ meter, line, unitPrice: diff.abs(), tokens: diff.isNegative() ? -n : n });
  }
  return out;
}
