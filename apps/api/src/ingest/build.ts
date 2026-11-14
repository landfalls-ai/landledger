/**
 * From the sources' figures to cost records (spec 002), as pure functions: what a day *should* hold. The runner
 * (`runner.ts`) compares that with what the ledger holds and appends entries, reversals and re-entries.
 */
import type { ClicklandRollup, LandflowAiEvent, LandflowAiInsights } from '@landledger/contracts';
import { billingPeriod, type CostRecord, dayPeriod, type JsonObject } from '@landledger/focus';
import { Decimal, Money, Quantity, Rate } from '@landledger/money';
import {
  AI_METER_NAME,
  type AiMeter,
  type AiPrice,
  cacheAdjustment,
  clusterLine,
  findAiPrice,
  gibHoursToGbMonths,
  type PriceLine,
  type PricedVersion,
  priceAiCall,
  priceCluster,
  pricingQuantity,
  rateOf,
  tokensCost,
} from '@landledger/pricing';
import type { LandflowNames } from './sources.js';

export const CURRENCY = 'USD';
const usd0 = () => Money.zero(CURRENCY);

/** Every column a record needs, with an estimated record's defaults; the builders fill the rest. */
function record(day: string, over: Partial<CostRecord> & Pick<CostRecord, 'x_Source' | 'x_SourceKey'>): CostRecord {
  const cost = over.EffectiveCost ?? usd0();
  return {
    BilledCost: usd0(),
    EffectiveCost: cost,
    ListUnitPrice: null,
    ContractedUnitPrice: null,
    PricingQuantity: null,
    PricingUnit: null,
    ConsumedQuantity: null,
    ConsumedUnit: null,
    BillingCurrency: CURRENCY,
    ...dayPeriod(day),
    ...billingPeriod(day.slice(0, 7)),
    ChargeCategory: 'Usage',
    ChargeClass: null,
    ChargeDescription: null,
    ChargeFrequency: 'Usage-Based',
    PricingCategory: 'Standard',
    ServiceCategory: 'Compute',
    ServiceSubcategory: 'Containers',
    ServiceName: '',
    ServiceProviderName: '',
    HostProviderName: null,
    InvoiceIssuerName: '',
    BillingAccountId: '',
    BillingAccountName: null,
    SubAccountId: null,
    SubAccountName: null,
    SubAccountType: null,
    InvoiceId: null,
    ResourceId: null,
    ResourceName: null,
    ResourceType: null,
    SkuId: null,
    SkuMeter: null,
    SkuPriceId: null,
    SkuPriceDetails: null,
    Tags: null,
    AllocatedMethodId: null,
    AllocatedMethodDetails: null,
    AllocatedResourceId: null,
    AllocatedResourceName: null,
    AllocatedTags: null,
    x_RecordId: '',
    x_Basis: 'estimated',
    x_RateCardVersion: null,
    x_IngestRunId: '',
    x_CorrectionOfId: null,
    x_SourceCost: null,
    x_WorkflowId: null,
    x_AgentId: null,
    x_ActorId: null,
    x_OriginalCost: null,
    x_OriginalCurrency: null,
    x_FxRateId: null,
    ...over,
    ListCost: over.ListCost ?? cost,
    ContractedCost: over.ContractedCost ?? cost,
  };
}

/** A priced row: list and contracted price the same (the rate card is the internal list price). */
function priced(
  line: PriceLine,
  quantity: Decimal,
  cost: Money = Money.fromProduct(rateOf(line), Quantity.of(quantity, line.pricingUnit)),
) {
  return {
    EffectiveCost: cost,
    ListCost: cost,
    ContractedCost: cost,
    ListUnitPrice: line.unitPrice,
    ContractedUnitPrice: line.unitPrice,
    PricingQuantity: quantity,
    PricingUnit: line.pricingUnit,
    SkuPriceId: line.skuPriceId,
    SkuMeter: line.skuMeter,
    SkuId: line.skuId,
  };
}

// Landflow AI -------------------------------------------------------------------------------------------------------

const PROVIDER_NAME: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  google: 'Google',
};
export const providerName = (p: string) =>
  PROVIDER_NAME[p.toLowerCase()] ?? (p ? p[0]!.toUpperCase() + p.slice(1) : 'Unknown');
const isLocal = (p: string) => p.toLowerCase() === 'ollama';

export interface LandflowDayInput {
  day: string;
  events: readonly LandflowAiEvent[];
  version: PricedVersion | null;
  names: LandflowNames;
  /** The day's per-model insights (for the cache adjustment), or null when not read. */
  insights: LandflowAiInsights | null;
  /** Where Landflow runs: the costed service and namespace on AI rows. */
  host: { service: string; namespace: string };
}

export interface BuiltDay {
  records: CostRecord[];
  warnings: string[];
  read: number;
}

type AiGroup = {
  provider: string;
  model: string;
  workflow: string | null;
  agent: string | null;
  actor: string | null;
  meter: string;
  line: PriceLine | null;
  tokens: bigint;
  /** Landflow's estimate of the calls (for x_SourceCost), on one row per call group. */
  sourceCost: Decimal;
  calls: number;
};

const inDay = (at: string, day: string) => at.slice(0, 10) === day || new Date(at).toISOString().slice(0, 10) === day;

/**
 * A UTC day of Landflow AI calls as records: each call priced with the rate card version effective that day (input,
 * cache read, cache write, output; the long-context tier when the prompt is over it), summed per day × provider ×
 * model × workflow × agent × actor × meter × price line, rounded half-even once per row. Landflow's own estimate of
 * the calls goes in x_SourceCost on the group's first row. A model with no line (or a day with no approved rate card)
 * is priced at Landflow's estimate, labelled `:landflow-estimate`, never a zero that looks like a price. Events
 * without cache tokens (before Landflow's backbone wave 3) get a per-model `Adjustment` row from the insights.
 */
export function buildLandflowDay(input: LandflowDayInput): BuiltDay {
  const { day, version, names } = input;
  const warnings: string[] = [];
  const groups = new Map<string, AiGroup>();
  const callGroups = new Map<string, string>(); // call group → the key of its first row (x_SourceCost lives there)
  const sourceCosts = new Map<string, Decimal>();
  const knownCache = new Map<string, { cacheRead: bigint; cacheWrite: bigint; provider: string; model: string }>();
  const unknownCacheModels = new Set<string>();
  const prices = new Map<string, AiPrice | null>();
  const missing = new Set<string>();
  let read = 0;
  for (const e of input.events) {
    if (!inDay(e.at, day)) continue;
    read++;
    const provider = e.attrs.provider || 'unknown';
    const model = e.attrs.model || 'unknown';
    const pm = `${provider}|${model}`;
    if (!prices.has(pm)) prices.set(pm, version ? findAiPrice(version, provider, model) : null);
    const price = prices.get(pm)!;
    const call = {
      input: BigInt(e.attrs.input),
      output: BigInt(e.attrs.output),
      cacheRead: e.attrs.cacheRead === undefined ? null : BigInt(e.attrs.cacheRead),
      cacheWrite: e.attrs.cacheWrite === undefined ? null : BigInt(e.attrs.cacheWrite),
    };
    if (call.cacheRead !== null && call.cacheWrite !== null) {
      const k = knownCache.get(pm) ?? { cacheRead: 0n, cacheWrite: 0n, provider, model };
      k.cacheRead += call.cacheRead;
      k.cacheWrite += call.cacheWrite;
      knownCache.set(pm, k);
    } else unknownCacheModels.add(pm);
    const who = { workflow: e.workflowId ?? null, agent: e.agentId ?? null, actor: e.actorId ?? null };
    const callKey = `${pm}|${who.workflow ?? '-'}|${who.agent ?? '-'}|${who.actor ?? '-'}`;
    sourceCosts.set(callKey, (sourceCosts.get(callKey) ?? Decimal.ZERO).plus(e.cost ?? '0'));
    const add = (meter: string, line: PriceLine | null, tokens: bigint) => {
      const key = `${callKey}|${meter}|${line?.skuPriceId ?? 'landflow-estimate'}`;
      const g = groups.get(key) ?? {
        provider,
        model,
        ...who,
        meter,
        line,
        tokens: 0n,
        sourceCost: Decimal.ZERO,
        calls: 0,
      };
      g.tokens += tokens;
      g.calls++;
      if (!line) g.sourceCost = g.sourceCost.plus(e.cost ?? '0');
      groups.set(key, g);
      if (!callGroups.has(callKey)) callGroups.set(callKey, key);
    };
    if (!price) {
      if (!missing.has(pm)) {
        missing.add(pm);
        warnings.push(
          version
            ? `No rate line for ${provider}/${model}: priced at Landflow's estimate (add a line to the rate card)`
            : `No approved rate card on ${day}: ${provider}/${model} priced at Landflow's estimate`,
        );
      }
      add('Landflow Estimate', null, call.input + call.output);
      continue;
    }
    for (const part of priceAiCall(price, call)) add(AI_METER_NAME[part.meter as AiMeter], part.line, part.tokens);
  }

  const records: CostRecord[] = [];
  const keyOf = (g: AiGroup) =>
    `landflow:${day}:${g.provider}:${g.model}:${g.workflow ?? '-'}:${g.agent ?? '-'}:${g.actor ?? '-'}:${g.meter}:${g.line?.skuPriceId ?? 'landflow-estimate'}`;
  const sourceCostOn = new Map([...callGroups.entries()].map(([callKey, key]) => [key, sourceCosts.get(callKey)!]));
  for (const [key, g] of groups) {
    const tokens = Decimal.of(g.tokens);
    const tags = aiTags(g, names, input.host);
    const common = aiCommon(g.provider, g.model, version, day);
    const description = `${g.model} ${g.meter.toLowerCase()}, ${g.calls} call${g.calls === 1 ? '' : 's'}${g.agent ? `, agent ${names.agents.get(g.agent) ?? g.agent}` : ''}`;
    if (g.line) {
      records.push(
        record(day, {
          ...common,
          ...priced(g.line, pricingQuantity(g.line, tokens), tokensCost(g.line, tokens)),
          ConsumedQuantity: tokens,
          ConsumedUnit: 'Tokens',
          ChargeDescription: description,
          PricingCategory: 'Standard',
          SkuPriceDetails: g.line.details as JsonObject | null,
          Tags: tags,
          x_SourceKey: keyOf(g),
          x_SourceCost: sourceCostOn.get(key) ?? null,
          x_RateCardVersion: version?.id ?? null,
          x_WorkflowId: g.workflow,
          x_AgentId: g.agent,
          x_ActorId: g.actor,
        }),
      );
    } else {
      const cost = Money.fromDecimal(g.sourceCost, CURRENCY);
      records.push(
        record(day, {
          ...common,
          EffectiveCost: cost,
          ConsumedQuantity: tokens,
          ConsumedUnit: 'Tokens',
          ChargeDescription: `${description}; no rate line: Landflow's estimate`,
          PricingCategory: 'Other',
          SkuId: `${g.provider}:${g.model}`,
          SkuMeter: g.meter,
          SkuPriceId: `${g.provider}:${g.model}:landflow-estimate`,
          Tags: tags,
          x_SourceKey: keyOf(g),
          x_SourceCost: sourceCostOn.get(key) ?? g.sourceCost,
          x_RateCardVersion: null,
          x_WorkflowId: g.workflow,
          x_AgentId: g.agent,
          x_ActorId: g.actor,
        }),
      );
    }
  }

  // The cache adjustment, for models whose events didn't carry cache tokens (spec 002, D11).
  if (input.insights && version) {
    for (const m of input.insights.models) {
      const pm = `${m.provider || 'unknown'}|${m.model || 'unknown'}`;
      if (!unknownCacheModels.has(pm)) continue;
      const known = knownCache.get(pm);
      const cacheRead = BigInt(m.cacheReadTokens ?? '0') - (known?.cacheRead ?? 0n);
      const cacheWrite = BigInt(m.cacheWriteTokens ?? '0') - (known?.cacheWrite ?? 0n);
      if (cacheRead <= 0n && cacheWrite <= 0n) continue;
      const price = prices.get(pm);
      if (!price) continue;
      for (const part of cacheAdjustment(price, {
        cacheRead: cacheRead > 0n ? cacheRead : 0n,
        cacheWrite: cacheWrite > 0n ? cacheWrite : 0n,
      })) {
        const quantity = Quantity.of(Decimal.of(part.tokens), 'Tokens').in(part.line.pricingUnit).value;
        const cost = Money.fromProduct(
          Rate.of(part.unitPrice, part.line.currency, part.line.pricingUnit),
          Quantity.of(quantity, part.line.pricingUnit),
        );
        records.push(
          record(day, {
            ...aiCommon(m.provider, m.model, version, day),
            EffectiveCost: cost,
            ListUnitPrice: part.unitPrice,
            ContractedUnitPrice: part.unitPrice,
            PricingQuantity: quantity,
            PricingUnit: part.line.pricingUnit,
            ChargeCategory: 'Adjustment',
            ChargeDescription: `Cache ${part.meter === 'cacheRead' ? 'reads' : 'writes'} of ${m.model} on ${day} moved from the input price to the cache price (Landflow's events before cache tokens)`,
            SkuId: part.line.skuId,
            SkuMeter: `${AI_METER_NAME[part.meter]} Adjustment`,
            SkuPriceId: `${part.line.skuPriceId}:adjustment`,
            SkuPriceDetails: { Basis: 'cache price − input price', Tokens: part.tokens.toString() },
            Tags: aiTags(
              { provider: m.provider, model: m.model, workflow: null, agent: null, actor: null },
              names,
              input.host,
            ),
            x_SourceKey: `landflow:insights:${day}:${m.provider}:${m.model}:${part.meter}`,
            x_RateCardVersion: version.id,
          }),
        );
      }
      warnings.push(`${m.model}: cache tokens corrected by a daily adjustment (events without cache tokens)`);
    }
  }
  return { records, warnings, read };
}

function aiCommon(
  provider: string,
  model: string,
  version: PricedVersion | null,
  _day: string,
): Partial<CostRecord> & { x_Source: 'landflow' } {
  const name = providerName(provider);
  return {
    ServiceCategory: 'AI and Machine Learning',
    ServiceSubcategory: 'Generative AI',
    ServiceName: isLocal(provider) ? `${name} (local models)` : `${name} API`,
    ServiceProviderName: name,
    HostProviderName: isLocal(provider) ? 'This machine' : name,
    InvoiceIssuerName: isLocal(provider) ? 'Land platform' : name,
    BillingAccountId: `${provider.toLowerCase()}:landflow`,
    ResourceType: 'AI Model',
    ResourceId: `${provider}:${model}`,
    ResourceName: model,
    PricingUnit: null,
    x_Source: 'landflow',
    x_RateCardVersion: version?.id ?? null,
  };
}

function aiTags(
  g: { provider: string; model: string; workflow: string | null; agent: string | null; actor: string | null },
  names: LandflowNames,
  host: { service: string; namespace: string },
): JsonObject {
  const t: JsonObject = {
    resource: 'ai',
    service: host.service,
    namespace: host.namespace,
    provider: g.provider,
    model: g.model,
  };
  if (g.workflow) {
    t.workflow = g.workflow;
    t.workflowName = names.workflows.get(g.workflow) ?? g.workflow;
  }
  if (g.agent) {
    t.agent = g.agent;
    t.agentName = names.agents.get(g.agent) ?? g.agent;
  }
  if (g.actor) t.actor = g.actor;
  return t;
}

// Clickland ---------------------------------------------------------------------------------------------------------

export interface ClicklandDayInput {
  day: string;
  rollup: ClicklandRollup;
  version: PricedVersion;
  /**
   * The Kubernetes cluster whose node the Docker engine shares (OrbStack: one machine runs both). Its capacity is the
   * whole machine, so Docker's usage is taken out of that node's idle: the day adds up to capacity × rate once.
   */
  dockerSharesCluster?: string | null;
}

/** Claims whose size is within this share of a claim flagged on the node's filesystem report the node disk too. */
const NODE_DISK_TOLERANCE = '0.01';

const EMPTY = '-';
const dec = (s: string | null | undefined) => Decimal.parse(s ?? '0');

/**
 * A UTC day of Clickland's rollup as records, OpenCost's model (docs/research.md D1): per cluster and resource (CPU,
 * memory) one row per workload container for its allocated quantity, and one idle row for capacity − Σ allocated, the
 * two adding up exactly to allocatable × rate (FOCUS split-cost columns: idle has no AllocatedResourceId). Docker
 * containers are priced on usage; when the engine shares a cluster's node (`dockerSharesCluster`) their usage comes out
 * of that node's idle, so nothing is priced twice; on a host of its own Docker has no idle. Storage: persistent volume
 * claims' capacity; a claim on the node's own disk reports the disk's size, so it is priced at its requested size when
 * the rollup has it, else kept as a quantity with no price. Network: bytes sent, as a quantity with no price.
 */
export function buildClicklandDay(input: ClicklandDayInput): BuiltDay {
  const { day, rollup, version } = input;
  const warnings: string[] = [];
  const records: CostRecord[] = [];
  for (const m of rollup.coverage.missing) warnings.push(`Clickland: ${m.field}: ${m.reason}`);

  type Row = {
    key: string;
    source: 'kubernetes' | 'docker';
    cluster: string;
    g: Record<string, string>;
    cpu: Decimal;
    cpuUsed: Decimal;
    mem: Decimal;
    memUsed: Decimal;
    tx: Decimal | null;
  };
  const rows = new Map<string, Row>();
  for (const r of rollup.rows) {
    const g = r.group;
    const cluster = r.source === 'kubernetes' ? g['k8s.cluster.name'] || 'cluster' : 'docker';
    const id =
      r.source === 'kubernetes'
        ? `${g['k8s.namespace.name'] || EMPTY}/${g['k8s.workload.kind'] || EMPTY}/${g['k8s.workload.name'] || EMPTY}/${g['k8s.container.name'] || EMPTY}`
        : `${g['compose.project'] || EMPTY}/${g['compose.service'] || EMPTY}/${g['container.name'] || EMPTY}`;
    const key = `${cluster}:${id}`;
    const prev = rows.get(key);
    const cpu = dec(r.cpuAllocatedCoreHours ?? r.cpuCoreHours);
    const mem = dec(r.memoryAllocatedGiBHours ?? r.memoryGiBHours);
    const tx = r.networkTxGB == null ? null : dec(r.networkTxGB);
    if (prev) {
      prev.cpu = prev.cpu.plus(cpu);
      prev.cpuUsed = prev.cpuUsed.plus(dec(r.cpuCoreHours));
      prev.mem = prev.mem.plus(mem);
      prev.memUsed = prev.memUsed.plus(dec(r.memoryGiBHours));
      prev.tx = tx === null ? prev.tx : (prev.tx ?? Decimal.ZERO).plus(tx);
    } else
      rows.set(key, {
        key,
        source: r.source,
        cluster,
        g,
        cpu,
        cpuUsed: dec(r.cpuCoreHours),
        mem,
        memUsed: dec(r.memoryGiBHours),
        tx,
      });
    if (r.source === 'kubernetes' && r.cpuAllocatedCoreHours === undefined)
      warnings.push('Clickland: the rollup has no allocated figures; Kubernetes rows priced on usage');
  }
  const clusters = new Map<string, { cpu: Decimal; mem: Decimal; nodes: string[] }>();
  for (const c of rollup.capacity) {
    const x = clusters.get(c.cluster) ?? { cpu: Decimal.ZERO, mem: Decimal.ZERO, nodes: [] };
    x.cpu = x.cpu.plus(c.cpuAllocatableCoreHours);
    x.mem = x.mem.plus(c.memoryAllocatableGiBHours);
    x.nodes.push(c.node);
    clusters.set(c.cluster, x);
  }

  const byCluster = new Map<string, Row[]>();
  for (const r of rows.values()) byCluster.set(r.cluster, [...(byCluster.get(r.cluster) ?? []), r]);
  // Docker on the same machine as a cluster's node: priced with that node, so its usage comes out of the node's idle.
  const sharedWith =
    input.dockerSharesCluster && byCluster.has('docker') && clusters.has(input.dockerSharesCluster)
      ? input.dockerSharesCluster
      : null;
  const priceLists = new Map<string, Row[]>();
  for (const [cluster, list] of byCluster)
    if (!(sharedWith && cluster === 'docker'))
      priceLists.set(cluster, [...list, ...(cluster === sharedWith ? byCluster.get('docker')! : [])]);
  if (sharedWith && !byCluster.has(sharedWith)) priceLists.set(sharedWith, byCluster.get('docker')!);
  if (input.dockerSharesCluster && byCluster.has('docker') && !sharedWith)
    warnings.push(
      `Clickland: no node capacity for ${input.dockerSharesCluster}, which the Docker engine shares; Docker priced on its own`,
    );

  for (const [cluster, list] of priceLists) {
    const docker = cluster === 'docker';
    const cap = docker ? null : (clusters.get(cluster) ?? null);
    if (!docker && !cap)
      warnings.push(`Clickland: no node capacity for cluster ${cluster}; its rows are priced with no idle`);
    const withDocker = cluster === sharedWith;
    for (const resource of ['cpu', 'memory'] as const) {
      const line = clusterLine(version, resource);
      if (!line) {
        warnings.push(`Rate card v${version.version} has no ${resource} line: ${cluster} ${resource} not priced`);
        continue;
      }
      const p = priceCluster({
        resource,
        line,
        capacity: cap ? (resource === 'cpu' ? cap.cpu : cap.mem) : null,
        rows: list.map((r) => ({ key: r.key, allocated: resource === 'cpu' ? r.cpu : r.mem })),
        label: `${cluster} ${resource}`,
      });
      warnings.push(...p.warnings);
      p.rows.forEach((pr, i) => {
        const r = list[i]!;
        if (pr.quantity.isZero()) return;
        records.push(
          clusterRecord(
            day,
            version,
            line,
            resource,
            r,
            pr.quantity,
            pr.cost,
            resource === 'cpu' ? r.cpuUsed : r.memUsed,
            cap?.nodes ?? [],
          ),
        );
      });
      if (p.idle && cap) {
        records.push(
          record(day, {
            ...clusterCommon(cluster, false, cap.nodes),
            EffectiveCost: p.idle.cost,
            PricingQuantity: p.idle.quantity,
            PricingUnit: line.pricingUnit,
            ConsumedQuantity: p.idle.quantity,
            ConsumedUnit: line.pricingUnit,
            SkuId: line.skuId,
            SkuMeter: `Idle ${resource === 'cpu' ? 'Cores' : 'Memory'}`,
            SkuPriceId: line.skuPriceId,
            SkuPriceDetails: {
              UnitPrice: line.unitPrice.toString(),
              Capacity: (resource === 'cpu' ? cap.cpu : cap.mem).toString(),
              CapacityCost: p.capacityCost!.toDecimal().toString(),
              Remainder: true,
            },
            ChargeDescription: `Idle ${resource === 'cpu' ? 'CPU' : 'memory'} on ${cluster}: capacity less what workloads${withDocker ? ' and the Docker containers on the same machine' : ''} were allocated`,
            AllocatedMethodId: 'LandledgerK8sMaxRequestUsage',
            AllocatedMethodDetails: withDocker
              ? {
                  Basis:
                    'capacity − Σ allocated (pods, and Docker containers on the same node by usage); cost = capacity × rate − Σ allocated costs',
                  Version: 2,
                }
              : {
                  Basis: 'capacity − Σ allocated; cost = capacity × rate − Σ allocated costs',
                  Version: 1,
                },
            AllocatedResourceId: null,
            AllocatedResourceName: 'Idle',
            Tags: { resource, idle: 'true', cluster, service: 'Cluster idle', namespace: '' },
            x_SourceKey: `clickland:${day}:${cluster}:idle:${resource}`,
            x_RateCardVersion: version.id,
          }),
        );
      }
    }
  }
  for (const [cluster, list] of byCluster) {
    const docker = cluster === 'docker';
    const cap = docker ? null : (clusters.get(cluster) ?? null);
    // Network: bytes sent, a quantity with no price until finance decides what counts as egress.
    for (const r of list) {
      if (!r.tx || r.tx.isZero()) continue;
      const egress = clusterLine(version, 'egress');
      records.push(
        record(day, {
          ...clusterCommon(cluster, docker, cap?.nodes ?? []),
          ...allocatedOf(r),
          ServiceCategory: 'Networking',
          ServiceSubcategory: 'Network Infrastructure',
          ConsumedQuantity: r.tx,
          ConsumedUnit: 'GB',
          PricingCategory: 'Other',
          SkuId: egress?.skuId ?? 'landledger:network:egress',
          SkuMeter: 'Network Sent',
          SkuPriceId: egress?.skuPriceId ?? 'landledger:network:egress',
          SkuPriceDetails: {
            Applied: false,
            Reason: 'Network is unpriced until finance decides what counts as egress',
          },
          ChargeDescription: `Network sent by ${r.key.split(':').slice(1).join(':')} (not priced)`,
          Tags: rowTags(r, 'network'),
          x_SourceKey: `clickland:${day}:${r.key}:network`,
          x_RateCardVersion: version.id,
        }),
      );
    }
  }

  // Storage: claims' capacity × hours as GB-months. A claim on the node's own filesystem (local-path) reports the node
  // disk's size, not its own: Clickland flags it, and a claim of the same cluster within 1% of a flagged one's size is
  // the node disk too (Clickland flags by sample, and a sample a little off the disk's size misses its flag). Such a
  // claim is priced at its requested size when the rollup has it, else kept as a quantity with no price.
  const storage = clusterLine(version, 'storage');
  const flagged = rollup.volumes.filter((v) => v.sharesNodeFilesystem);
  const onNodeDisk = (v: (typeof rollup.volumes)[number]) =>
    v.sharesNodeFilesystem ||
    flagged.some(
      (f) =>
        f.cluster === v.cluster &&
        !dec(f.capacityGiBHours).isZero() &&
        dec(v.capacityGiBHours)
          .minus(dec(f.capacityGiBHours))
          .abs()
          .compare(dec(f.capacityGiBHours).times(NODE_DISK_TOLERANCE)) <= 0,
    );
  const unpriced: string[] = [];
  const byRequest: string[] = [];
  for (const v of rollup.volumes) {
    const nodeDisk = onNodeDisk(v);
    const requested = v.requestedGiBHours == null ? null : dec(v.requestedGiBHours);
    const cap = clusters.get(v.cluster);
    const common = {
      ...clusterCommon(v.cluster, false, cap?.nodes ?? []),
      ServiceCategory: 'Storage' as const,
      ServiceSubcategory: 'Block Storage',
      AllocatedResourceId: `k8s:${v.cluster}/${v.namespace}/pvc/${v.claim}`,
      AllocatedResourceName: `${v.namespace}/${v.claim}`,
      Tags: { resource: 'storage', cluster: v.cluster, namespace: v.namespace, claim: v.claim, service: v.claim },
      x_SourceKey: `clickland:${day}:${v.cluster}:${v.namespace}/pvc/${v.claim}:storage`,
      x_RateCardVersion: version.id,
    };
    if (nodeDisk && requested === null) {
      // The size reported is the node disk's: a quantity, with no price, until the claim's own size is known.
      unpriced.push(`${v.namespace}/${v.claim}`);
      records.push(
        record(day, {
          ...common,
          ConsumedQuantity: dec(v.capacityGiBHours),
          ConsumedUnit: 'GiB-Hours',
          PricingCategory: 'Other',
          SkuId: storage?.skuId ?? 'landledger:k8s:storage',
          SkuMeter: 'Storage (node disk)',
          SkuPriceId: storage?.skuPriceId ?? 'landledger:k8s:storage',
          SkuPriceDetails: {
            Applied: false,
            Reason:
              "On the node's own filesystem (local-path): the size reported is the node disk's, and the claim's requested size is not collected",
          },
          ChargeDescription: `Volume claim ${v.namespace}/${v.claim} on the node's disk: the node disk's size × hours (not priced)`,
          AllocatedMethodId: 'LandledgerClaimOnNodeDisk',
          AllocatedMethodDetails: { Basis: 'quantity only: the node disk, not the claim', Version: 1 },
        }),
      );
      continue;
    }
    if (!storage) continue;
    const gibHours = nodeDisk ? requested! : dec(v.capacityGiBHours);
    if (nodeDisk) byRequest.push(`${v.namespace}/${v.claim}`);
    const quantity = gibHoursToGbMonths(gibHours, version.hoursPerMonth);
    if (quantity.isZero()) continue;
    records.push(
      record(day, {
        ...common,
        ...priced(storage, quantity),
        ConsumedQuantity: nodeDisk ? gibHours : dec(v.usedGiBHours),
        ConsumedUnit: 'GiB-Hours',
        ChargeDescription: `Volume claim ${v.namespace}/${v.claim}: ${nodeDisk ? 'requested size' : 'capacity'} × hours`,
        AllocatedMethodId: nodeDisk ? 'LandledgerClaimRequest' : 'LandledgerClaimCapacity',
        AllocatedMethodDetails: {
          Basis: `claim ${nodeDisk ? 'requested' : 'capacity'} GiB-hours × 1.073741824 ÷ hours per month`,
          HoursPerMonth: version.hoursPerMonth.toString(),
        },
      }),
    );
  }
  if (unpriced.length)
    warnings.push(
      `Storage not priced for ${unpriced.length} claim(s) on the node's own disk (the size reported is the disk's, and their requested size isn't collected): ${unpriced.join(', ')}`,
    );
  if (byRequest.length)
    warnings.push(`Storage priced at the requested size for ${byRequest.length} claim(s) on the node's own disk`);
  return { records, warnings, read: rollup.rows.length + rollup.capacity.length + rollup.volumes.length };
}

function clusterCommon(
  cluster: string,
  docker: boolean,
  nodes: string[],
): Partial<CostRecord> & { x_Source: 'clickland' } {
  return {
    ServiceCategory: 'Compute',
    ServiceSubcategory: 'Containers',
    ServiceName: docker ? 'Docker (this machine)' : `Kubernetes (${cluster})`,
    ServiceProviderName: 'Land platform',
    HostProviderName: docker ? 'Docker engine (this machine)' : 'OrbStack (this machine)',
    InvoiceIssuerName: 'Land platform',
    BillingAccountId: 'internal',
    BillingAccountName: 'Land platform (internal)',
    SubAccountId: cluster,
    SubAccountName: cluster,
    SubAccountType: docker ? 'Docker Engine' : 'Kubernetes Cluster',
    ResourceId: docker ? 'docker:engine' : nodes.length === 1 ? `k8s:${cluster}/node/${nodes[0]}` : `k8s:${cluster}`,
    ResourceName: docker ? 'Docker engine' : nodes.length === 1 ? nodes[0]! : cluster,
    ResourceType: docker ? 'Docker Engine' : nodes.length === 1 ? 'Kubernetes Node' : 'Kubernetes Cluster',
    x_Source: 'clickland',
  };
}

function allocatedOf(r: {
  source: string;
  cluster: string;
  g: Record<string, string>;
  key: string;
}): Partial<CostRecord> {
  const id = r.key.slice(r.cluster.length + 1);
  return {
    AllocatedMethodId: r.source === 'docker' ? 'LandledgerDockerUsage' : 'LandledgerK8sMaxRequestUsage',
    AllocatedMethodDetails:
      r.source === 'docker'
        ? { Basis: 'usage (Docker has no requests)', Version: 1 }
        : { Basis: 'max(request, usage) per sample', Version: 1 },
    AllocatedResourceId: `${r.source === 'docker' ? 'docker' : `k8s:${r.cluster}`}/${id}`,
    AllocatedResourceName: id,
  };
}

function rowTags(r: { source: string; cluster: string; g: Record<string, string> }, resource: string): JsonObject {
  const g = r.g;
  const t: JsonObject = { resource, cluster: r.cluster };
  if (r.source === 'kubernetes') {
    t.namespace = g['k8s.namespace.name'] ?? '';
    t.workloadKind = g['k8s.workload.kind'] ?? '';
    t.workload = g['k8s.workload.name'] ?? '';
    t.container = g['k8s.container.name'] ?? '';
    t.service = t.workload || (t.container as string) || 'unknown';
  } else {
    t.composeProject = g['compose.project'] ?? '';
    t.composeService = g['compose.service'] ?? '';
    t.container = g['container.name'] ?? '';
    t.namespace = t.composeProject ? `compose:${t.composeProject}` : '';
    t.service = t.composeProject ? `${t.composeProject}/${t.composeService}` : (t.container as string) || 'unknown';
  }
  for (const [k, v] of Object.entries(g)) if (k.startsWith('k8s.pod.label.') && v) t[`label:${k.slice(14)}`] = v;
  return t;
}

function clusterRecord(
  day: string,
  version: PricedVersion,
  line: PriceLine,
  resource: 'cpu' | 'memory',
  r: { key: string; source: string; cluster: string; g: Record<string, string> },
  quantity: Decimal,
  cost: Money,
  used: Decimal,
  nodes: string[],
): CostRecord {
  return record(day, {
    ...clusterCommon(r.cluster, r.source === 'docker', nodes),
    ...priced(line, quantity, cost),
    ConsumedQuantity: used,
    ConsumedUnit: line.pricingUnit,
    SkuMeter: r.source === 'docker' ? (resource === 'cpu' ? 'Used Cores' : 'Used Memory') : line.skuMeter,
    ChargeDescription: `${resource === 'cpu' ? 'CPU' : 'Memory'} for ${r.key.slice(r.cluster.length + 1)}`,
    ...allocatedOf(r),
    Tags: rowTags(r, resource),
    x_SourceKey: `clickland:${day}:${r.key}:${resource}`,
    x_RateCardVersion: version.id,
  });
}
