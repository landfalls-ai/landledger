/**
 * How a value that falls between two representable ones is rounded. Landledger's default is `half-even` (banker's
 * rounding): a tie goes to the even neighbour, so rounding many values carries no upward bias.
 *
 * - `half-even`: to the nearest; a tie to the even neighbour (2.5 → 2, 3.5 → 4, −2.5 → −2).
 * - `half-up`: to the nearest; a tie away from zero (2.5 → 3, −2.5 → −3). Commercial rounding.
 * - `half-down`: to the nearest; a tie toward zero (2.5 → 2, −2.5 → −2).
 * - `up`: away from zero (2.1 → 3, −2.1 → −3).
 * - `down`: toward zero, truncation (2.9 → 2, −2.9 → −2).
 * - `ceiling`: toward +∞ (2.1 → 3, −2.9 → −2).
 * - `floor`: toward −∞ (2.9 → 2, −2.1 → −3).
 */
export type RoundingMode = 'half-even' | 'half-up' | 'half-down' | 'up' | 'down' | 'ceiling' | 'floor';

export const DEFAULT_ROUNDING: RoundingMode = 'half-even';

export const ROUNDING_MODES: readonly RoundingMode[] = [
  'half-even',
  'half-up',
  'half-down',
  'up',
  'down',
  'ceiling',
  'floor',
];

/** `n / d` rounded to an integer by `mode`. Exact: bigints only. */
export function divRound(n: bigint, d: bigint, mode: RoundingMode = DEFAULT_ROUNDING): bigint {
  if (d === 0n) throw new RangeError('Division by zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d; // truncates toward zero
  const r = n % d; // carries the sign of n
  if (r === 0n) return q;
  const sign = n < 0n ? -1n : 1n;
  switch (mode) {
    case 'down':
      return q;
    case 'up':
      return q + sign;
    case 'floor':
      return sign < 0n ? q - 1n : q;
    case 'ceiling':
      return sign > 0n ? q + 1n : q;
    default: {
      const twice = 2n * (r < 0n ? -r : r);
      if (twice < d) return q;
      if (twice > d) return q + sign;
      if (mode === 'half-up') return q + sign;
      if (mode === 'half-down') return q;
      return q % 2n === 0n ? q : q + sign;
    }
  }
}

export const pow10 = (n: number): bigint => {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`Bad power of ten: ${n}`);
  return 10n ** BigInt(n);
};
