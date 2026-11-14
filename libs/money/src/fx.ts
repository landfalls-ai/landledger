import { currency } from './currency.js';
import { Decimal, type DecimalInput } from './decimal.js';
import { Money } from './money.js';
import { DEFAULT_ROUNDING, type RoundingMode } from './rounding.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** One unit of `base` is worth `rate` units of `quote` on `date` (a calendar day, `YYYY-MM-DD`), per `source`. */
export interface FxRate {
  base: string;
  quote: string;
  rate: Decimal;
  date: string;
  source: string;
}

export class FxRateMissingError extends Error {
  constructor(base: string, quote: string, date: string) {
    super(`No ${base}→${quote} rate on or before ${date}`);
    this.name = 'FxRateMissingError';
  }
}

export function fxRate(input: {
  base: string;
  quote: string;
  rate: DecimalInput;
  date: string;
  source: string;
}): FxRate {
  currency(input.base);
  currency(input.quote);
  if (!DAY.test(input.date))
    throw new SyntaxError(`An FX rate's date is YYYY-MM-DD, got ${JSON.stringify(input.date)}`);
  const rate = Decimal.from(input.rate);
  if (rate.sign() <= 0) throw new RangeError('An FX rate is positive');
  return { base: input.base, quote: input.quote, rate, date: input.date, source: input.source };
}

/**
 * Converts money with a dated rate, rounding once to the quote currency's minor unit (half-even unless told
 * otherwise). The rate's base must be the money's currency: an inverse is never derived silently, because it would
 * need a division and its own rounding; record the rate in the direction it is used.
 */
export function convert(money: Money, rate: FxRate, mode: RoundingMode = DEFAULT_ROUNDING): Money {
  if (money.currency !== rate.base) throw new RangeError(`The rate converts ${rate.base}, not ${money.currency}`);
  return Money.fromDecimal(money.toDecimal().times(rate.rate), rate.quote, mode);
}

/**
 * The FX rates Landledger holds, and which applies on a day: the latest one dated on or before it, for that pair.
 * Converting a currency to itself needs no rate.
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
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    this.byPair.set(key, list);
  }

  rateOn(base: string, quote: string, date: string): FxRate {
    if (!DAY.test(date)) throw new SyntaxError(`A date is YYYY-MM-DD, got ${JSON.stringify(date)}`);
    if (base === quote) return fxRate({ base, quote, rate: 1, date, source: 'identity' });
    const list = this.byPair.get(`${base}/${quote}`) ?? [];
    let found: FxRate | undefined;
    for (const r of list) if (r.date <= date) found = r;
    if (!found) throw new FxRateMissingError(base, quote, date);
    return found;
  }

  convert(money: Money, quote: string, date: string, mode: RoundingMode = DEFAULT_ROUNDING): Money {
    if (money.currency === quote) return money;
    return convert(money, this.rateOn(money.currency, quote, date), mode);
  }
}
