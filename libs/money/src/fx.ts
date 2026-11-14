import { currency } from './currency.js';
import { Decimal, type DecimalInput } from './decimal.js';
import { Money } from './money.js';
import { divRound, halfEven } from './rounding.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One unit of `base` is worth `rate` units of `quote` on `date` (a UTC day, `YYYY-MM-DD`). `id` names the recorded rate
 * (a row of `fx_rates`), so a converted figure can say which rate it used.
 */
export interface FxRate {
  id: string;
  base: string;
  quote: string;
  rate: Decimal;
  date: string;
}

/** Finds the rate for a pair on a day: the latest recorded rate for the latest date on or before it. */
export type FxLookup = (base: string, quote: string, date: string) => FxRate | undefined;

export class FxRateMissingError extends Error {
  constructor(base: string, quote: string, date: string) {
    super(`No ${base}→${quote} rate on or before ${date}`);
    this.name = 'FxRateMissingError';
  }
}

export function fxRate(input: { id: string; base: string; quote: string; rate: DecimalInput; date: string }): FxRate {
  currency(input.base);
  currency(input.quote);
  if (input.base === input.quote) throw new RangeError('An FX rate converts between two currencies');
  if (!DAY.test(input.date))
    throw new SyntaxError(`An FX rate's date is YYYY-MM-DD, got ${JSON.stringify(input.date)}`);
  const rate = Decimal.from(input.rate);
  if (rate.sign() <= 0) throw new RangeError('An FX rate is positive');
  return { id: input.id, base: input.base, quote: input.quote, rate, date: input.date };
}

export interface Converted {
  amount: Money;
  /** The recorded rate used; null when no conversion was needed (USD → USD). */
  rateId: string | null;
}

/**
 * Converts `amount` to `to` at the rate for `date`: the latest recorded rate for the latest date on or before it,
 * rounded half-even to the micro-unit. Refuses when there is none; never derives an inverse silently (that would need
 * a division and its own rounding: record the rate in the direction it is used). The same currency needs no rate.
 */
export function convert(amount: Money, to: string, date: string, lookup: FxLookup): Converted {
  currency(to);
  if (!DAY.test(date)) throw new SyntaxError(`A date is YYYY-MM-DD, got ${JSON.stringify(date)}`);
  if (amount.currency === to) return { amount, rateId: null };
  const rate = lookup(amount.currency, to, date);
  if (!rate) throw new FxRateMissingError(amount.currency, to, date);
  if (rate.base !== amount.currency || rate.quote !== to || rate.date > date)
    throw new RangeError(`Rate ${rate.id} doesn't convert ${amount.currency}→${to} on ${date}`);
  const micros = divRound(amount.micros * rate.rate.coefficient, 10n ** BigInt(rate.rate.scale), halfEven);
  return { amount: Money.ofMicros(micros, to), rateId: rate.id };
}

/**
 * Recorded FX rates in memory, in the order they were recorded (as `fx_rates` is append-only, a later row for the same
 * pair and date supersedes an earlier one). `lookup` is an `FxLookup` for `convert`.
 */
export class FxTable {
  private readonly byPair = new Map<string, FxRate[]>();

  constructor(rates: Iterable<FxRate> = []) {
    for (const r of rates) this.add(r);
  }

  add(rate: FxRate): void {
    const key = `${rate.base}/${rate.quote}`;
    const list = this.byPair.get(key) ?? [];
    list.push(rate);
    this.byPair.set(key, list);
  }

  readonly lookup: FxLookup = (base, quote, date) => {
    let found: FxRate | undefined;
    for (const r of this.byPair.get(`${base}/${quote}`) ?? [])
      if (r.date <= date && (!found || r.date >= found.date)) found = r;
    return found;
  };

  convert(amount: Money, to: string, date: string): Converted {
    return convert(amount, to, date, this.lookup);
  }
}
