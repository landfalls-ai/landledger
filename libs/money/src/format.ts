import { Decimal, type DecimalInput } from './decimal.js';
import type { Money } from './money.js';

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
  /** Show no minor units (`$1,235`, rounded half-even): for headline figures. Default false. */
  whole?: boolean;
}

/**
 * For people: en-US grouping and the currency's symbol, every minor digit (`$1,234.50`, `-$12.00`, `¥1,200`).
 * Exact: the digits come from the integer minor units, never a float (Intl formats a decimal string exactly).
 */
export function formatMoney(money: Money, options: FormatOptions = {}): string {
  const digits = options.whole ? 0 : money.currencyInfo.exponent;
  const value = money.toDecimal().toFixed(digits, 'half-even');
  return formatter(money.currency, digits, options.display ?? 'symbol').format(value as `${number}`);
}

/** For a CSV or a spreadsheet: plain major units, `.` as the point, no grouping (`-1234.50`). Same as `toCsv()`. */
export function formatMoneyCsv(money: Money): string {
  return money.toCsv();
}

/**
 * A rate or quantity for people: grouped, every digit it was written with, at least `minDigits` after the point
 * (`0.0045`, `1,250.5`, `0.10` with minDigits 2).
 */
export function formatDecimal(value: DecimalInput, minDigits = 0): string {
  const d = Decimal.from(value);
  return group(d.scale < minDigits ? d.rescale(minDigits).toString() : d.toString());
}
