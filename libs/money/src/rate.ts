import { currency } from './currency.js';
import { Decimal, type DecimalInput } from './decimal.js';
import { Money } from './money.js';
import { DEFAULT_ROUNDING, type RoundingMode } from './rounding.js';

/**
 * A unit price: an exact decimal amount of a currency's major units per one unit of something (USD 0.034 per
 * vCPU-hour). Rates keep every digit they are written with; only the cost they produce is rounded, once, to minor
 * units. In Postgres a rate is `numeric` (which postgres.js returns as a string, exactly).
 */
export class Rate {
  private constructor(
    /** Major units per unit (`0.034`). */
    readonly price: Decimal,
    readonly currency: string,
    /** What one unit is (`vCPU-hour`, `GiB-hour`, `GB-month`, `1M tokens`); informational. */
    readonly unit: string | null,
  ) {}

  static of(price: DecimalInput, code: string, unit: string | null = null): Rate {
    currency(code);
    const p = Decimal.from(price);
    if (p.isNegative()) throw new RangeError('A rate is never negative');
    return new Rate(p, code, unit);
  }

  /**
   * The cost of `quantity` units: `quantity × price`, computed exactly and rounded once to the currency's minor unit
   * by `mode` (half-even by default). Price each record once and add the Money; adding rounded costs never drifts.
   */
  cost(quantity: DecimalInput, mode: RoundingMode = DEFAULT_ROUNDING): Money {
    return Money.fromDecimal(Decimal.from(quantity).times(this.price), this.currency, mode);
  }

  /** The exact, unrounded cost (for evidence and tests): `quantity × price` in major units. */
  exactCost(quantity: DecimalInput): Decimal {
    return Decimal.from(quantity).times(this.price);
  }

  toString(): string {
    return `${this.currency} ${this.price.toString()}${this.unit ? ` per ${this.unit}` : ''}`;
  }

  toJSON(): { price: string; currency: string; unit: string | null } {
    return { price: this.price.toString(), currency: this.currency, unit: this.unit };
  }
}

/** `quantity × rate`, rounded once to minor units (half-even unless told otherwise). */
export function price(quantity: DecimalInput, rate: Rate, mode: RoundingMode = DEFAULT_ROUNDING): Money {
  return rate.cost(quantity, mode);
}
