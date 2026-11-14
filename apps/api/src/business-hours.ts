/**
 * Deadlines in business hours (spec 004, review of wave 2): a business day counts all 24 hours of its local day in
 * LANDLEDGER_TZ, other days (and holidays) none. LANDLEDGER_BUSINESS_DAYS says which weekdays count (`sun-thu` on this
 * machine, a default to confirm), LANDLEDGER_HOLIDAYS_FILE lists dates that never count, and
 * LANDLEDGER_STEP_DEADLINE_HOURS how many hours a step waits (default 24). With `UTC` and Monday to Friday, a step that
 * starts on Friday at 15:00 with 24 business hours is due on Monday at 15:00.
 */
import { existsSync, readFileSync } from 'node:fs';

const HOUR_MS = 3_600_000;

export interface BusinessCalendar {
  /** Weekdays that count, 0 Sunday … 6 Saturday, in `timeZone`. */
  days: readonly number[];
  /** An IANA time zone (`Asia/Jerusalem`); `UTC` by default. */
  timeZone?: string;
  /** Local dates (`YYYY-MM-DD`) that never count. */
  holidays?: ReadonlySet<string>;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The local date, weekday and seconds since local midnight of an instant in a time zone. */
export function localParts(ms: number, timeZone: string): { date: string; weekday: number; secondOfDay: number } {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS.indexOf(parts.weekday!),
    secondOfDay: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
  };
}

/** The instant the local day after `ms` starts (DST days are 23 or 25 hours long). */
function nextLocalMidnight(ms: number, timeZone: string): number {
  const here = localParts(ms, timeZone);
  let t = ms - (ms % 1000) + (86_400 - here.secondOfDay) * 1000;
  // Land on 00:00 of the next local date, whatever the offset did in between.
  for (let i = 0; i < 4; i++) {
    const p = localParts(t, timeZone);
    if (p.date !== here.date && p.secondOfDay === 0) return t;
    if (p.date === here.date) t += (86_400 - p.secondOfDay) * 1000;
    else t -= p.secondOfDay * 1000;
  }
  return t;
}

export function addBusinessHours(start: Date, hours: number, calendar: BusinessCalendar | readonly number[]): Date {
  const cal: BusinessCalendar = Array.isArray(calendar) ? { days: calendar } : (calendar as BusinessCalendar);
  if (!cal.days.length) throw new Error('No business days');
  const timeZone = cal.timeZone ?? 'UTC';
  const holidays = cal.holidays ?? new Set<string>();
  let t = start.getTime();
  let left = hours * HOUR_MS;
  for (let guard = 0; left > 0 && guard < 10_000; guard++) {
    const p = localParts(t, timeZone);
    const midnight = nextLocalMidnight(t, timeZone);
    if (!cal.days.includes(p.weekday) || holidays.has(p.date)) {
      t = midnight;
      continue;
    }
    const step = Math.min(left, midnight - t);
    t += step;
    left -= step;
  }
  return new Date(t);
}

/** Holidays from a file: one `YYYY-MM-DD` per line, `#` comments; a missing file is no holidays. */
export function readHolidays(path: string | null): Set<string> {
  if (!path || !existsSync(path)) return new Set();
  const out = new Set<string>();
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(line)) throw new Error(`${path}: "${line}" is not a date (YYYY-MM-DD)`);
    out.add(line);
  }
  return out;
}
