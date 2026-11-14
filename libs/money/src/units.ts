import { currency } from './currency.js';
import { Decimal, type DecimalInput } from './decimal.js';

/**
 * A unit in FOCUS Unit Format: an optional leading count and a base unit (`Tokens`, `1000000 Tokens`, `Core-Hours`,
 * `GiB-Hours`, `GB-Months`, `GB`). A price per `1000000 Tokens` applies to a quantity in `Tokens` divided by a million.
 */
export interface Unit {
  /** The leading count (1 when none is written). */
  count: bigint;
  /** The unit after the count. */
  base: string;
}

const UNIT = /^(?:([1-9]\d*) )?([A-Za-z][A-Za-z0-9]*(?:[-/][A-Za-z][A-Za-z0-9]*)*)$/;

export function parseUnit(unit: string): Unit {
  const m = UNIT.exec(unit);
  if (!m) throw new SyntaxError(`Not a FOCUS unit: ${JSON.stringify(unit)} (e.g. "Core-Hours", "1000000 Tokens")`);
  return { count: m[1] ? BigInt(m[1]) : 1n, base: m[2]! };
}

export const isUnit = (unit: string): boolean => UNIT.test(unit);

export class UnitMismatchError extends Error {
  constructor(from: string, to: string) {
    super(`Can't express ${from} in ${to}: different units`);
    this.name = 'UnitMismatchError';
  }
}

/** An exact quantity in a unit (`2400000 Tokens`, `1.25 Core-Hours`). Quantities may be negative (a reversal). */
export class Quantity {
  private constructor(
    readonly value: Decimal,
    readonly unit: string,
  ) {}

  static of(value: DecimalInput, unit: string): Quantity {
    parseUnit(unit);
    return new Quantity(Decimal.from(value), unit);
  }

  /**
   * The same quantity in another unit with the same base: `2400000 Tokens` in `1000000 Tokens` is `2.4`. Exact, or an
   * error (the counts are whole numbers, so dividing by a power of ten always is).
   */
  in(unit: string): Quantity {
    if (unit === this.unit) return this;
    const from = parseUnit(this.unit);
    const to = parseUnit(unit);
    if (from.base !== to.base) throw new UnitMismatchError(this.unit, unit);
    return new Quantity(this.value.times(from.count).divideExactly(to.count), unit);
  }

  negate(): Quantity {
    return new Quantity(this.value.negate(), this.unit);
  }

  toString(): string {
    return `${this.value.toString()} ${this.unit}`;
  }

  toJSON(): { value: string; unit: string } {
    return { value: this.value.toString(), unit: this.unit };
  }
}

/**
 * A unit price: an exact decimal of a currency's major units per one pricing unit (USD 0.034 per `Core-Hours`, USD 3
 * per `1000000 Tokens`). Rates keep every digit they are written with; only the amount they produce is rounded, once,
 * to micro-units (`Money.fromProduct`).
 */
export class Rate {
  private constructor(
    readonly price: Decimal,
    readonly currency: string,
    readonly unit: string,
  ) {}

  static of(price: DecimalInput, code: string, unit: string): Rate {
    currency(code);
    parseUnit(unit);
    const p = Decimal.from(price);
    if (p.isNegative()) throw new RangeError('A rate is never negative');
    return new Rate(p, code, unit);
  }

  toString(): string {
    return `${this.currency} ${this.price.toString()} per ${this.unit}`;
  }

  toJSON(): { price: string; currency: string; unit: string } {
    return { price: this.price.toString(), currency: this.currency, unit: this.unit };
  }
}
