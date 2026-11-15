/**
 * The cost of named services over a window (wave 4, spec 019), for Landflow's flow that writes an incident's cost into
 * Landfall's postmortem. The ledger is daily: each day's cost is taken by the share of the day inside the window, exact
 * to the micro-unit, and the answer is always labelled `estimated`. Today's figure is what has accrued so far, so its
 * share is of the hours elapsed, not of the whole day.
 */
import type { CostWindowView } from '@landledger/contracts';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import { ApiError } from './errors.js';
import { amount, type Spend } from './spend.js';

const DAY_MS = 86_400_000;
const USD = REPORTING_CURRENCY;

/** Each UTC day the window touches, and how much of it (ms) lies inside, against how much of it counts (ms). */
export function windowDays(fromMs: number, toMs: number, nowMs: number): { day: string; inside: number; of: number }[] {
  const out: { day: string; inside: number; of: number }[] = [];
  for (let start = Math.floor(fromMs / DAY_MS) * DAY_MS; start < toMs; start += DAY_MS) {
    const end = start + DAY_MS;
    // A day still running counts only the hours elapsed: its cost so far is for them.
    const counted = Math.max(0, Math.min(end, nowMs) - start);
    const inside = Math.max(0, Math.min(end, toMs, nowMs) - Math.max(start, fromMs));
    if (counted > 0) out.push({ day: new Date(start).toISOString().slice(0, 10), inside, of: counted });
  }
  return out;
}

const serviceOf = (tags: Record<string, unknown>, serviceName: string) =>
  (typeof tags.service === 'string' && tags.service) || serviceName;

export async function costWindow(
  spend: Spend,
  q: { services: string[]; from: string; to: string },
  now: () => Date,
): Promise<CostWindowView> {
  const fromMs = Date.parse(q.from);
  const toMs = Date.parse(q.to);
  if (!(toMs > fromMs)) throw new ApiError('bad_request', '`to` is after `from`');
  if (toMs - fromMs > 31 * DAY_MS) throw new ApiError('bad_request', 'At most 31 days at a time');
  const days = windowDays(fromMs, toMs, now().getTime());
  const wanted = new Map(q.services.map((s) => [s.toLowerCase(), s]));
  const perDay = new Map<string, Map<string, Money>>(); // service → day → cost
  const seen = new Set<string>();
  if (days.length) {
    const { lines } = await spend.lines({ from: days[0]!.day, to: days.at(-1)!.day });
    for (const l of lines) {
      const name = wanted.get(serviceOf(l.tags, l.serviceName).toLowerCase());
      if (!name) continue;
      seen.add(name);
      const m = perDay.get(name) ?? new Map<string, Money>();
      m.set(l.day, (m.get(l.day) ?? Money.zero(USD)).plus(l.amount));
      perDay.set(name, m);
    }
  }
  let total = Money.zero(USD);
  const services = q.services.map((service) => {
    let sum = Money.zero(USD);
    const rows = days.map((d) => {
      const dayCost = perDay.get(service)?.get(d.day) ?? Money.zero(USD);
      const share = Decimal.parse(String(d.inside)).divide(String(d.of), 6, 'halfEven').toFixed(6, 'halfEven');
      const part =
        d.inside === d.of
          ? dayCost
          : Money.fromDecimal(dayCost.toDecimal().times(String(d.inside)).divide(String(d.of), 6, 'halfEven'), USD);
      sum = sum.plus(part);
      return { day: d.day, dayCost: amount(dayCost), share, amount: amount(part) };
    });
    total = total.plus(sum);
    return { service, known: seen.has(service), amount: amount(sum), days: rows };
  });
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    currency: USD,
    basis: 'estimated',
    method:
      "Each UTC day's cost of the service (the ledger by charge day, and today's provisional figures) times the share of the day inside the window; today counts only the hours elapsed. Estimated: never an invoiced figure.",
    total: amount(total),
    services,
  };
}
