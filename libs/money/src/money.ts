import { currency, type Currency } from './currency.js';
import { Decimal, type DecimalInput } from './decimal.js';
import { DEFAULT_ROUNDING, divRound, type RoundingMode } from './rounding.js';

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Can't combine ${a} and ${b}: convert one with a dated FX rate first`);
    this.name = 'CurrencyMismatchError';
  }
}

/** Money as the API and the database carry it: minor units as a string (bigint-safe) and the ISO 4217 code. */
export interface MoneyJson {
  amountMinor: string;
  currency: string;
}

/**
 * An amount of money: an integer number of minor units (cents for USD) and its ISO 4217 currency. Immutable and exact:
 * adding, subtracting and allocating never round; multiplying by a rate rounds once, by an explicit mode (half-even
 * unless told otherwise). Money of different currencies never mixes: convert with an FX rate first.
 *
 * In Postgres: `bigint` minor units and `char(3)` currency (postgres.js returns bigint columns as strings; pass them to
 * `Money.ofMinor`).
 */
export class Money {
  private constructor(
    /** Integer minor units (cents for USD). */
    readonly minor: bigint,
    readonly currency: string,
  ) {}

  /** From minor units: a bigint, a safe-integer number or a string of digits (`"-1250"`). */
  static ofMinor(minor: bigint | number | string, code: string): Money {
    currency(code);
    if (typeof minor === 'number' && !Number.isSafeInteger(minor))
      throw new TypeError(`Minor units are whole numbers, got ${minor}`);
    if (typeof minor === 'string' && !/^[+-]?\d+$/.test(minor))
      throw new SyntaxError(`Minor units are whole numbers, got ${JSON.stringify(minor)}`);
    return new Money(BigInt(minor), code);
  }

  static zero(code: string): Money {
    return Money.ofMinor(0n, code);
  }

  /**
   * From an amount in major units (`"1234.56"` USD). More digits than the currency's minor unit is an error unless a
   * rounding mode is given: `Money.parse("0.125", "USD")` throws, `Money.parse("0.125", "USD", "half-even")` is $0.12.
   */
  static parse(amount: DecimalInput, code: string, mode?: RoundingMode): Money {
    const { exponent } = currency(code);
    const d = Decimal.from(amount);
    if (d.scale > exponent && !mode && !d.rescale(exponent, 'down').equals(d))
      throw new RangeError(`${d.toString()} has more digits than ${code} allows (${exponent}); pass a rounding mode`);
    return new Money(d.shiftToInteger(exponent, mode ?? 'down'), code);
  }

  /** A decimal amount in major units rounded to minor units (half-even unless told otherwise). */
  static fromDecimal(amount: DecimalInput, code: string, mode: RoundingMode = DEFAULT_ROUNDING): Money {
    return Money.parse(amount, code, mode);
  }

  static fromJSON(json: MoneyJson): Money {
    return Money.ofMinor(json.amountMinor, json.currency);
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
    return new Money(this.minor + other.minor, this.currency);
  }

  minus(other: Money): Money {
    this.same(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  abs(): Money {
    return this.minor < 0n ? this.negate() : this;
  }

  /** This amount × a factor (a quantity, a percentage as a decimal), rounded once to minor units. */
  times(factor: DecimalInput, mode: RoundingMode = DEFAULT_ROUNDING): Money {
    const f = Decimal.from(factor);
    return new Money(divRound(this.minor * f.coefficient, 10n ** BigInt(f.scale), mode), this.currency);
  }

  /**
   * Splits this amount by weights so the parts always sum to the whole (largest remainder): each part gets the floor
   * of its exact share, and the units left over go one each to the parts with the largest remainders (ties to the
   * earlier part). A zero weight gets nothing. Weights are non-negative decimals (shares, vCPU-hours, percentages).
   */
  allocate(weights: readonly DecimalInput[]): Money[] {
    return allocate(this, weights);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.same(other);
    return this.minor === other.minor ? 0 : this.minor < other.minor ? -1 : 1;
  }

  equals(other: Money): boolean {
    return other.currency === this.currency && other.minor === this.minor;
  }

  /** The amount in major units, exactly (`12.30` for 1230 cents). */
  toDecimal(): Decimal {
    return Decimal.of(this.minor, this.currencyInfo.exponent);
  }

  /** For a spreadsheet or a CSV: plain major units, a `-` sign, `.` as the point, no grouping (`-1234.50`). */
  toCsv(): string {
    return this.toDecimal().toString();
  }

  /** `USD -1234.50`: unambiguous, for logs and errors. */
  toString(): string {
    return `${this.currency} ${this.toCsv()}`;
  }

  toJSON(): MoneyJson {
    return { amountMinor: this.minor.toString(), currency: this.currency };
  }
}

/** See `Money.allocate`. */
export function allocate(total: Money, weights: readonly DecimalInput[]): Money[] {
  if (weights.length === 0) throw new RangeError('Allocate needs at least one weight');
  const ds = weights.map((w) => Decimal.from(w));
  if (ds.some((d) => d.isNegative())) throw new RangeError('Allocation weights are never negative');
  const scale = Math.max(...ds.map((d) => d.scale));
  const ws = ds.map((d) => d.rescale(scale).coefficient);
  const sumW = ws.reduce((a, b) => a + b, 0n);
  if (sumW === 0n) throw new RangeError('Allocation weights must not all be zero');

  const negative = total.minor < 0n;
  const t = negative ? -total.minor : total.minor;
  const parts = ws.map((w) => (t * w) / sumW);
  const remainders = ws.map((w, i) => ({ i, r: (t * w) % sumW }));
  let left = t - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left === 0n) break;
    parts[i]! += 1n;
    left -= 1n;
  }
  return parts.map((p) => Money.ofMinor(negative ? -p : p, total.currency));
}

/** Splits an amount into `n` parts as equal as they can be (the first parts take the leftover units). */
export function allocateEvenly(total: Money, n: number): Money[] {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('Split into one part or more');
  return allocate(
    total,
    Array.from({ length: n }, () => 1),
  );
}
