/**
 * Forecasts (spec 006): the band around the run rate, from how much the days vary; what approved requests commit beyond
 * their reservations; the year ahead. Exact decimals throughout: the band's square roots are integer square roots.
 */
import type { ForecastMonth, ForecastView } from '@landledger/contracts';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import { day, type Sql } from './db.js';
import { addsInMonth } from './reservations.js';
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
  /** The amount it adds in the month (pro rata from `from`), beyond any reservation it holds there. */
  amount: Money;
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

/**
 * Approved (or applied) monthly requests active in `month` with no reservation there: each adds its amount from
 * `fromDay` (tomorrow, in the current month; the 1st, later), pro rata like a reservation would.
 */
export async function commitmentsIn(sql: Sql, month: string, fromDay: string): Promise<Commitment[]> {
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
    const months = (r.months ?? []).map((m) => day(m).slice(0, 7));
    out.push({
      requestId: r.id,
      number: `R-${r.number}`,
      title: r.title,
      costCenter: r.cost_center,
      amount: adds,
      monthly: Money.ofMicros(r.amount_micros, r.currency.trim()),
      reservedThrough: months.at(-1) ?? null,
    });
  }
  return out;
}

/** The year ahead (spec 006): each month's run rate and band, reserved, committed, budget and state; annualised. */
export async function yearAhead(sql: Sql, spend: Spend, today: string, months: number): Promise<ForecastView> {
  const current = today.slice(0, 7);
  const ov = await spend.overview(current);
  const rr: RunRate | null = await spend.runRateNow();
  const perDay = rr?.enough ? rr.perHour!.mid.times('24') : null;
  const fullCosts = rr?.enough ? rr.sources.map((s) => s.fullCosts) : [];
  const out: ForecastMonth[] = [];
  let anyTotal = true;
  for (let i = 0; i < months; i++) {
    const m = addMonths(current, i);
    const dim = monthDays(m);
    const isCurrent = i === 0;
    const reserved = Money.sum((await spend.reservedByCostCenter(m)).values(), USD);
    const commits = await commitmentsIn(sql, m, isCurrent ? addDays(today, 1) : `${m}-01`);
    const committed = Money.sum(
      commits.map((c) => c.amount),
      USD,
    );
    const budgets = await spend.budgetTotal(m);
    const actual = isCurrent ? Money.parse(ov.monthToDate.total, USD) : zero();
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
      total = actual.plus(p50).plus(reserved).plus(committed);
    } else anyTotal = false;
    const state =
      budgets === null
        ? 'none'
        : total === null
          ? stateOf(actual.plus(reserved).plus(committed), null, budgets) === 'over'
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
      total: total ? amount(total) : null,
      budget: budgets ? amount(budgets) : null,
      state,
    });
  }
  const allActive = await sql<
    { id: string; number: number; title: string; cost_center: string; amount_micros: string; months: Date[] | null }[]
  >`
    SELECT r.id, r.number, r.title, r.cost_center, r.amount_micros::text AS amount_micros,
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
  const monthlyCommit = Money.sum(
    allActive.map((r) => Money.ofMicros(r.amount_micros, USD)),
    USD,
  );
  const budgetsShown = out.filter((m) => m.budget !== null);
  return {
    from: current,
    months: out,
    status: perDay ? 'ok' : 'insufficient',
    basis: rr?.basis ?? 'Not enough data yet',
    annualised: {
      runRate: annualRate,
      commitments: amount(Money.fromDecimal(monthlyCommit.toDecimal().times('12'), USD)),
      total: anyTotal
        ? amount(
            Money.sum(
              out.map((m) => Money.parse(m.total!, USD)),
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
