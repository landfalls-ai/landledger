/** Spec 007, pure parts: robust statistics in micro-units, the cost rule, and the approval patterns. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkCost, findSamePairs, findSplits, isFastRelay, mad, median } from '../src/anomalies.js';

const $ = (usd: number) => BigInt(Math.round(usd * 1_000_000));
const H = 3_600_000;

describe('robust statistics', () => {
  it('takes the median and MAD exactly, the even case half to even', () => {
    expect(median([$(1), $(3), $(2)])).toBe($(2));
    expect(median([1n, 2n])).toBe(2n); // 1.5 → 2 (even)
    expect(median([2n, 3n])).toBe(2n); // 2.5 → 2 (even)
    expect(median([])).toBe(0n);
    expect(mad([$(1), $(2), $(3), $(4), $(100)])).toBe($(1));
  });

  it('keeps the median between the smallest and largest value, and MAD ≥ 0 (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { minLength: 1, maxLength: 30 }), (xs) => {
        const m = median(xs);
        expect(m >= xs.reduce((a, b) => (b < a ? b : a))).toBe(true);
        expect(m <= xs.reduce((a, b) => (b > a ? b : a))).toBe(true);
        expect(mad(xs) >= 0n).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe('the cost rule', () => {
  const baseline = [4, 5, 6, 5, 4, 5, 6, 5, 4, 5].map($); // median $5, MAD $0.50

  it('flags a jump of 3.5 robust standard deviations, half the median and at least the minimum', () => {
    const c = checkCost(baseline, $(12), $(1));
    expect(c).toMatchObject({ anomalous: true, median: $(5), mad: $(0.5) });
    expect(c.score).toBe('9.44'); // 7 ÷ (1.4826 × 0.5)
  });

  it('lets the ordinary through: a small jump, a jump under half the median, too few days', () => {
    expect(checkCost(baseline, $(6), $(1)).anomalous).toBe(false); // score 1.35
    expect(checkCost(baseline, $(5.9), $(1)).reason).toBe('below the smallest jump');
    const big = [100, 101, 100, 99, 100, 100, 101].map($); // MAD $0, flat-ish
    expect(checkCost(big, $(140), $(1)).reason).toBe('less than half the median above it');
    expect(checkCost([$(1), $(1)], $(50), $(1)).reason).toBe(`2 observed days, 7 needed`);
  });

  it('counts any big enough jump over a flat baseline (MAD 0), new spend included', () => {
    const c = checkCost(Array(10).fill(0n), $(25), $(1));
    expect(c).toMatchObject({ anomalous: true, median: 0n, mad: 0n, score: null });
  });

  it('never flags a day at or below the median (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 10n ** 9n }), { minLength: 7, maxLength: 14 }), (xs) => {
        expect(checkCost(xs, median(xs), 1n).anomalous).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

describe('approval patterns', () => {
  const t0 = Date.parse('2026-11-10T09:00:00Z');
  it('finds a spend split under the threshold within 72 hours, once', () => {
    const rows = [
      { id: 'a', createdAt: t0, micros: $(200) },
      { id: 'b', createdAt: t0 + 5 * H, micros: $(200) },
      { id: 'c', createdAt: t0 + 30 * H, micros: $(150) },
      { id: 'd', createdAt: t0 + 200 * H, micros: $(400) },
    ];
    expect(findSplits(rows, $(500)).map((r) => r.map((x) => x.id))).toEqual([['a', 'b', 'c']]);
    // Together under the threshold: no split. One over it: it took a person anyway.
    expect(findSplits(rows.slice(0, 3), $(600))).toEqual([]);
    expect(findSplits([...rows.slice(0, 2), { id: 'x', createdAt: t0 + H, micros: $(900) }], $(500))).toEqual([]);
    // More than 72 hours apart: no split.
    expect(
      findSplits(
        rows.map((r, i) => ({ ...r, createdAt: t0 + i * 80 * H })),
        $(500),
      ),
    ).toEqual([]);
  });

  it('finds one approver for one requester: 5 or more decisions and 80% of them', () => {
    const d = (approver: string, requester = 'tal') => ({ approver, requester });
    const five = [d('shira'), d('shira'), d('shira'), d('shira'), d('shira'), d('yoav')];
    expect(findSamePairs(five).map((p) => [p.approver, p.rows.length, p.of])).toEqual([['shira', 5, 6]]);
    expect(findSamePairs([...five, d('yoav')])).toEqual([]); // 5 of 7 is 71%
    expect(findSamePairs(five.slice(0, 4))).toEqual([]); // 4 is too few
  });

  it('calls a relayed decision under 10 seconds after its card fast', () => {
    const card = new Date('2026-11-10T09:00:00Z');
    expect(isFastRelay(card, new Date(card.getTime() + 4_000))).toBe(true);
    expect(isFastRelay(card, new Date(card.getTime() + 10_000))).toBe(false);
    expect(isFastRelay(null, card)).toBe(false);
  });
});
