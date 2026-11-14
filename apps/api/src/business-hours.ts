/**
 * Deadlines in business hours (spec 004): a business day counts all 24 of its UTC hours, other days none. A step that
 * starts on Friday at 15:00 with 24 business hours is due on Monday at 15:00. LANDLEDGER_BUSINESS_DAYS says which days
 * count (default Monday to Friday) and LANDLEDGER_STEP_DEADLINE_HOURS how many hours a step waits (default 24).
 */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function addBusinessHours(start: Date, hours: number, businessDays: readonly number[]): Date {
  if (!businessDays.length) throw new Error('No business days');
  let t = start.getTime();
  let left = hours * HOUR_MS;
  // Move off a non-business day to the next business day's midnight.
  const isBusiness = (ms: number) => businessDays.includes(new Date(ms).getUTCDay());
  const midnightAfter = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS + DAY_MS;
  for (let guard = 0; left > 0 && guard < 10_000; guard++) {
    if (!isBusiness(t)) {
      t = midnightAfter(t);
      continue;
    }
    const step = Math.min(left, midnightAfter(t) - t);
    t += step;
    left -= step;
  }
  return new Date(t);
}
