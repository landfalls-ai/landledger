import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal, divRound, Money, Quantity, Rate, ROUNDING_MODES, split, withinFocusTolerance } from '../src/index.js';

/** Money by property (spec 001, T005 and T006): whatever the amounts and weights, sums never drift. */

const RUNS = { numRuns: 500 };

/** Micro-units from tiny to near the bigint bound / 2^20 (so sums of a few hundred never overflow). */
const micros = fc.oneof(fc.bigInt({ min: -10_000n, max: 10_000n }), fc.bigInt({ min: -(2n ** 43n), max: 2n ** 43n }));
const code = fc.constantFrom('USD', 'EUR', 'JPY', 'BHD', 'ILS');
const money = fc.tuple(micros, code).map(([m, c]) => Money.ofMicros(m, c));
/** A non-negative decimal with up to 6 digits after the point (a weight, a quantity, a rate). */
const decimal = (max = 10n ** 12n) =>
  fc.tuple(fc.bigInt({ min: 0n, max }), fc.integer({ min: 0, max: 6 })).map(([c, s]) => Decimal.of(c, s));
const weights = fc.array(decimal(), { minLength: 1, maxLength: 12 }).filter((ws) => ws.some((w) => !w.isZero()));

describe('sums never drift', () => {
  it('a sum is the sum of its micro-units, in any order', () => {
    fc.assert(
      fc.property(fc.array(micros, { maxLength: 60 }), fc.integer(), (units, seed) => {
        const amounts = units.map((u) => Money.ofMicros(u, 'USD'));
        const expected = units.reduce((a, b) => a + b, 0n);
        const shuffled = [...amounts].sort(() => ((seed = (seed * 1103515245 + 12345) | 0) & 1 ? 1 : -1));
        expect(Money.sum(amounts, 'USD').micros).toBe(expected);
        expect(Money.sum(shuffled, 'USD').micros).toBe(expected);
      }),
      RUNS,
    );
  });

  it('a + b − b = a', () => {
    fc.assert(
      fc.property(micros, micros, (a, b) => {
        const x = Money.ofMicros(a, 'USD');
        expect(x.plus(Money.ofMicros(b, 'USD')).minus(Money.ofMicros(b, 'USD')).equals(x)).toBe(true);
      }),
      RUNS,
    );
  });

  it('a million $0.000001 rows are exactly a dollar (where floats drift)', () => {
    const micro = Money.parse('0.000001', 'USD');
    let total = Money.zero('USD');
    for (let i = 0; i < 1_000_000; i++) total = total.plus(micro);
    expect(total.toString()).toBe('USD 1.000000');
  });

  it('JSON round-trips exactly', () => {
    fc.assert(
      fc.property(money, (m) => {
        expect(Money.fromJSON(JSON.parse(JSON.stringify(m))).equals(m)).toBe(true);
        expect(Money.parse(m.toDecimal().toString(), m.currency).equals(m)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('split (T005)', () => {
  it('parts sum exactly to the whole, for any weights', () => {
    fc.assert(
      fc.property(money, weights, (m, ws) => {
        const parts = split(m, ws);
        expect(parts).toHaveLength(ws.length);
        expect(Money.sum(parts, m.currency).equals(m)).toBe(true);
      }),
      RUNS,
    );
  });

  it('is deterministic, gives zero weights nothing, and a single weight everything', () => {
    fc.assert(
      fc.property(money, weights, (m, ws) => {
        expect(split(m, ws).map((p) => p.micros)).toEqual(split(m, ws).map((p) => p.micros));
        split(m, ws).forEach((p, i) => {
          if (ws[i]!.isZero()) expect(p.isZero()).toBe(true);
        });
        expect(split(m, [ws.find((w) => !w.isZero())!])[0]!.equals(m)).toBe(true);
      }),
      RUNS,
    );
  });

  it('each part is within one micro-unit of its exact share, and has the amount’s sign', () => {
    fc.assert(
      fc.property(money, weights, (m, ws) => {
        const scale = Math.max(...ws.map((w) => w.scale));
        const cs = ws.map((w) => w.rescale(scale, 'towardZero').coefficient);
        const sum = cs.reduce((a, b) => a + b, 0n);
        split(m, ws).forEach((p, i) => {
          const exactFloor = divRound(m.micros * cs[i]!, sum, 'towardZero');
          const d = p.micros - exactFloor;
          expect(d === 0n || d === (m.micros < 0n ? -1n : 1n)).toBe(true);
          if (!p.isZero()) expect(p.sign()).toBe(m.sign());
        });
      }),
      RUNS,
    );
  });

  it('a negative amount splits as the negation of its absolute value', () => {
    fc.assert(
      fc.property(money, weights, (m, ws) => {
        expect(split(m.negate(), ws).map((p) => p.micros)).toEqual(split(m, ws).map((p) => -p.micros));
      }),
      RUNS,
    );
  });
});

describe('rounding', () => {
  it('every mode lands on a neighbour of the exact value', () => {
    fc.assert(
      fc.property(
        fc.bigInt(),
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.constantFrom(...ROUNDING_MODES),
        (n, d, mode) => {
          const q = divRound(n, d, mode);
          expect(q * d <= n + d && q * d >= n - d).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it('half-even and half away from zero are symmetric around zero', () => {
    fc.assert(
      fc.property(fc.bigInt(), fc.bigInt({ min: 1n, max: 10n ** 9n }), (n, d) => {
        expect(divRound(-n, d, 'halfEven')).toBe(-divRound(n, d, 'halfEven'));
        expect(divRound(-n, d, 'halfAwayFromZero')).toBe(-divRound(n, d, 'halfAwayFromZero'));
      }),
      RUNS,
    );
  });

  it('a product is within half a micro-unit of the exact value', () => {
    fc.assert(
      fc.property(decimal(10n ** 6n), decimal(10n ** 6n), (price, qty) => {
        const exact = price.times(qty);
        const m = Money.fromProduct(Rate.of(price, 'USD', 'Core-Hours'), Quantity.of(qty, 'Core-Hours'));
        const diff = m.toDecimal().minus(exact).abs();
        expect(diff.compare('0.0000005')).toBeLessThanOrEqual(0);
      }),
      RUNS,
    );
  });
});

describe('FOCUS tolerance (T006)', () => {
  /** Rows as computed (micro-units, any sign); compare Σ round(row) with round(Σ row), both at the minor unit. */
  const rowsArb = (maxLength: number) =>
    fc.array(fc.bigInt({ min: -(10n ** 10n), max: 10n ** 10n }), { minLength: 1, maxLength });

  it('rounding each row then summing stays within MAX(100 × subunit, √rows × 0.5 × subunit)', () => {
    fc.assert(
      fc.property(rowsArb(200), code, (rows, c) => {
        const ms = rows.map((r) => Money.ofMicros(r, c));
        const sumOfPosted = Money.sum(
          ms.map((m) => m.posted()),
          c,
        );
        const postedSum = Money.sum(ms, c).posted();
        expect(withinFocusTolerance(sumOfPosted.minus(postedSum), rows.length)).toBe(true);
      }),
      RUNS,
    );
  });

  // Past 200 rows the √rows term is a statistical bound (each row's rounding error is uniform, the sum a random walk),
  // so this is one fixed-seed day rather than a property. Landledger itself sums micro-units and rounds once.
  it('holds for a day of 100,000 AI rows under a cent each (fixed seed)', () => {
    let seed = 20261114;
    const next = () => {
      // mulberry32: integer-only, so the sequence is the same everywhere.
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t ^ (t >>> 14)) >>> 0;
    };
    const rows = Array.from({ length: 100_000 }, () => Money.ofMicros(BigInt(next() % 50_000), 'USD'));
    const diff = Money.sum(rows.map((r) => r.posted())).minus(Money.sum(rows).posted());
    expect(withinFocusTolerance(diff, rows.length)).toBe(true);
  });
});

describe('square root (wave 3: forecast bands)', () => {
  it('is the largest value at its scale whose square is at most the input', () => {
    fc.assert(
      fc.property(decimal(10n ** 30n), fc.integer({ min: 0, max: 12 }), (d, scale) => {
        const r = d.sqrt(scale);
        expect(r.scale).toBe(scale);
        expect(r.times(r).compare(d)).toBeLessThanOrEqual(0);
        const next = r.plus(Decimal.of(1n, scale));
        expect(next.times(next).compare(d)).toBe(1);
      }),
      RUNS,
    );
  });

  it('is exact on perfect squares and refuses negatives', () => {
    expect(Decimal.parse('2.25').sqrt(2).toString()).toBe('1.50');
    expect(Decimal.parse('144').sqrt(0).toString()).toBe('12');
    expect(Decimal.parse('2').sqrt(6).toString()).toBe('1.414213');
    expect(Decimal.ZERO.sqrt(3).toString()).toBe('0.000');
    expect(() => Decimal.parse('-1').sqrt(2)).toThrow(RangeError);
  });
});
