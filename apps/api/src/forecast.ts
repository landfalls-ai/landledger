/**
 * Forecasts (spec 006): the band around the run rate, from how much the days vary; what approved requests hold beyond
 * it (reservations and commitments); what contracts hold; the year ahead. One formula, for Overview and the year ahead
 * alike (review of wave 3):
 *
 *   forecast = month to date + run rate P50 for the days left + reserved (net) + committed (net) + contracted
 *
 * A request's reservation or commitment is netted against what the run rate already projects of it: its matched cost
 * above its baseline over the last seven full days, a day, × the days left. An open-ended request already running is
 * then counted once, by the run rate, and only what it has yet to ramp to is added. Contracted: each real contract's
 * annual value ÷ 12 a month over its term, pro rata by day. Exact decimals throughout: the band's square roots are
 * integer square roots.
 */
import type { ForecastMonth, ForecastView } from '@landledger/contracts';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import { day, type Sql } from './db.js';
import { addsInMonth, lineMatches, selectorOf } from './reservations.js';
import { addDays, addMonths, amount, monthDays, type RunRate, type Spend, stateOf } from './spend.js';

const USD = REPORTING_CURRENCY;
const zero = () => Money.zero(USD);
/** z for the 90th percentile of a normal distribution: P10 and P90 sit this many σ either side of P50. */
export const Z90 = '1.2816';

/** The sample variance of a list of daily costs, in USD² (exact to 12 places); zero with fewer than two days. */
export function sampleVariance(costs: readonly Money[]): Decimal {
  if (costs.length < 2) return Decimal.ZERO;
  const xs = costs.map((c) => c.toDecimal());
  const mean = xs.reduce((a, b) => a.plus(b), Decimal.ZERO).divide(String(costs.length), 12, 'halfEven');
  const ss = xs.reduce((a, x) => {
    const d = x.minus(mean);
    return a.plus(d.times(d));
  }, Decimal.ZERO);
  return ss.divide(String(costs.length - 1), 12, 'halfEven');
}

/**
 * The band's half-width over `days` days: z₀.₉ × σ × √days, σ² = Σ each source's sample variance of its full days'
 * cost (sources vary independently). Rounded half-even to the micro-unit.
 */
export function halfWidth(fullDayCosts: ReadonlyArray<readonly Money[]>, days: Decimal): Money {
  if (days.sign() <= 0) return zero();
  const variance = fullDayCosts.reduce((a, c) => a.plus(sampleVariance(c)), Decimal.ZERO);
  const sigma = variance.sqrt(9);
  return Money.fromDecimal(Decimal.parse(Z90).times(sigma).times(days.sqrt(9)).round(6, 'halfEven'), USD);
}

/** P10, P50 and P90 around a central figure; P10 never below what is already spent. */
export function band(p50: Money, hw: Money, floor: Money): { p10: Money; p50: Money; p90: Money } {
  const low = p50.minus(hw);
  return { p10: low.compare(floor) < 0 ? floor : low, p50, p90: p50.plus(hw) };
}

export interface Commitment {
  requestId: string;
  number: string;
  title: string;
  costCenter: string;
  /** The amount it adds in the month (pro rata from `from`), beyond any reservation it holds there, less what the run
   * rate already projects of it. */
  amount: Money;
  /** Before netting. */
  gross: Money;
  monthly: Money;
  reservedThrough: string | null;
}

interface CommitRow {
  id: string;
  number: number;
  title: string;
  cost_center: string;
  amount_micros: string;
  currency: string;
  recurrence: 'monthly' | 'once';
  start_day: Date;
  end_day: Date | null;
  status: string;
  evidence: Record<string, unknown>;
  months: Date[] | null;
}

/** Days from `from` to `to` inclusive (0 when `from` is after `to`). */
const daysIn = (from: string, to: string) =>
  from > to ? 0 : Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/**
 * What each approved request already adds to the run rate, a day: its matched cost (its `match` selector, on its cost
 * center) over the seven full days before today, a day, above the baseline its reservation took at approval; never
 * below zero. A request with no selector, or no baseline, adds nothing measurable: nothing is netted for it.
 */
export async function runningIncrements(sql: Sql, spend: Spend, today: string): Promise<Map<string, Money>> {
  const rows = await sql<
    { id: string; cost_center: string; evidence: Record<string, unknown>; baseline: string | null }[]
  >`
    SELECT r.id, r.cost_center, r.evidence,
           (SELECT v.baseline_daily_micros::text FROM reservations v WHERE v.request_id = r.id
              AND v.baseline_daily_micros IS NOT NULL ORDER BY v.created_at DESC LIMIT 1) AS baseline
    FROM requests r WHERE r.status IN ('approved', 'applied') AND r.kind <> 'contract'`;
  const out = new Map<string, Money>();
  const measurable = rows.filter((r) => r.baseline !== null && selectorOf(r.evidence));
  if (!measurable.length) return out;
  const { lines } = await spend.lines({ from: addDays(today, -7), to: addDays(today, -1) }, false);
  for (const r of measurable) {
    const sel = selectorOf(r.evidence)!;
    const matched = Money.sum(
      lines.filter((l) => !l.correction && lineMatches(l, r.cost_center, sel)).map((l) => l.amount),
      USD,
    );
    const perDay = Money.fromDecimal(matched.toDecimal().divide('7', 6, 'halfEven'), USD).minus(
      Money.ofMicros(r.baseline!, USD),
    );
    if (perDay.sign() > 0) out.set(r.id, perDay);
  }
  return out;
}

/**
 * Approved (or applied) monthly requests active in `month` with no reservation there: each adds its amount from
 * `fromDay` (tomorrow, in the current month; the 1st, later), pro rata like a reservation would, less what the run rate
 * already projects of it over the same days.
 */
export async function commitmentsIn(
  sql: Sql,
  month: string,
  fromDay: string,
  running: ReadonlyMap<string, Money> = new Map(),
): Promise<Commitment[]> {
  const first = `${month}-01`;
  const last = `${month}-${String(monthDays(month)).padStart(2, '0')}`;
  if (fromDay > last) return [];
  const rows = await sql<CommitRow[]>`
    SELECT r.id, r.number, r.title, r.cost_center, r.amount_micros::text AS amount_micros, r.currency, r.recurrence,
           r.start_day, r.end_day, r.status, r.evidence,
           (SELECT array_agg(month ORDER BY month) FROM reservations s WHERE s.request_id = r.id) AS months
    FROM requests r
    WHERE r.status IN ('approved', 'applied') AND r.recurrence = 'monthly' AND r.kind <> 'contract'
      AND r.start_day <= ${last}::date AND (r.end_day IS NULL OR r.end_day >= ${first}::date)
      AND NOT EXISTS (SELECT 1 FROM reservations s WHERE s.request_id = r.id AND s.month = ${first}::date)
    ORDER BY r.number`;
  const out: Commitment[] = [];
  for (const r of rows) {
    const start = day(r.start_day) > fromDay ? day(r.start_day) : fromDay;
    const adds = addsInMonth({ ...r, title: r.title, start_day: new Date(`${start}T00:00:00Z`) }, month);
    if (adds.isZero()) continue;
    const end = r.end_day && day(r.end_day) < last ? day(r.end_day) : last;
    const already = running.get(r.id);
    const projected = already
      ? Money.fromDecimal(already.toDecimal().times(String(daysIn(start, end))), USD)
      : Money.zero(USD);
    const net = adds.compare(projected) > 0 ? adds.minus(projected) : Money.zero(USD);
    const months = (r.months ?? []).map((m) => day(m).slice(0, 7));
    out.push({
      requestId: r.id,
      number: `R-${r.number}`,
      title: r.title,
      costCenter: r.cost_center,
      amount: net,
      gross: adds,
      monthly: Money.ofMicros(r.amount_micros, r.currency.trim()),
      reservedThrough: months.at(-1) ?? null,
    });
  }
  return out;
}

/**
 * Reservations still held in `month`, per cost center: each one's remaining amount, less what the run rate already
 * projects of its request from `fromDay` to the month's end. `gross` is the remaining amount itself (Budgets' figure).
 */
export async function reservedIn(
  sql: Sql,
  month: string,
  fromDay: string,
  running: ReadonlyMap<string, Money> = new Map(),
): Promise<{ net: Map<string, Money>; gross: Map<string, Money> }> {
  const last = `${month}-${String(monthDays(month)).padStart(2, '0')}`;
  const rows = await sql<{ request_id: string; cost_center: string; left_micros: string; from_day: Date }[]>`
    SELECT request_id, cost_center, greatest(amount_micros - consumed_micros, 0)::text AS left_micros, from_day
    FROM reservations WHERE status = 'reserved' AND month = ${`${month}-01`}`;
  const net = new Map<string, Money>();
  const gross = new Map<string, Money>();
  for (const r of rows) {
    const left = Money.ofMicros(r.left_micros, USD);
    const from = day(r.from_day) > fromDay ? day(r.from_day) : fromDay;
    const already = running.get(r.request_id);
    const projected = already
      ? Money.fromDecimal(already.toDecimal().times(String(daysIn(from, last))), USD)
      : Money.zero(USD);
    const n = left.compare(projected) > 0 ? left.minus(projected) : Money.zero(USD);
    gross.set(r.cost_center, (gross.get(r.cost_center) ?? zero()).plus(left));
    net.set(r.cost_center, (net.get(r.cost_center) ?? zero()).plus(n));
  }
  return { net, gross };
}

/**
 * The year ahead (spec 006): each month's run rate and band, reserved, committed and contracted (net as above),
 * budget and state; annualised over the next 12 months whatever `months` shows. The current month's total is
 * Overview's forecast, the same figure.
 */
export async function yearAhead(
  sql: Sql,
  spend: Spend,
  today: string,
  months: number,
  contractedIn: ((month: string, fromDay: string) => Promise<Money>) | null = spend.contractedIn,
): Promise<ForecastView> {
  const current = today.slice(0, 7);
  const ov = await spend.overview(current);
  const rr: RunRate | null = await spend.runRateNow();
  const perDay = rr?.enough ? rr.perHour!.mid.times('24') : null;
  const fullCosts = rr?.enough ? rr.sources.map((s) => s.fullCosts) : [];
  const running = await runningIncrements(sql, spend, today);
  const out: ForecastMonth[] = [];
  let anyTotal = true;
  const span = Math.max(months, 12);
  for (let i = 0; i < span; i++) {
    const m = addMonths(current, i);
    const dim = monthDays(m);
    const isCurrent = i === 0;
    const fromDay = isCurrent ? addDays(today, 1) : `${m}-01`;
    const reserved = isCurrent
      ? Money.parse(ov.forecast.reserved ?? '0', USD)
      : Money.sum((await reservedIn(sql, m, fromDay, running)).net.values(), USD);
    const committed = isCurrent
      ? Money.parse(ov.forecast.committed ?? '0', USD)
      : Money.sum(
          (await commitmentsIn(sql, m, fromDay, running)).map((c) => c.amount),
          USD,
        );
    const contracted = isCurrent
      ? Money.parse(ov.forecast.contracted ?? '0', USD)
      : contractedIn
        ? await contractedIn(m, fromDay)
        : zero();
    const budgets = await spend.budgetTotal(m);
    const actual = isCurrent ? Money.parse(ov.monthToDate.total, USD) : zero();
    const beyond = reserved.plus(committed).plus(contracted);
    let runRate: ForecastMonth['runRate'] = null;
    let total: Money | null = null;
    if (perDay) {
      // The current month: the days after today (its run rate's P50 comes from Overview, by hours left).
      const days = Decimal.of(BigInt(isCurrent ? dim - Number(today.slice(8, 10)) : dim));
      const p50 = isCurrent
        ? Money.parse(ov.forecast.p50 ?? ov.monthToDate.total, USD).minus(actual)
        : Money.fromDecimal(perDay.times(days).round(6, 'halfEven'), USD);
      const b = band(p50, halfWidth(fullCosts, days), zero());
      runRate = { p10: amount(b.p10), p50: amount(b.p50), p90: amount(b.p90) };
      total = isCurrent && ov.forecast.amount ? Money.parse(ov.forecast.amount, USD) : actual.plus(p50).plus(beyond);
    } else anyTotal = false;
    const state =
      budgets === null
        ? 'none'
        : total === null
          ? stateOf(actual.plus(beyond), null, budgets) === 'over'
            ? 'over'
            : 'early'
          : stateOf(actual, total, budgets);
    out.push({
      month: m,
      days: dim,
      runRate,
      actual: amount(actual),
      reserved: amount(reserved),
      committed: amount(committed),
      contracted: amount(contracted),
      total: total ? amount(total) : null,
      budget: budgets ? amount(budgets) : null,
      state,
    });
  }
  const year = out.slice(0, 12);
  const shown = out.slice(0, months);
  const allActive = await sql<(CommitRow & { months: Date[] | null })[]>`
    SELECT r.id, r.number, r.title, r.cost_center, r.amount_micros::text AS amount_micros, r.currency, r.recurrence,
           r.start_day, r.end_day, r.status, r.evidence,
           (SELECT array_agg(month ORDER BY month) FROM reservations s WHERE s.request_id = r.id) AS months
    FROM requests r
    WHERE r.status IN ('approved', 'applied') AND r.recurrence = 'monthly' AND r.kind <> 'contract'
      AND (r.end_day IS NULL OR r.end_day >= ${today}::date)
    ORDER BY r.number`;
  const annualRate = perDay
    ? (() => {
        const p50 = Money.fromDecimal(perDay.times('365').round(6, 'halfEven'), USD);
        const b = band(p50, halfWidth(fullCosts, Decimal.of(365n)), zero());
        return { p10: amount(b.p10), p50: amount(b.p50), p90: amount(b.p90) };
      })()
    : null;
  // What each request adds over the next 12 months, bounded by its end date (from tomorrow in the current month).
  const yearCommit = Money.sum(
    allActive.flatMap((r) =>
      year.map((m, i) => {
        const from = i === 0 ? addDays(today, 1) : `${m.month}-01`;
        const start = day(r.start_day) > from ? day(r.start_day) : from;
        return addsInMonth({ ...r, start_day: new Date(`${start}T00:00:00Z`) }, m.month);
      }),
    ),
    USD,
  );
  const budgetsShown = year.filter((m) => m.budget !== null);
  return {
    from: current,
    months: shown,
    status: perDay ? 'ok' : 'insufficient',
    basis: rr?.basis ?? 'Not enough data yet',
    annualised: {
      runRate: annualRate,
      commitments: amount(yearCommit),
      contracted: amount(
        Money.sum(
          year.map((m) => Money.parse(m.contracted, USD)),
          USD,
        ),
      ),
      total: anyTotal
        ? amount(
            Money.sum(
              year.map((m) => Money.parse(m.total!, USD)),
              USD,
            ),
          )
        : null,
      budget: budgetsShown.length
        ? amount(
            Money.sum(
              budgetsShown.map((m) => Money.parse(m.budget!, USD)),
              USD,
            ),
          )
        : null,
    },
    commitments: allActive.map((r) => {
      const months = (r.months ?? []).map((m) => day(m).slice(0, 7));
      return {
        requestId: r.id,
        number: `R-${r.number}`,
        title: r.title,
        costCenter: r.cost_center,
        monthly: amount(Money.ofMicros(r.amount_micros, USD)),
        reservedThrough: months.at(-1) ?? null,
      };
    }),
  };
}
