import { Decimal, formatMoney, Money } from '@landledger/money';

/**
 * An amount from the API (a six-decimal string in USD) for people: `$1,234.56`; an amount under a cent that isn't zero
 * keeps four digits (`$0.0086`) so a small cost never reads as nothing. Exact: from the decimal string, never a float.
 */
export function usd(amount: string | null | undefined, options: { whole?: boolean } = {}): string {
  if (amount === null || amount === undefined) return '—';
  const m = Money.parse(amount, 'USD');
  const abs = m.abs().toDecimal();
  const tiny = !m.isZero() && abs.compare('0.01') < 0;
  return formatMoney(m, tiny ? { digits: 4 } : options.whole && abs.compare('1000') >= 0 ? { whole: true } : {});
}

/** A signed change, `+$12.30` or `-$4.00`. */
export const signed = (amount: string) => (Decimal.parse(amount).isNegative() ? usd(amount) : `+${usd(amount)}`);

/** A percent string from the API (`"12.5"`) as `12.5%`; a change as `+12.5%`. */
export const pct = (p: string | null | undefined, sign = false) =>
  p === null || p === undefined ? '—' : `${sign && !p.startsWith('-') && p !== '0.0' ? '+' : ''}${p}%`;

/** The change from `previous` to `now`, percent with one decimal, or null when there was nothing before. */
export function change(now: string, previous: string | null): string | null {
  if (previous === null) return null;
  const p = Decimal.parse(previous);
  if (p.isZero()) return null;
  return Decimal.parse(now).minus(p).times('100').divide(p, 1, 'halfEven').toString();
}

/** For charts only (geometry, never money): an amount as a number. */
export const num = (amount: string | null | undefined) => (amount ? Number(amount) : 0);

export const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });

export const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
