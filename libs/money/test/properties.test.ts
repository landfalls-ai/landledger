import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocate, Decimal, divRound, fxRate, convert, Money, Rate, ROUNDING_MODES } from '../src/index.js';

/**
 * Money by property: whatever the amounts, weights and rates, sums never drift and allocations always total.
 * docs/plan.md, "How we check it".
 */

const RUNS = { numRuns: 500 };

/** Minor units from small to far beyond 2^53. */
const minor = fc.oneof(fc.bigInt({ min: -10_000n, max: 10_000n }), fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }));
const code = fc.constantFrom('USD', 'EUR', 'JPY', 'KWD', 'ILS');
const money = fc.tuple(minor, code).map(([m, c]) => Money.ofMinor(m, c));
/** A non-negative decimal with up to 6 digits after the point (a weight, a quantity, a rate). */
const decimal = (max = 10n ** 12n) =>
  fc.tuple(fc.bigInt({ min: 0n, max }), fc.integer({ min: 0, max: 6 })).map(([c, s]) => Decimal.of(c, s));
const weights = fc.array(decimal(), { minLength: 1, maxLength: 12 }).filter((ws) => ws.some((w) => !w.isZero()));
const mode = fc.constantFrom(...ROUNDING_MODES);

describe('sums never drift', () => {
  it('a sum of Money equals the sum of its minor units, in any order', () => {
    fc.assert(
      fc.property(fc.array(minor, { maxLength: 60 }), (units) => {
        const amounts = units.map((u) => Money.ofMinor(u, 'USD'));
        const expected = units.reduce((a, b) => a + b, 0n);
        expect(Money.sum(amounts, 'USD').minor).toBe(expected);
        expect(Money.sum([...amounts].reverse(), 'USD').minor).toBe(expected);
      }),
      RUNS,
    );
  });

  it('adding then subtracting gives back the start', () => {
    fc.assert(
      fc.property(minor, minor, (a, b) => {
        const x = Money.ofMinor(a, 'USD');
        const y = Money.ofMinor(b, 'USD');
        expect(x.plus(y).minus(y).equals(x)).toBe(true);
      }),
      RUNS,
    );
  });

  it('ten thousand cents are a hundred dollars (where floats drift)', () => {
    const cents = Array.from({ length: 10_000 }, () => Money.parse('0.01', 'USD'));
    expect(Money.sum(cents).toCsv()).toBe('100.00');
  });

  it('CSV and JSON round-trip exactly', () => {
    fc.assert(
      fc.property(money, (m) => {
        expect(Money.parse(m.toCsv(), m.currency).equals(m)).toBe(true);
        expect(Money.fromJSON(JSON.parse(JSON.stringify(m))).equals(m)).toBe(true);
      }),
      RUNS,
    );
  });

  it('a Decimal round-trips through its string', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), fc.integer({ min: 0, max: 20 }), (c, s) => {
        const d = Decimal.of(c, s);
        const back = Decimal.parse(d.toString());
        expect(back.coefficient).toBe(c);
        expect(back.scale).toBe(s);
      }),
      RUNS,
    );
  });

  it('decimal addition is exact (associative and commutative)', () => {
    fc.assert(
      fc.property(decimal(), decimal(), decimal(), (a, b, c) => {
        expect(
          a
            .plus(b)
            .plus(c)
            .equals(a.plus(b.plus(c))),
        ).toBe(true);
        expect(a.plus(b).equals(b.plus(a))).toBe(true);
        expect(a.plus(b).minus(b).equals(a)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('allocations always total', () => {
  it('the parts sum to the whole, for any amount and weights', () => {
    fc.assert(
      fc.property(money, weights, (total, ws) => {
        const parts = allocate(total, ws);
        expect(parts).toHaveLength(ws.length);
        expect(Money.sum(parts, total.currency).equals(total)).toBe(true);
      }),
      RUNS,
    );
  });

  it('each part is within one minor unit of its exact share, with the sign of the whole', () => {
    fc.assert(
      fc.property(money, weights, (total, ws) => {
        const parts = allocate(total, ws);
        const scale = Math.max(...ws.map((w) => w.scale));
        const w = ws.map((d) => d.rescale(scale).coefficient);
        const sumW = w.reduce((a, b) => a + b, 0n);
        parts.forEach((p, i) => {
          // |p × W − T × w_i| < W, i.e. |p − T·w_i/W| < 1 unit.
          const diff = p.minor * sumW - total.minor * w[i]!;
          expect(diff < 0n ? -diff : diff).toBeLessThan(sumW);
          if (w[i] === 0n) expect(p.isZero()).toBe(true);
          if (total.minor > 0n) expect(p.isNegative()).toBe(false);
          if (total.minor < 0n) expect(p.isPositive()).toBe(false);
        });
      }),
      RUNS,
    );
  });

  it('is deterministic, and scaling every weight changes nothing', () => {
    fc.assert(
      fc.property(money, weights, fc.integer({ min: 1, max: 1000 }), (total, ws, k) => {
        const a = allocate(total, ws).map((p) => p.minor);
        const b = allocate(
          total,
          ws.map((w) => w.times(k)),
        ).map((p) => p.minor);
        expect(b).toEqual(a);
        expect(allocate(total, ws).map((p) => p.minor)).toEqual(a);
      }),
      RUNS,
    );
  });

  it('allocating then allocating each part again still totals (nested splits)', () => {
    fc.assert(
      fc.property(money, weights, weights, (total, outer, inner) => {
        const leaves = allocate(total, outer).flatMap((part) => allocate(part, inner));
        expect(Money.sum(leaves, total.currency).equals(total)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('pricing and rounding', () => {
  it('quantity × rate rounds once: within half a unit (nearest modes) or one unit (directed modes)', () => {
    fc.assert(
      fc.property(decimal(10n ** 9n), decimal(10n ** 6n), mode, (q, r, m) => {
        const rate = Rate.of(r, 'USD');
        const cost = rate.cost(q, m);
        // exact cost in cents = q × r × 100; error = cost − exact, scaled to the exact value's own scale.
        const exact = rate.exactCost(q).times(100);
        const err = Decimal.of(cost.minor).minus(exact).abs();
        expect(err.compare(m.startsWith('half') ? '0.5' : '1')).toBeLessThanOrEqual(m.startsWith('half') ? 0 : -1);
      }),
      RUNS,
    );
  });

  it('half-even sends a tie to the even neighbour', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), (k) => {
        // (2k + 1) / 2 is always a tie between k and k + 1 (or k and k − 1 when negative).
        const r = divRound(2n * k + 1n, 2n, 'half-even');
        expect(r % 2n).toBe(0n);
        const d = 2n * r - (2n * k + 1n);
        expect(d === 1n || d === -1n).toBe(true);
      }),
      RUNS,
    );
  });

  it('pricing records one by one drifts from pricing the total by at most half a cent per record', () => {
    fc.assert(
      fc.property(fc.array(decimal(10n ** 7n), { minLength: 1, maxLength: 40 }), decimal(10n ** 5n), (qs, r) => {
        const rate = Rate.of(r, 'USD');
        const each = Money.sum(
          qs.map((q) => rate.cost(q)),
          'USD',
        );
        const whole = rate.cost(qs.reduce((a, b) => a.plus(b), Decimal.ZERO));
        const gap = each.minus(whole).abs().minor;
        // Each record's rounding is at most ½ cent; the total's is at most ½; so the gap is ≤ (n + 1) / 2 cents.
        expect(gap * 2n).toBeLessThanOrEqual(BigInt(qs.length + 1));
      }),
      RUNS,
    );
  });

  it('an FX rate of one changes no amount', () => {
    fc.assert(
      fc.property(minor, (m) => {
        const eur = Money.ofMinor(m, 'EUR');
        const one = fxRate({ base: 'EUR', quote: 'USD', rate: '1', date: '2026-11-01', source: 't' });
        expect(convert(eur, one).minor).toBe(m);
      }),
      RUNS,
    );
  });
});
