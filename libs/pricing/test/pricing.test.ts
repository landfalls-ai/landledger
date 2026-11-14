import { Decimal, Money } from '@landledger/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cacheAdjustment,
  findAiPrice,
  gibHoursToGbMonths,
  type PriceLine,
  type PricedVersion,
  priceAiCall,
  priceCluster,
  pricingQuantity,
  RateBook,
  tokensCost,
} from '../src/index.js';

const line = (over: Omit<Partial<PriceLine>, 'unitPrice'> & { skuPriceId: string; unitPrice: string }): PriceLine => ({
  id: over.skuPriceId,
  skuId: over.skuId ?? over.skuPriceId.split(':').slice(0, 2).join(':'),
  skuMeter: 'Meter',
  label: over.skuPriceId,
  provider: null,
  model: null,
  pricingUnit: '1000000 Tokens',
  currency: 'USD',
  details: null,
  ...over,
  unitPrice: Decimal.parse(over.unitPrice),
});

const ai = (
  provider: string,
  model: string,
  prices: Record<string, string>,
  long?: { above: string } & Record<string, string>,
) => [
  ...Object.entries(prices).map(([meter, price]) =>
    line({
      skuPriceId: `${provider}:${model}:${meter}`,
      skuId: `${provider}:${model}`,
      provider,
      model,
      unitPrice: price,
      details: { Meter: meter, Tier: 'base' },
    }),
  ),
  ...(long
    ? Object.entries(long)
        .filter(([k]) => k !== 'above')
        .map(([meter, price]) =>
          line({
            skuPriceId: `${provider}:${model}:long:${meter}`,
            skuId: `${provider}:${model}`,
            provider,
            model,
            unitPrice: price,
            details: { Meter: meter, Tier: 'long-context', Above: long.above },
          }),
        )
    : []),
];

const version: PricedVersion = {
  id: 'v1',
  version: 1,
  effectiveFrom: '2026-11-01',
  effectiveTo: null,
  hoursPerMonth: Decimal.parse('730'),
  lines: [
    line({
      skuPriceId: 'landledger:k8s:cpu',
      skuId: 'landledger:k8s:cpu',
      pricingUnit: 'Core-Hours',
      unitPrice: '0.034',
    }),
    line({
      skuPriceId: 'landledger:k8s:memory',
      skuId: 'landledger:k8s:memory',
      pricingUnit: 'GiB-Hours',
      unitPrice: '0.0045',
    }),
    ...ai('anthropic', 'claude-sonnet-4-6', { input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75' }),
    ...ai(
      'anthropic',
      'claude-haiku-5-5',
      { input: '0.1', output: '0.5', cacheRead: '0.01', cacheWrite: '0.125' },
      { above: '100000', input: '0.5', output: '2.5', cacheRead: '0.05', cacheWrite: '0.625' },
    ),
    ...ai('openai', 'gpt-4o-mini', { input: '0.15', output: '0.6', cacheRead: '0.075' }),
    ...ai('openai', 'gpt-4o', { input: '2.5', output: '10', cacheRead: '1.25' }),
    line({
      skuPriceId: 'ollama:*:input',
      skuId: 'ollama:*',
      provider: 'ollama',
      model: null,
      unitPrice: '0',
      details: { Meter: 'input' },
    }),
    line({
      skuPriceId: 'ollama:*:output',
      skuId: 'ollama:*',
      provider: 'ollama',
      model: null,
      unitPrice: '0',
      details: { Meter: 'output' },
    }),
  ],
};

/** Landflow's estimateCost, exactly: Σ parts × price ÷ 1,000,000. */
const cost = (parts: ReturnType<typeof priceAiCall>) =>
  Money.sum(
    parts.map((p) => tokensCost(p.line, Decimal.of(p.tokens))),
    'USD',
  );

describe('the rate book', () => {
  it('finds the approved version effective on a day, end exclusive', () => {
    const book = new RateBook([
      { ...version, effectiveTo: '2026-12-01' },
      { ...version, id: 'v2', version: 2, effectiveFrom: '2026-12-01' },
    ]);
    expect(book.versionOn('2026-10-31')).toBeNull();
    expect(book.versionOn('2026-11-30')?.id).toBe('v1');
    expect(book.versionOn('2026-12-01')?.id).toBe('v2');
  });
});

describe('finding an AI price (Landflow’s lookup)', () => {
  it('takes the exact model, then the longest prefix (dated snapshots), ignoring vendor/ prefixes', () => {
    expect(findAiPrice(version, 'anthropic', 'claude-sonnet-4-6')?.model).toBe('claude-sonnet-4-6');
    expect(findAiPrice(version, 'openai', 'gpt-4o-mini-2024-07-18')?.model).toBe('gpt-4o-mini');
    expect(findAiPrice(version, 'openai', 'gpt-4o-2024-08-06')?.model).toBe('gpt-4o');
    expect(findAiPrice(version, 'openrouter', 'anthropic/claude-sonnet-4-6')?.provider).toBe('anthropic');
  });
  it('prices a local provider only by its own lines: every Ollama model at zero', () => {
    const p = findAiPrice(version, 'ollama', 'qwen3-coder:30b')!;
    expect(p.model).toBe('*');
    expect(cost(priceAiCall(p, { input: 2286n, output: 127n, cacheRead: null, cacheWrite: null })).isZero()).toBe(true);
    expect(findAiPrice(version, 'ollama', 'claude-sonnet-4-6')?.model).toBe('*');
  });
  it('finds nothing for an unknown model', () => {
    expect(findAiPrice(version, 'mistral', 'mistral-large')).toBeNull();
  });
});

describe('pricing an AI call (Landflow’s estimateCost cases, exact)', () => {
  const sonnet = findAiPrice(version, 'anthropic', 'claude-sonnet-4-6')!;
  it('prices input and output', () => {
    // 1,200 in and 380 out at $3 / $15 per million = 0.0036 + 0.0057
    expect(
      cost(priceAiCall(sonnet, { input: 1200n, output: 380n, cacheRead: null, cacheWrite: null })).toString(),
    ).toBe('USD 0.009300');
  });
  it('prices cache reads and writes at the cache prices; the rest of the input at the input price', () => {
    const parts = priceAiCall(sonnet, { input: 10_000n, output: 1000n, cacheRead: 6000n, cacheWrite: 2000n });
    expect(parts.map((p) => [p.meter, p.tokens])).toEqual([
      ['input', 2000n],
      ['cacheRead', 6000n],
      ['cacheWrite', 2000n],
      ['output', 1000n],
    ]);
    // 2000×3 + 6000×0.3 + 2000×3.75 + 1000×15 = 6000 + 1800 + 7500 + 15000 = 30300 → $0.0303
    expect(cost(parts).toString()).toBe('USD 0.030300');
  });
  it('prices cache writes at the input price when the model has no cache-write price (OpenAI)', () => {
    const mini = findAiPrice(version, 'openai', 'gpt-4o-mini')!;
    const parts = priceAiCall(mini, { input: 1000n, output: 0n, cacheRead: 400n, cacheWrite: 100n });
    expect(parts.map((p) => [p.meter, p.tokens])).toEqual([
      ['input', 500n],
      ['cacheRead', 400n],
      ['input', 100n],
    ]);
  });
  it('prices a whole prompt over the long-context threshold at that tier', () => {
    const haiku = findAiPrice(version, 'anthropic', 'claude-haiku-5-5')!;
    const under = priceAiCall(haiku, { input: 100_000n, output: 1000n, cacheRead: 0n, cacheWrite: 0n });
    const over = priceAiCall(haiku, { input: 100_001n, output: 1000n, cacheRead: 0n, cacheWrite: 0n });
    expect(cost(under).toString()).toBe('USD 0.010500'); // 100000×0.1 + 1000×0.5
    // 100001×0.5 + 1000×2.5 = 52500.5 per million = 0.0525005, a tie: half-even to the micro-unit keeps 0.052500
    expect(cost(over).toString()).toBe('USD 0.052500');
    expect(over[0]!.line.skuPriceId).toBe('anthropic:claude-haiku-5-5:long:input');
  });
  it('keeps cents of a cent: $0.0031 is not rounded away', () => {
    const mini = findAiPrice(version, 'openai', 'gpt-4o-mini')!;
    expect(cost(priceAiCall(mini, { input: 1200n, output: 380n, cacheRead: null, cacheWrite: null })).toString()).toBe(
      'USD 0.000408',
    );
  });
  it('sums calls exactly: Σ per-call costs = price × Σ tokens', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 2_000_000n }), { minLength: 1, maxLength: 40 }), (tokens) => {
        const input = sonnet.base.input!;
        const total = tokens.reduce((a, b) => a + b, 0n);
        const exact = input.unitPrice.times(Decimal.of(total)).divide('1000000', 12, 'halfEven');
        return tokensCost(input, Decimal.of(total)).toDecimal().equals(exact.round(6, 'halfEven'));
      }),
    );
  });
  it('expresses tokens in the pricing unit', () => {
    expect(pricingQuantity(sonnet.base.input!, Decimal.parse('2400000')).toString()).toBe('2.4');
  });
});

describe('the cache adjustment for events without cache tokens', () => {
  it('moves cache reads (cheaper) and writes (dearer) from the input price to the cache prices', () => {
    const sonnet = findAiPrice(version, 'anthropic', 'claude-sonnet-4-6')!;
    const parts = cacheAdjustment(sonnet, { cacheRead: 6000n, cacheWrite: 2000n });
    expect(parts.map((p) => [p.meter, p.unitPrice.toString(), p.tokens])).toEqual([
      ['cacheRead', '2.7', -6000n],
      ['cacheWrite', '0.75', 2000n],
    ]);
    // Input priced whole (10000×3 + 1000×15 = 45000) plus the adjustment (−6000×2.7 + 2000×0.75 = −14700) = 30300,
    // which is what the per-call pricing with cache tokens gives.
    const adj = parts.reduce((t, p) => t.plus(p.unitPrice.times(Decimal.of(p.tokens))), Decimal.ZERO);
    expect(Decimal.parse('45000').plus(adj).toString()).toBe('30300.00');
  });
});

describe('pricing a cluster', () => {
  const cpu = version.lines[0]!;
  it('splits capacity into allocated rows and idle that add up exactly to capacity × rate', () => {
    const p = priceCluster({
      resource: 'cpu',
      line: cpu,
      capacity: Decimal.parse('432.000000'),
      rows: [
        { key: 'a', allocated: Decimal.parse('1.492300') },
        { key: 'b', allocated: Decimal.parse('0.333333') },
      ],
    });
    expect(p.capacityCost!.toString()).toBe('USD 14.688000');
    expect(p.rows.map((r) => r.cost.toString())).toEqual(['USD 0.050738', 'USD 0.011333']);
    expect(p.idle!.quantity.toString()).toBe('430.174367');
    expect(Money.sum([...p.rows.map((r) => r.cost), p.idle!.cost]).equals(p.capacityCost!)).toBe(true);
    expect(p.warnings).toEqual([]);
  });
  it('keeps negative idle as it is, with a warning', () => {
    const p = priceCluster({
      resource: 'cpu',
      line: cpu,
      capacity: Decimal.parse('1'),
      rows: [{ key: 'a', allocated: Decimal.parse('2') }],
    });
    expect(p.idle!.quantity.toString()).toBe('-1');
    expect(p.idle!.cost.toString()).toBe('USD -0.034000');
    expect(p.warnings[0]).toMatch(/negative/);
  });
  it('has no idle without capacity (Docker, priced on usage)', () => {
    const p = priceCluster({
      resource: 'cpu',
      line: cpu,
      capacity: null,
      rows: [{ key: 'a', allocated: Decimal.parse('3.367212') }],
    });
    expect(p.idle).toBeNull();
    expect(p.rows[0]!.cost.toString()).toBe('USD 0.114485');
  });
  it('always adds up exactly, for any rows (property)', () => {
    const q = fc.bigInt({ min: 0n, max: 100_000_000_000n }).map((n) => Decimal.of(n, 6));
    fc.assert(
      fc.property(q, fc.array(q, { maxLength: 60 }), (capacity, rows) => {
        const p = priceCluster({
          resource: 'cpu',
          line: cpu,
          capacity,
          rows: rows.map((allocated, i) => ({ key: `${i}`, allocated })),
        });
        return Money.sum([...p.rows.map((r) => r.cost), p.idle!.cost], 'USD').equals(p.capacityCost!);
      }),
    );
  });
  it('turns claim GiB-hours into GB-months on 730 hours', () => {
    expect(gibHoursToGbMonths(Decimal.parse('730'), Decimal.parse('730')).toString()).toBe('1.073741824000');
  });
});
