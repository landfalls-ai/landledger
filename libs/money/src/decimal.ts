import { divRound, pow10, type RoundingMode } from './rounding.js';

/**
 * What a Decimal is made from: a decimal string (`"0.034"`, as JSON and Postgres `numeric` carry it), a bigint, or a
 * Decimal. A JavaScript `number` is not accepted, so passing one is a type error; JSON numbers are parsed from their
 * text by the caller, never through a float.
 */
export type DecimalInput = Decimal | string | bigint;

/** Digits after the point a parsed decimal may carry (spec 001: scale up to 18). Products may carry more. */
export const MAX_SCALE = 18;
const PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;
/** Refuses input that would make bigint arithmetic absurdly slow. */
const MAX_DIGITS = 60;

/**
 * An exact decimal: an integer coefficient and a scale (`coefficient / 10^scale`). Immutable. Used for rates,
 * quantities and FX rates; money itself is `Money` (integer micro-units). No floating point anywhere: only `divide`
 * can be inexact, and it asks for a scale and a rounding mode.
 */
export class Decimal {
  private constructor(
    /** The integer coefficient. */
    readonly coefficient: bigint,
    /** Digits after the point (≥ 0). */
    readonly scale: number,
  ) {}

  static readonly ZERO = new Decimal(0n, 0);
  static readonly ONE = new Decimal(1n, 0);

  static of(coefficient: bigint, scale = 0): Decimal {
    if (typeof coefficient !== 'bigint') throw new TypeError('A decimal coefficient is a bigint');
    if (!Number.isInteger(scale) || scale < 0)
      throw new RangeError(`A decimal's scale is a whole number ≥ 0, got ${scale}`);
    return new Decimal(coefficient, scale);
  }

  /**
   * Parses plain decimal notation: `"12"`, `"-0.034"`, `"1.50"` (the scale written is kept). Refused: exponents
   * (`"1e-3"`), `NaN`, `Infinity`, an empty string, a `+` sign, commas, more than 18 digits after the point.
   */
  static parse(text: string): Decimal {
    if (typeof text !== 'string') throw new TypeError(`Not a decimal string: ${String(text)}`);
    const m = PATTERN.exec(text);
    if (!m) throw new SyntaxError(`Not a plain decimal number: ${JSON.stringify(text)}`);
    const [, sign, whole, frac = ''] = m;
    if (frac.length > MAX_SCALE) throw new RangeError(`More than ${MAX_SCALE} digits after the point: ${text}`);
    if (whole!.length + frac.length > MAX_DIGITS) throw new RangeError(`Too many digits: ${text.length}`);
    const coefficient = BigInt(whole! + frac);
    return new Decimal(sign === '-' ? -coefficient : coefficient, frac.length);
  }

  static from(value: DecimalInput): Decimal {
    if (value instanceof Decimal) return value;
    if (typeof value === 'string') return Decimal.parse(value);
    if (typeof value === 'bigint') return new Decimal(value, 0);
    throw new TypeError(
      typeof value === 'number'
        ? `Numbers are not exact: pass ${String(value)} as a decimal string`
        : `Not a decimal: ${String(value)}`,
    );
  }

  /** This value with `scale` digits after the point, rounded by `mode` when that drops digits. */
  rescale(scale: number, mode: RoundingMode): Decimal {
    if (scale === this.scale) return this;
    if (scale > this.scale) return Decimal.of(this.coefficient * pow10(scale - this.scale), scale);
    return Decimal.of(divRound(this.coefficient, pow10(this.scale - scale), mode), scale);
  }

  /** At most `scale` digits after the point, rounded by `mode`; fewer digits are kept as they are. */
  round(scale: number, mode: RoundingMode): Decimal {
    return scale >= this.scale ? this : this.rescale(scale, mode);
  }

  /** The integer `this × 10^shift`, rounded by `mode`: e.g. dollars → micro-dollars with `shift = 6`. */
  shiftToInteger(shift: number, mode: RoundingMode): bigint {
    if (shift >= this.scale) return this.coefficient * pow10(shift - this.scale);
    return divRound(this.coefficient, pow10(this.scale - shift), mode);
  }

  plus(other: DecimalInput): Decimal {
    const o = Decimal.from(other);
    const scale = Math.max(this.scale, o.scale);
    return Decimal.of(this.up(scale) + o.up(scale), scale);
  }

  minus(other: DecimalInput): Decimal {
    return this.plus(Decimal.from(other).negate());
  }

  /** Exact: the scales add. */
  times(other: DecimalInput): Decimal {
    const o = Decimal.from(other);
    return Decimal.of(this.coefficient * o.coefficient, this.scale + o.scale);
  }

  /** `this / divisor` to `scale` digits, rounded by `mode`: the only inexact operation, so it asks how to round. */
  divide(divisor: DecimalInput, scale: number, mode: RoundingMode): Decimal {
    const d = Decimal.from(divisor);
    if (d.isZero()) throw new RangeError('Division by zero');
    // (a / 10^sa) / (b / 10^sb) = (a × 10^sb) / (b × 10^sa); then × 10^scale.
    const n = this.coefficient * pow10(d.scale + scale);
    const den = d.coefficient * pow10(this.scale);
    return Decimal.of(divRound(n, den, mode), scale);
  }

  /** `this / divisor` when it is exact at some scale up to `MAX_SCALE`; otherwise an error. */
  divideExactly(divisor: DecimalInput): Decimal {
    const d = Decimal.from(divisor);
    const q = this.divide(d, MAX_SCALE, 'towardZero');
    if (!q.times(d).equals(this)) throw new RangeError(`${this.toString()} / ${d.toString()} is not exact`);
    return q.normalize();
  }

  /**
   * The square root to `scale` digits, rounded toward zero (the largest value whose square is ≤ this one): exact
   * integer arithmetic, used for a forecast band's standard deviation. A negative value is an error.
   */
  sqrt(scale: number): Decimal {
    if (this.coefficient < 0n) throw new RangeError(`No square root of ${this.toString()}`);
    if (!Number.isInteger(scale) || scale < 0) throw new RangeError(`A scale is a whole number ≥ 0, got ${scale}`);
    // √(c / 10^s) × 10^k = √(c × 10^(2k − s)): work at k' ≥ s / 2 so the power is whole, then drop digits.
    const k = Math.max(scale, Math.ceil(this.scale / 2));
    const root = isqrt(this.coefficient * pow10(2 * k - this.scale));
    return Decimal.of(root, k).rescale(scale, 'towardZero');
  }

  negate(): Decimal {
    return Decimal.of(-this.coefficient, this.scale);
  }

  abs(): Decimal {
    return this.coefficient < 0n ? this.negate() : this;
  }

  sign(): -1 | 0 | 1 {
    return this.coefficient === 0n ? 0 : this.coefficient < 0n ? -1 : 1;
  }

  isZero(): boolean {
    return this.coefficient === 0n;
  }

  isNegative(): boolean {
    return this.coefficient < 0n;
  }

  compare(other: DecimalInput): -1 | 0 | 1 {
    const o = Decimal.from(other);
    const scale = Math.max(this.scale, o.scale);
    const a = this.up(scale);
    const b = o.up(scale);
    return a === b ? 0 : a < b ? -1 : 1;
  }

  equals(other: DecimalInput): boolean {
    return this.compare(other) === 0;
  }

  /** Drops trailing zeros after the point: `1.500` → `1.5`, `2.00` → `2`. */
  normalize(): Decimal {
    let { coefficient, scale } = this;
    while (scale > 0 && coefficient % 10n === 0n) {
      coefficient /= 10n;
      scale--;
    }
    return Decimal.of(coefficient, scale);
  }

  /** FOCUS numeric format: plain notation, `-` only, exactly `scale` digits after the point (`"-0.0340"`). */
  toString(): string {
    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient).toString().padStart(this.scale + 1, '0');
    const whole = digits.slice(0, digits.length - this.scale);
    const frac = digits.slice(digits.length - this.scale);
    return `${negative ? '-' : ''}${whole}${this.scale ? `.${frac}` : ''}`;
  }

  /** `toString()` rounded or padded to `scale` digits. */
  toFixed(scale: number, mode: RoundingMode): string {
    return this.rescale(scale, mode).toString();
  }

  /** JSON carries decimals as strings, so nothing on the way turns them into floats. */
  toJSON(): string {
    return this.toString();
  }

  /** The coefficient at a larger or equal scale (exact). */
  private up(scale: number): bigint {
    return this.coefficient * pow10(scale - this.scale);
  }
}

/** ⌊√n⌋ for n ≥ 0, by Newton's method on bigints. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  // Start above the root (2^⌈bits/2⌉), so Newton's steps fall to it.
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  return x;
}
