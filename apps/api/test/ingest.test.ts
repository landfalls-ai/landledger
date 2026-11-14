import { ClicklandRollup, type LandflowAiEvent } from '@landledger/contracts';
import { check } from '@landledger/focus';
import { Decimal, Money } from '@landledger/money';
import type { PriceLine, PricedVersion } from '@landledger/pricing';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseBudgetCsv } from '../src/budgets.js';
import { toCsv, toXlsx } from '../src/export.js';
import { buildClicklandDay, buildLandflowDay } from '../src/ingest/build.js';
import { fingerprint } from '../src/ingest/runner.js';
import { otlpCostMetrics } from '../src/metrics.js';
import { aiLinesFor } from '../src/ratecards.js';
import type { Line } from '../src/spend.js';

// Fixtures: the shapes Landflow and Clickland answer with on this machine, scrubbed (ids invented, numbers kept small).

const line = (
  over: Omit<Partial<PriceLine>, 'unitPrice'> & { skuPriceId: string; unitPrice: string; pricingUnit: string },
): PriceLine => ({
  id: `rl_${over.skuPriceId}`,
  skuId: over.skuId ?? over.skuPriceId,
  skuMeter: over.skuMeter ?? 'Meter',
  label: over.label ?? over.skuPriceId,
  provider: over.provider ?? null,
  model: over.model ?? null,
  currency: 'USD',
  details: over.details ?? null,
  ...over,
  unitPrice: Decimal.parse(over.unitPrice),
});

const aiLines = (
  provider: string,
  model: string,
  p: { input: string; output: string; cacheRead?: string; cacheWrite?: string },
) =>
  aiLinesFor({ provider, model, ...p }).map((l) =>
    line({
      skuPriceId: l.skuPriceId,
      skuId: l.sku,
      skuMeter: l.meter,
      provider: l.provider,
      model: l.model,
      unitPrice: l.price,
      pricingUnit: '1000000 Tokens',
      details: l.details,
    }),
  );

const VERSION: PricedVersion = {
  id: 'rcv_test_1',
  version: 1,
  effectiveFrom: '2026-11-01',
  effectiveTo: null,
  hoursPerMonth: Decimal.parse('730'),
  lines: [
    line({
      skuPriceId: 'landledger:k8s:cpu',
      unitPrice: '0.034',
      pricingUnit: 'Core-Hours',
      skuMeter: 'Allocated Cores',
    }),
    line({
      skuPriceId: 'landledger:k8s:memory',
      unitPrice: '0.0045',
      pricingUnit: 'GiB-Hours',
      skuMeter: 'Allocated Memory',
    }),
    line({ skuPriceId: 'landledger:k8s:storage', unitPrice: '0.10', pricingUnit: 'GB-Months', skuMeter: 'Storage' }),
    line({ skuPriceId: 'landledger:network:egress', unitPrice: '0.02', pricingUnit: 'GB', skuMeter: 'Egress' }),
    ...aiLines('anthropic', 'claude-sonnet-4-5', { input: '3', output: '15', cacheRead: '0.30', cacheWrite: '3.75' }),
    ...aiLines('ollama', '*', { input: '0', output: '0' }),
  ],
};

const names = { agents: new Map([['ag_1', 'Triage lead']]), workflows: new Map([['wf_1', 'Nightly sync']]) };
const host = { service: 'landflow-host', namespace: 'landflow-dev' };

const event = (id: string, attrs: Record<string, string>, cost = '0'): LandflowAiEvent => ({
  id,
  at: '2026-11-02T10:00:00.000Z',
  kind: 'ai.call',
  workflowId: 'wf_1',
  agentId: 'ag_1',
  actorId: 'usr_1',
  cost,
  attrs: { provider: 'anthropic', model: 'claude-sonnet-4-5', input: '0', output: '0', ...attrs },
});

const valid = (r: Parameters<typeof check>[0]) => check({ ...r, x_RecordId: 'rec', x_IngestRunId: 'run' });

describe('Landflow AI calls → records', () => {
  it('prices cache reads and writes at their prices when the event carries them (after backbone wave 3)', () => {
    // input is the whole prompt: 1,000,000 = 600,000 uncached + 300,000 read + 100,000 written.
    const out = buildLandflowDay({
      day: '2026-11-02',
      events: [event('e1', { input: '1000000', output: '200000', cacheRead: '300000', cacheWrite: '100000' }, '4.65')],
      version: VERSION,
      names,
      insights: null,
      host,
    });
    const by = Object.fromEntries(out.records.map((r) => [r.SkuMeter, r.EffectiveCost.toString()]));
    expect(by).toEqual({
      'Input Tokens': 'USD 1.800000',
      'Cache Read Tokens': 'USD 0.090000',
      'Cache Write Tokens': 'USD 0.375000',
      'Output Tokens': 'USD 3.000000',
    });
    // Landflow's estimate rides on one row of the call group.
    expect(out.records.filter((r) => r.x_SourceCost !== null).map((r) => r.x_SourceCost!.toString())).toEqual(['4.65']);
    expect(out.records.every((r) => valid(r).length === 0)).toBe(true);
    expect(out.records[0]!.Tags).toMatchObject({
      agent: 'ag_1',
      agentName: 'Triage lead',
      workflowName: 'Nightly sync',
      service: 'landflow-host',
    });
  });

  it('treats a missing cache key as unknown: whole input at the input price, then a daily per-model adjustment', () => {
    const insights = {
      models: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          inputTokens: '1000000',
          outputTokens: '0',
          cacheReadTokens: '300000',
          cacheWriteTokens: '100000',
          calls: '1',
        },
      ],
    };
    const out = buildLandflowDay({
      day: '2026-11-02',
      events: [event('e1', { input: '1000000' })],
      version: VERSION,
      names,
      insights,
      host,
    });
    const usage = out.records.filter((r) => r.ChargeCategory === 'Usage');
    const adj = out.records.filter((r) => r.ChargeCategory === 'Adjustment');
    expect(usage.map((r) => r.EffectiveCost.toString())).toEqual(['USD 3.000000']);
    expect(adj.map((r) => [r.SkuMeter, r.EffectiveCost.toString()])).toEqual([
      ['Cache Read Tokens Adjustment', 'USD -0.810000'],
      ['Cache Write Tokens Adjustment', 'USD 0.075000'],
    ]);
    // Same total as if the events had carried the buckets: 1.80 + 0.09 + 0.375.
    expect(
      Money.sum(
        [...usage, ...adj].map((r) => r.EffectiveCost),
        'USD',
      ).toString(),
    ).toBe('USD 2.265000');
    expect(out.records.every((r) => valid(r).length === 0)).toBe(true);
  });

  it('adjusts only for the events without cache keys, when a day has both', () => {
    const insights = {
      models: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          inputTokens: '2000000',
          outputTokens: '0',
          cacheReadTokens: '500000',
          cacheWriteTokens: '0',
          calls: '2',
        },
      ],
    };
    const out = buildLandflowDay({
      day: '2026-11-02',
      events: [
        event('old', { input: '1000000' }),
        event('new', { input: '1000000', cacheRead: '200000', cacheWrite: '0' }),
      ],
      version: VERSION,
      names,
      insights,
      host,
    });
    const adj = out.records.filter((r) => r.ChargeCategory === 'Adjustment');
    // 500,000 read in the day − 200,000 carried on the new event = 300,000 to move.
    expect(adj.map((r) => r.SkuPriceDetails?.Tokens)).toEqual(['-300000']);
  });

  it('never adjusts a model whose events all carry cache keys', () => {
    const insights = {
      models: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          inputTokens: '1',
          outputTokens: '0',
          cacheReadTokens: '1',
          calls: '1',
        },
      ],
    };
    const out = buildLandflowDay({
      day: '2026-11-02',
      events: [event('e', { input: '1000', cacheRead: '0', cacheWrite: '0' })],
      version: VERSION,
      names,
      insights,
      host,
    });
    expect(out.records.some((r) => r.ChargeCategory === 'Adjustment')).toBe(false);
  });

  it("prices at Landflow's estimate, labelled, when no rate card is approved for the day", () => {
    const out = buildLandflowDay({
      day: '2026-10-31',
      events: [{ ...event('e', { input: '10', output: '5' }, '0.000105'), at: '2026-10-31T09:00:00Z' }],
      version: null,
      names,
      insights: null,
      host,
    });
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({
      PricingCategory: 'Other',
      SkuPriceId: 'anthropic:claude-sonnet-4-5:landflow-estimate',
      x_RateCardVersion: null,
    });
    expect(out.records[0]!.EffectiveCost.toString()).toBe('USD 0.000105');
    expect(out.warnings[0]).toMatch(/No approved rate card/);
  });

  it('prices local models at zero by their provider-wide line', () => {
    const out = buildLandflowDay({
      day: '2026-11-02',
      events: [event('e', { provider: 'ollama', model: 'qwen3-coder:30b', input: '5000', output: '100' })],
      version: VERSION,
      names,
      insights: null,
      host,
    });
    expect(out.records.map((r) => [r.SkuPriceId, r.EffectiveCost.toString(), r.ServiceName])).toEqual([
      ['ollama:*:input', 'USD 0.000000', 'Ollama (local models)'],
      ['ollama:*:output', 'USD 0.000000', 'Ollama (local models)'],
    ]);
  });

  it('builds the same records for the same events (stable source keys and fingerprints)', () => {
    const run = () =>
      buildLandflowDay({
        day: '2026-11-02',
        events: [event('a', { input: '100', output: '10' }), event('b', { input: '50', output: '5' })],
        version: VERSION,
        names,
        insights: null,
        host,
      });
    const a = run().records.map((r) => [r.x_SourceKey, fingerprint(r)]);
    const b = run()
      .records.reverse()
      .map((r) => [r.x_SourceKey, fingerprint(r)]);
    expect(new Map(a as [string, string][])).toEqual(new Map(b as [string, string][]));
  });
});

const rollup = ClicklandRollup.parse({
  rows: [
    {
      start: '2026-11-14T00:00:00Z',
      end: '2026-11-15T00:00:00Z',
      source: 'kubernetes',
      group: {
        'k8s.cluster.name': 'orbstack',
        'k8s.namespace.name': 'landflow-dev',
        'k8s.workload.kind': 'Deployment',
        'k8s.workload.name': 'landflow-host',
        'k8s.container.name': 'host',
      },
      cpuCoreHours: '0.5',
      cpuAllocatedCoreHours: '2.000000',
      memoryGiBHours: '1.0',
      memoryAllocatedGiBHours: '4.000000',
    },
    {
      start: '2026-11-14T00:00:00Z',
      end: '2026-11-15T00:00:00Z',
      source: 'docker',
      group: {
        'compose.project': 'clickland-infra',
        'compose.service': 'clickhouse',
        'container.name': 'clickland-infra-clickhouse-1',
      },
      cpuCoreHours: '1.000000',
      cpuAllocatedCoreHours: '1.000000',
      memoryGiBHours: '2.000000',
      memoryAllocatedGiBHours: '2.000000',
      networkTxGB: '0.5',
    },
  ],
  capacity: [
    {
      start: '2026-11-14T00:00:00Z',
      end: '2026-11-15T00:00:00Z',
      cluster: 'orbstack',
      node: 'orbstack',
      cpuAllocatableCoreHours: '10.000000',
      memoryAllocatableGiBHours: '20.000000',
    },
  ],
  volumes: [
    {
      cluster: 'orbstack',
      namespace: 'landflow-dev',
      claim: 'landflow-cache-npm',
      capacityGiBHours: '730',
      usedGiBHours: '100',
      sharesNodeFilesystem: false,
    },
    {
      cluster: 'orbstack',
      namespace: 'landflow-dev',
      claim: 'landflow-cache-pypi',
      capacityGiBHours: '9999',
      usedGiBHours: '1',
      sharesNodeFilesystem: true,
    },
    {
      // Not flagged, but within 1% of the flagged claim's size: the node disk too.
      cluster: 'orbstack',
      namespace: 'landflow-dev',
      claim: 'landflow-cache-go',
      capacityGiBHours: '9950',
      usedGiBHours: '1',
      sharesNodeFilesystem: false,
    },
    {
      // On the node disk, with its requested size known: priced at that.
      cluster: 'orbstack',
      namespace: 'landflow-dev',
      claim: 'landflow-data',
      capacityGiBHours: '9999',
      requestedGiBHours: '73',
      usedGiBHours: '1',
      sharesNodeFilesystem: true,
    },
  ],
  coverage: {
    sources: [
      {
        source: 'kubernetes',
        firstSample: '2026-11-14T15:15:00Z',
        lastSample: '2026-11-14T19:00:00Z',
        missingBuckets: [],
      },
    ],
    missing: [],
  },
});

describe('Clickland usage → records', () => {
  const out = buildClicklandDay({ day: '2026-11-14', rollup, version: VERSION });
  const cost = (key: string) => out.records.find((r) => r.x_SourceKey === key)?.EffectiveCost.toString();

  it('prices allocated quantities, and idle as capacity × rate less the rows, exactly', () => {
    expect(cost('clickland:2026-11-14:orbstack:landflow-dev/Deployment/landflow-host/host:cpu')).toBe('USD 0.068000');
    expect(cost('clickland:2026-11-14:orbstack:idle:cpu')).toBe('USD 0.272000'); // 10 × 0.034 − 0.068
    expect(cost('clickland:2026-11-14:orbstack:idle:memory')).toBe('USD 0.072000'); // 20 × 0.0045 − 0.018
    const k8s = out.records.filter(
      (r) => r.SubAccountId === 'orbstack' && (r.Tags as { resource: string }).resource === 'cpu',
    );
    expect(
      Money.sum(
        k8s.map((r) => r.EffectiveCost),
        'USD',
      ).toString(),
    ).toBe('USD 0.340000');
  });

  it('prices Docker on usage with no idle, and network as an unpriced quantity', () => {
    expect(cost('clickland:2026-11-14:docker:clickland-infra/clickhouse/clickland-infra-clickhouse-1:cpu')).toBe(
      'USD 0.034000',
    );
    expect(out.records.some((r) => r.x_SourceKey === 'clickland:2026-11-14:docker:idle:cpu')).toBe(false);
    const net = out.records.find((r) => r.x_SourceKey.endsWith(':network'))!;
    expect(net.EffectiveCost.isZero()).toBe(true);
    expect(net.ConsumedQuantity!.toString()).toBe('0.5');
  });

  it("prices claims as GB-months; a claim on the node's disk at its requested size, else as a quantity only", () => {
    // 730 GiB-hours = 1 GiB-month = 1.073741824 GB-months × 0.10.
    expect(cost('clickland:2026-11-14:orbstack:landflow-dev/pvc/landflow-cache-npm:storage')).toBe('USD 0.107374');
    expect(cost('clickland:2026-11-14:orbstack:landflow-dev/pvc/landflow-data:storage')).toBe('USD 0.010737');
    for (const claim of ['landflow-cache-pypi', 'landflow-cache-go']) {
      const r = out.records.find(
        (x) => x.x_SourceKey === `clickland:2026-11-14:orbstack:landflow-dev/pvc/${claim}:storage`,
      )!;
      expect(r.EffectiveCost.isZero()).toBe(true);
      expect(r.PricingCategory).toBe('Other');
      expect(r.ConsumedUnit).toBe('GiB-Hours');
      expect((r.SkuPriceDetails as { Applied: boolean }).Applied).toBe(false);
    }
    expect(out.warnings.some((w) => w.includes('landflow-cache-pypi, landflow-dev/landflow-cache-go'))).toBe(true);
    expect(out.warnings.some((w) => w.includes('requested size for 1 claim'))).toBe(true);
  });

  it('takes Docker out of idle when the engine shares the node: the day adds up to capacity × rate once', () => {
    const shared = buildClicklandDay({ day: '2026-11-14', rollup, version: VERSION, dockerSharesCluster: 'orbstack' });
    const of = (resource: string) =>
      Money.sum(
        shared.records
          .filter((r) => (r.Tags as { resource: string }).resource === resource)
          .map((r) => r.EffectiveCost),
        'USD',
      ).toString();
    expect(of('cpu')).toBe('USD 0.340000'); // 10 core-hours × 0.034: pods, Docker and idle together
    expect(of('memory')).toBe('USD 0.090000'); // 20 GiB-hours × 0.0045
    const sharedCost = (key: string) => shared.records.find((r) => r.x_SourceKey === key)?.EffectiveCost.toString();
    // Docker keeps its own rows; the money moves out of idle.
    expect(sharedCost('clickland:2026-11-14:docker:clickland-infra/clickhouse/clickland-infra-clickhouse-1:cpu')).toBe(
      'USD 0.034000',
    );
    expect(sharedCost('clickland:2026-11-14:orbstack:idle:cpu')).toBe('USD 0.238000'); // 0.34 − 0.068 − 0.034
    expect(sharedCost('clickland:2026-11-14:orbstack:idle:memory')).toBe('USD 0.063000'); // 0.09 − 0.018 − 0.009
    // Not sharing: Docker on top of the node's whole capacity, which double counts on one machine.
    expect(
      Money.sum(
        out.records.filter((r) => (r.Tags as { resource: string }).resource === 'cpu').map((r) => r.EffectiveCost),
        'USD',
      ).toString(),
    ).toBe('USD 0.374000');
    for (const r of shared.records) expect(valid(r)).toEqual([]);
  });

  it('keeps every record within FOCUS and the ledger rules', () => {
    for (const r of out.records) expect(valid(r)).toEqual([]);
    expect(new Set(out.records.map((r) => r.x_SourceKey)).size).toBe(out.records.length);
  });
});

describe('budget CSV', () => {
  const ccs = new Set(['ENG-PLATFORM', 'SHARED-POOL']);
  it('reads cost center, month, amount and currency', () => {
    const { rows, problems } = parseBudgetCsv(
      'cost_center,month,amount,currency\nENG-PLATFORM,2026-11,"1,250.50",USD\nshared-pool,2026-11,0.005,usd\n',
      ccs,
    );
    expect(problems).toEqual([]);
    expect(rows.map((r) => [r.costCenter, r.month, r.amount.toString()])).toEqual([
      ['ENG-PLATFORM', '2026-11', 'USD 1250.500000'],
      ['SHARED-POOL', '2026-11', 'USD 0.005000'],
    ]);
  });
  it('refuses a file with any bad row, naming every problem', () => {
    const { problems } = parseBudgetCsv(
      'cost_center,month,amount,currency\nNOPE,2026-13,-1,EUR\nENG-PLATFORM,2026-11,1,USD\nENG-PLATFORM,2026-11,2,USD\n',
      ccs,
    );
    expect(problems).toEqual([
      'Line 2: cost center "NOPE" doesn\'t exist',
      'Line 2: month "2026-13" is not YYYY-MM',
      'Line 2: currency "EUR": budgets are in USD (FX comes later)',
      'Line 2: amount "-1" is not a non-negative number',
      'Line 4: ENG-PLATFORM 2026-11 appears twice',
    ]);
    expect(parseBudgetCsv('cc,month\n', ccs).problems[0]).toMatch(/header/);
  });
});

describe('exports', () => {
  const sheet = {
    name: 'By cost center',
    header: ['Cost center', 'Total (USD)'],
    rows: [
      ['=cmd', { number: '12.345678' }],
      ['Shared pool, idle', { number: '-0.5' }],
    ] as never,
  };
  it('writes CSV that Excel reads, with formulas defused', () => {
    expect(toCsv(sheet)).toBe('﻿Cost center,Total (USD)\r\n\'=cmd,12.345678\r\n"Shared pool, idle",-0.5\r\n');
  });
  it('writes an XLSX zip whose sheet holds numbers from their exact text', () => {
    const buf = toXlsx([sheet]);
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
    const text = buf.toString('utf8');
    expect(text).toContain('<v>12.345678</v>');
    expect(text).toContain('xl/worksheets/sheet1.xml');
    expect(() => inflateRawSync(Buffer.alloc(0))).toThrow(); // stored, not deflated: nothing to inflate
  });
});

describe('cost metrics', () => {
  it('groups by service as resources and labels points by cost center, agent and day; never rates', () => {
    const l = (over: Partial<Line>): Line => ({
      recordId: 'r',
      day: '2026-11-14',
      month: '2026-11',
      postDay: '2026-11-14',
      basis: 'estimated',
      provisional: true,
      correction: false,
      source: 'clickland',
      amount: Money.parse('0.5', 'USD'),
      quantity: null,
      unit: null,
      tags: { service: 'landflow-host', namespace: 'landflow-dev' },
      serviceName: 'Kubernetes (orbstack)',
      serviceCategory: 'Compute',
      providerName: 'Land platform',
      resourceName: null,
      costCenter: 'ENG-PLATFORM',
      team: null,
      product: null,
      plClass: 'rnd',
      capitalisable: false,
      ruleId: 'lf-platform',
      ...over,
    });
    const body = otlpCostMetrics(
      [
        l({}),
        l({ amount: Money.parse('0.25', 'USD') }),
        l({
          tags: { service: 'landflow-host', namespace: 'landflow-dev', agentName: 'Triage lead' },
          costCenter: 'ENG-AGENTS',
        }),
      ],
      new Date('2026-11-14T20:00:00Z'),
    );
    expect(body.resourceMetrics).toHaveLength(1);
    const r = body.resourceMetrics[0]!;
    expect(r.resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue).toBe('landflow-host');
    expect(r.resource.attributes.find((a) => a.key === 'k8s.namespace.name')?.value.stringValue).toBe('landflow-dev');
    const m = r.scopeMetrics[0]!.metrics;
    expect(m.map((x) => [x.name, x.unit])).toEqual([['landledger.cost.estimated', 'USD']]);
    expect(m[0]!.gauge.dataPoints.map((p) => p.asDouble)).toEqual([0.75, 0.5]);
    expect(JSON.stringify(body)).not.toMatch(/rate|budget|contract/i);
  });
});
