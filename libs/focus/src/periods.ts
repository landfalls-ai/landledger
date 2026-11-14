/** UTC days and months as FOCUS date/times. */

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const MONTH = /^(\d{4})-(\d{2})$/;

/** Is `value` a FOCUS date/time (`YYYY-MM-DDTHH:mm:ssZ`, UTC) that names a real instant? */
export function isDateTime(value: string): boolean {
  const m = DATE_TIME.exec(value);
  if (!m) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value.slice(0, 19));
}

export const isUtcDayStart = (value: string): boolean => isDateTime(value) && value.endsWith('T00:00:00Z');
export const isUtcMonthStart = (value: string): boolean => isUtcDayStart(value) && value.slice(8, 10) === '01';

/** The month (`YYYY-MM`) a date/time falls in. */
export const monthOf = (value: string): string => value.slice(0, 7);

/** The first instant of a month: `2026-11` → `2026-11-01T00:00:00Z`. */
export function monthStart(month: string): string {
  if (!MONTH.test(month)) throw new SyntaxError(`A month is YYYY-MM, got ${JSON.stringify(month)}`);
  return `${month}-01T00:00:00Z`;
}

/** The month after: `2026-12` → `2027-01`. */
export function nextMonth(month: string): string {
  const m = MONTH.exec(month);
  if (!m) throw new SyntaxError(`A month is YYYY-MM, got ${JSON.stringify(month)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return mo === 12 ? `${y + 1}-01` : `${m[1]}-${String(mo + 1).padStart(2, '0')}`;
}

/** The billing period of a month, as the record's start and end (exclusive). */
export function billingPeriod(month: string): { BillingPeriodStart: string; BillingPeriodEnd: string } {
  return { BillingPeriodStart: monthStart(month), BillingPeriodEnd: monthStart(nextMonth(month)) };
}

/** A UTC day's charge period: `2026-10-30` → 30 October 00:00Z to 31 October 00:00Z. */
export function dayPeriod(day: string): { ChargePeriodStart: string; ChargePeriodEnd: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new SyntaxError(`A day is YYYY-MM-DD, got ${JSON.stringify(day)}`);
  const start = new Date(`${day}T00:00:00Z`);
  const end = new Date(start.getTime() + 86_400_000);
  return { ChargePeriodStart: `${day}T00:00:00Z`, ChargePeriodEnd: end.toISOString().replace(/\.\d{3}Z$/, 'Z') };
}
