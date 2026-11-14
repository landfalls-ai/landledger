/**
 * How a value between two representable ones is rounded. Landledger names two modes, each with one job (spec 001):
 *
 * - `halfEven` (banker's rounding) when a computed amount (price × quantity, an FX conversion) becomes micro-units:
 *   a tie goes to the even neighbour, so millions of rounded rows carry no upward bias (2.5 → 2, 3.5 → 4, −2.5 → −2).
 * - `halfAwayFromZero` when an amount is posted or shown at the currency's minor unit: what finance means by rounding,
 *   what Excel's `ROUND` and invoices do (2.5 → 3, −2.5 → −3).
 *
 * The others are for the few places that need them by definition: `towardZero` (truncation), `floor`, `ceiling`.
 */
export type RoundingMode = 'halfEven' | 'halfAwayFromZero' | 'towardZero' | 'floor' | 'ceiling';

export const halfEven = 'halfEven' satisfies RoundingMode;
export const halfAwayFromZero = 'halfAwayFromZero' satisfies RoundingMode;

export const ROUNDING_MODES: readonly RoundingMode[] = [
  'halfEven',
  'halfAwayFromZero',
  'towardZero',
  'floor',
  'ceiling',
];

/** `n / d` rounded to an integer by `mode`. Exact: bigints only. */
export function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
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
    case 'towardZero':
      return q;
    case 'floor':
      return sign < 0n ? q - 1n : q;
    case 'ceiling':
      return sign > 0n ? q + 1n : q;
    case 'halfAwayFromZero':
    case 'halfEven': {
      const twice = 2n * (r < 0n ? -r : r);
      if (twice < d) return q;
      if (twice > d) return q + sign;
      if (mode === 'halfAwayFromZero') return q + sign;
      return q % 2n === 0n ? q : q + sign;
    }
    default:
      throw new RangeError(`Unknown rounding mode: ${String(mode)}`);
  }
}

export const pow10 = (n: number): bigint => {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`Bad power of ten: ${n}`);
  return 10n ** BigInt(n);
};
