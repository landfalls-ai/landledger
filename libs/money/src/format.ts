import { Decimal, type DecimalInput } from './decimal.js';
import type { Money } from './money.js';
import { halfAwayFromZero } from './rounding.js';

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(code: string, digits: number, display: 'symbol' | 'code'): Intl.NumberFormat {
  const key = `${code}:${digits}:${display}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      currencyDisplay: display === 'code' ? 'code' : 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    formatters.set(key, f);
  }
  return f;
}

/** Groups the digits of a plain decimal string in threes with commas (`-1234567.5` → `-1,234,567.5`). */
function group(plain: string): string {
  const negative = plain.startsWith('-');
  const [whole, frac] = (negative ? plain.slice(1) : plain).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac === undefined ? '' : `.${frac}`}`;
}

export interface FormatOptions {
  /** `$1,234.56` (default) or `USD 1,234.56`. */
  display?: 'symbol' | 'code';
  /** No minor digits (`$1,235`): for headline figures. Default false. */
  whole?: boolean;
  /** Digits after the point instead of the currency's minor unit, e.g. 4 to show `$0.0031`. */
  digits?: number;
}

/**
 * For people: en-US grouping and the currency's symbol, rounded half away from zero to the minor unit (`$1,234.50`,
 * `-$12.00`, `¥1,200`), or to `digits`. Exact: Intl formats the decimal string, never a float.
 */
export function formatMoney(money: Money, options: FormatOptions = {}): string {
  const digits = options.whole ? 0 : (options.digits ?? money.currencyInfo.exponent);
  const value = money.toDecimal().toFixed(digits, halfAwayFromZero);
  return formatter(money.currency, digits, options.display ?? 'symbol').format(value as `${number}`);
}

/**
 * A rate or quantity for people: grouped, every digit it was written with, at least `minDigits` after the point
 * (`0.0045`, `1,250.5`, `0.10` with minDigits 2).
 */
export function formatDecimal(value: DecimalInput, minDigits = 0): string {
  const d = Decimal.from(value);
  return group(d.scale < minDigits ? d.rescale(minDigits, 'towardZero').toString() : d.toString());
}
