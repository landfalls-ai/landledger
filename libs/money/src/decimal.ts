import { DEFAULT_ROUNDING, divRound, pow10, type RoundingMode } from './rounding.js';

/** What a Decimal can be made from. A JavaScript number only when it is a safe integer: a float is refused. */
export type DecimalInput = Decimal | string | bigint | number;

const PATTERN = /^([+-])?(\d+)(?:\.(\d+))?$/;
/** Generous for rates and quantities; refuses input that would make bigint arithmetic absurdly slow. */
const MAX_DIGITS = 60;

/**
 * An exact decimal: an integer coefficient and a scale (the value is `coefficient / 10^scale`). Immutable. Used for
 * rates, quantities and FX rates; money itself is `Money` (integer minor units). No floating point anywhere.
 *
 * Postgres `numeric` values arrive as strings, so `Decimal.from(row.price)` is exact.
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
    if (!Number.isInteger(scale) || scale < 0)
      throw new RangeError(`A decimal's scale is a whole number ≥ 0, got ${scale}`);
    return new Decimal(coefficient, scale);
  }

  /** Parses `"12"`, `"-0.034"`, `"+1.50"`; keeps the scale written (`"1.50"` has scale 2). No exponents, no commas. */
  static parse(text: string): Decimal {
    const m = PATTERN.exec(text.trim());
    if (!m) throw new SyntaxError(`Not a decimal number: ${JSON.stringify(text)}`);
    const [, sign, whole, frac = ''] = m;
    if (whole!.length + frac.length > MAX_DIGITS) throw new RangeError(`Too many digits: ${text.length}`);
    const coefficient = BigInt(whole! + frac);
    return new Decimal(sign === '-' ? -coefficient : coefficient, frac.length);
  }

  static from(value: DecimalInput): Decimal {
    if (value instanceof Decimal) return value;
    if (typeof value === 'string') return Decimal.parse(value);
    if (typeof value === 'bigint') return new Decimal(value, 0);
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value))
        throw new TypeError(`Floats are not money: pass ${value} as a string (e.g. "${value}")`);
      return new Decimal(BigInt(value), 0);
    }
    throw new TypeError(`Not a decimal: ${String(value)}`);
  }

  /** This value with `scale` digits after the point, rounded by `mode` when that drops digits. */
  rescale(scale: number, mode: RoundingMode = DEFAULT_ROUNDING): Decimal {
    if (scale === this.scale) return this;
    if (scale > this.scale) return Decimal.of(this.coefficient * pow10(scale - this.scale), scale);
    return Decimal.of(divRound(this.coefficient, pow10(this.scale - scale), mode), scale);
  }

  /** At most `scale` digits after the point, rounded by `mode`; a value with fewer digits is returned as it is. */
  round(scale: number, mode: RoundingMode = DEFAULT_ROUNDING): Decimal {
    return scale >= this.scale ? this : this.rescale(scale, mode);
  }

  /** The integer `this × 10^shift`, rounded by `mode`: e.g. dollars → cents with `shift = 2`. */
  shiftToInteger(shift: number, mode: RoundingMode = DEFAULT_ROUNDING): bigint {
    if (shift >= this.scale) return this.coefficient * pow10(shift - this.scale);
    return divRound(this.coefficient, pow10(this.scale - shift), mode);
  }

  plus(other: DecimalInput): Decimal {
    const o = Decimal.from(other);
    const scale = Math.max(this.scale, o.scale);
    return Decimal.of(this.rescale(scale).coefficient + o.rescale(scale).coefficient, scale);
  }

  minus(other: DecimalInput): Decimal {
    return this.plus(Decimal.from(other).negate());
  }

  /** Exact: the scales add. */
  times(other: DecimalInput): Decimal {
    const o = Decimal.from(other);
    return Decimal.of(this.coefficient * o.coefficient, this.scale + o.scale);
  }

  /** `this / divisor` to `scale` digits, rounded by `mode` (the only inexact operation, so it asks how to round). */
  dividedBy(divisor: DecimalInput, scale: number, mode: RoundingMode = DEFAULT_ROUNDING): Decimal {
    const d = Decimal.from(divisor);
    if (d.isZero()) throw new RangeError('Division by zero');
    // (a / 10^sa) / (b / 10^sb) = (a × 10^sb) / (b × 10^sa); then × 10^scale.
    const n = this.coefficient * pow10(d.scale + scale);
    const den = d.coefficient * pow10(this.scale);
    return Decimal.of(divRound(n, den, mode), scale);
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
    const a = this.rescale(scale).coefficient;
    const b = o.rescale(scale).coefficient;
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

  /** Plain notation with exactly `scale` digits after the point: `"-0.0340"`. */
  toString(): string {
    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient).toString().padStart(this.scale + 1, '0');
    const whole = digits.slice(0, digits.length - this.scale);
    const frac = digits.slice(digits.length - this.scale);
    return `${negative ? '-' : ''}${whole}${this.scale ? `.${frac}` : ''}`;
  }

  /** `toString()` rounded or padded to `scale` digits. */
  toFixed(scale: number, mode: RoundingMode = DEFAULT_ROUNDING): string {
    return this.rescale(scale, mode).toString();
  }

  /** JSON carries decimals as strings, so nothing on the way turns them into floats. */
  toJSON(): string {
    return this.toString();
  }
}
