/** Spec 006 by property: the band always holds its median, never dips below what is spent, and widens with time. */
import { Decimal, Money } from '@landledger/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { band, halfWidth, sampleVariance } from '../src/forecast.js';

const usd = (micros: bigint) => Money.ofMicros(micros, 'USD');
const RUNS = { numRuns: 300 };
const day = fc.bigInt({ min: 0n, max: 5_000_000_000n });
const days = fc.array(day, { minLength: 0, maxLength: 7 });

describe('the forecast band (property)', () => {
  it('P10 ≤ P50 ≤ P90, and P10 is never below month to date', () => {
    fc.assert(
      fc.property(
        fc.array(days, { minLength: 1, maxLength: 3 }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: 31 }),
        (sources, mtd, ahead, left) => {
          const hw = halfWidth(
            sources.map((s) => s.map(usd)),
            Decimal.of(BigInt(left)),
          );
          const b = band(usd(mtd + ahead), hw, usd(mtd));
          expect(b.p10.compare(b.p50)).toBeLessThanOrEqual(0);
          expect(b.p50.compare(b.p90)).toBeLessThanOrEqual(0);
          expect(b.p10.compare(usd(mtd))).toBeGreaterThanOrEqual(0);
          expect(hw.sign()).toBeGreaterThanOrEqual(0);
        },
      ),
      RUNS,
    );
  });

  it('widens with the days left (√days) and is zero when the days never vary', () => {
    fc.assert(
      fc.property(fc.array(day, { minLength: 2, maxLength: 7 }), fc.integer({ min: 1, max: 30 }), (costs, n) => {
        const a = halfWidth([costs.map(usd)], Decimal.of(BigInt(n)));
        const b = halfWidth([costs.map(usd)], Decimal.of(BigInt(n + 1)));
        expect(a.compare(b)).toBeLessThanOrEqual(0);
      }),
      RUNS,
    );
    expect(halfWidth([[usd(5_000_000n), usd(5_000_000n), usd(5_000_000n)]], Decimal.of(20n)).isZero()).toBe(true);
    expect(halfWidth([[usd(5_000_000n)]], Decimal.of(20n)).isZero()).toBe(true); // one day: no spread to measure
  });

  it('takes the sample variance exactly: days of $1, $2, $3 vary by 1 USD²; 16 days left gives 1.2816 × 1 × 4', () => {
    expect(sampleVariance([usd(1_000_000n), usd(2_000_000n), usd(3_000_000n)]).toString()).toBe('1.000000000000');
    expect(halfWidth([[usd(1_000_000n), usd(2_000_000n), usd(3_000_000n)]], Decimal.of(16n)).toString()).toBe(
      usd(5_126_400n).toString(),
    );
    // Two sources add their variances: σ = √2, 1.2816 × 1.41421356 = 1.812456.
    expect(
      halfWidth(
        [
          [usd(1_000_000n), usd(2_000_000n), usd(3_000_000n)],
          [usd(1_000_000n), usd(2_000_000n), usd(3_000_000n)],
        ],
        Decimal.of(1n),
      ).toString(),
    ).toBe(usd(1_812_456n).toString());
  });
});
