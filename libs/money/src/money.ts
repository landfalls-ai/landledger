import { currency, type Currency } from './currency.js';
import { Decimal, type DecimalInput } from './decimal.js';
import { divRound, halfAwayFromZero, halfEven, pow10, type RoundingMode } from './rounding.js';
import type { Quantity, Rate } from './units.js';

/** Digits after the point in a stored amount: micro-units, for every currency (spec 001). */
export const MICRO_SCALE = 6;
/** Postgres `bigint` holds ±(2⁶³ − 1) micro-units: 9.2 trillion major units. */
export const MAX_MICROS = 2n ** 63n - 1n;

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Can't combine ${a} and ${b}: convert one with a dated FX rate first`);
    this.name = 'CurrencyMismatchError';
  }
}

export class MoneyOverflowError extends RangeError {
  constructor(micros: bigint) {
    super(`${micros} micro-units is outside Postgres bigint (±2⁶³ − 1)`);
    this.name = 'MoneyOverflowError';
  }
}

/** Money on the wire: the major-unit amount as a decimal string with six decimals, and the ISO 4217 code. */
export interface MoneyJson {
  amount: string;
  currency: string;
}

/**
 * An amount of money: an integer number of **micro-units** (10⁻⁶ of the major unit, for every currency) and its
 * ISO 4217 code. Immutable and exact. Adding, subtracting and splitting never round; a product (`fromProduct`) or a
 * conversion rounds once, half-even, to the micro-unit; posting or showing rounds half away from zero to the
 * currency's minor unit (`toMinor`, `format`). Money of different currencies never mixes.
 *
 * In Postgres: a `bigint` of micro-units (`*_micros`) and a `char(3)` code; postgres.js returns bigint as a string,
 * which `Money.ofMicros` takes.
 */
export class Money {
  private constructor(
    /** Integer micro-units (10⁻⁶ of the major unit). */
    readonly micros: bigint,
    readonly currency: string,
  ) {
    if (micros > MAX_MICROS || micros < -MAX_MICROS) throw new MoneyOverflowError(micros);
  }

  /** From micro-units: a bigint or a string of digits (`"-1250000"`, as Postgres returns a bigint). */
  static ofMicros(micros: bigint | string, code: string): Money {
    currency(code);
    if (typeof micros === 'string') {
      if (!/^-?\d+$/.test(micros))
        throw new SyntaxError(`Micro-units are whole numbers, got ${JSON.stringify(micros)}`);
      return new Money(BigInt(micros), code);
    }
    if (typeof micros !== 'bigint') throw new TypeError('Micro-units are a bigint or a string of digits');
    return new Money(micros, code);
  }

  static zero(code: string): Money {
    return Money.ofMicros(0n, code);
  }

  /**
   * From an amount in major units (`"1234.56"`, `"0.0031"`). More than six decimals is an error unless a rounding mode
   * is given: `Money.parse("0.0000005", "USD")` throws, `Money.parse("0.0000005", "USD", "halfEven")` is 0.
   */
  static parse(amount: DecimalInput, code: string, mode?: RoundingMode): Money {
    currency(code);
    const d = Decimal.from(amount);
    if (d.scale > MICRO_SCALE && !mode && !d.rescale(MICRO_SCALE, 'towardZero').equals(d))
      throw new RangeError(`${d.toString()} has more than ${MICRO_SCALE} decimals; pass a rounding mode`);
    return new Money(d.shiftToInteger(MICRO_SCALE, mode ?? 'towardZero'), code);
  }

  /** An exact decimal amount in major units, rounded half-even to the micro-unit (a computed amount). */
  static fromDecimal(amount: DecimalInput, code: string): Money {
    return Money.parse(amount, code, halfEven);
  }

  /**
   * `rate × quantity`, computed exactly and rounded once, half-even, to the micro-unit. The quantity is expressed in
   * the rate's unit first (`2400000 Tokens` at a price per `1000000 Tokens` is 2.4 × the price); a different base unit
   * is an error.
   */
  static fromProduct(rate: Rate, quantity: Quantity): Money {
    return Money.fromDecimal(rate.price.times(quantity.in(rate.unit).value), rate.currency);
  }

  static fromJSON(json: MoneyJson): Money {
    return Money.parse(json.amount, json.currency);
  }

  /** The total of a list; an empty list needs the currency. Exact, so the order never matters. */
  static sum(amounts: Iterable<Money>, code?: string): Money {
    let total: Money | null = code ? Money.zero(code) : null;
    for (const m of amounts) total = total ? total.plus(m) : m;
    if (!total) throw new RangeError('The sum of no amounts needs a currency');
    return total;
  }

  get currencyInfo(): Currency {
    return currency(this.currency);
  }

  private same(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  plus(other: Money): Money {
    this.same(other);
    return new Money(this.micros + other.micros, this.currency);
  }

  minus(other: Money): Money {
    this.same(other);
    return new Money(this.micros - other.micros, this.currency);
  }

  negate(): Money {
    return new Money(-this.micros, this.currency);
  }

  abs(): Money {
    return this.micros < 0n ? this.negate() : this;
  }

  /** See `split`. */
  split(weights: readonly DecimalInput[]): Money[] {
    return split(this, weights);
  }

  isZero(): boolean {
    return this.micros === 0n;
  }

  sign(): -1 | 0 | 1 {
    return this.micros === 0n ? 0 : this.micros < 0n ? -1 : 1;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.same(other);
    return this.micros === other.micros ? 0 : this.micros < other.micros ? -1 : 1;
  }

  equals(other: Money): boolean {
    return other.currency === this.currency && other.micros === this.micros;
  }

  /** The amount in the currency's minor units (cents for USD), rounded half away from zero: what is posted. */
  toMinor(): bigint {
    return divRound(this.micros, pow10(MICRO_SCALE - this.currencyInfo.exponent), halfAwayFromZero);
  }

  /** This amount rounded half away from zero to the minor unit, still as Money (`$0.0031` → `$0.00`). */
  posted(): Money {
    return new Money(this.toMinor() * pow10(MICRO_SCALE - this.currencyInfo.exponent), this.currency);
  }

  /** The exact amount in major units, six decimals (`0.003100`). */
  toDecimal(): Decimal {
    return Decimal.of(this.micros, MICRO_SCALE);
  }

  /** The posted amount in major units at the minor unit (`1234.57`, `-0.01`, `1200` for JPY). */
  toMinorDecimal(): Decimal {
    return Decimal.of(this.toMinor(), this.currencyInfo.exponent);
  }

  /** For a CSV of figures as shown: plain posted major units, `-` sign, no grouping (`-1234.50`). */
  toCsv(): string {
    return this.toMinorDecimal().toString();
  }

  /** `USD -0.003100`: exact and unambiguous, for logs and errors. */
  toString(): string {
    return `${this.currency} ${this.toDecimal().toString()}`;
  }

  toJSON(): MoneyJson {
    return { amount: this.toDecimal().toString(), currency: this.currency };
  }
}

/**
 * Splits an amount by weights so the parts always sum exactly to it (largest remainder): each part gets the floor of
 * its exact share in micro-units, and the micro-units left over go one each to the parts with the largest fractional
 * remainders, ties to the lowest index. A zero weight gets nothing. A negative amount splits like its absolute value,
 * negated. Weights are non-negative decimals (shares, core-hours, percentages) and not all zero.
 */
export function split(amount: Money, weights: readonly DecimalInput[]): Money[] {
  if (weights.length === 0) throw new RangeError('Split needs at least one weight');
  const ds = weights.map((w) => Decimal.from(w));
  if (ds.some((d) => d.isNegative())) throw new RangeError('Split weights are never negative');
  const scale = Math.max(...ds.map((d) => d.scale));
  const ws = ds.map((d) => d.rescale(scale, 'towardZero').coefficient);
  const sumW = ws.reduce((a, b) => a + b, 0n);
  if (sumW === 0n) throw new RangeError('Split weights must not all be zero');

  const negative = amount.micros < 0n;
  const t = negative ? -amount.micros : amount.micros;
  const parts = ws.map((w) => (t * w) / sumW);
  const order = ws.map((w, i) => ({ i, r: (t * w) % sumW }));
  let left = t - parts.reduce((a, b) => a + b, 0n);
  order.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of order) {
    if (left === 0n) break;
    parts[i]! += 1n;
    left -= 1n;
  }
  return parts.map((p) => Money.ofMicros(negative ? -p : p, amount.currency));
}

/** Splits an amount into `n` parts as equal as they can be (the first parts take the leftover micro-units). */
export function splitEvenly(amount: Money, n: number): Money[] {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('Split into one part or more');
  return split(
    amount,
    Array.from({ length: n }, () => 1n),
  );
}

/**
 * FOCUS's rounding variance tolerance for a total of `rows` rows: `MAX(100 × subunit, √rows × 0.5 × subunit)`
 * (`upstream/focus-spec/specification/appendix/rounding_variance_tolerance.md:9`). True when `difference` is within it.
 * Exact: compares squares in integers, no square root.
 */
export function withinFocusTolerance(difference: Money, rows: number): boolean {
  if (!Number.isSafeInteger(rows) || rows < 0) throw new RangeError('Rows is a whole number ≥ 0');
  const subunit = pow10(MICRO_SCALE - difference.currencyInfo.exponent); // micro-units per minor unit
  const d = difference.micros < 0n ? -difference.micros : difference.micros;
  if (d <= 100n * subunit) return true;
  // d ≤ √rows × subunit / 2  ⇔  (2d)² ≤ rows × subunit²
  return (2n * d) ** 2n <= BigInt(rows) * subunit ** 2n;
}
