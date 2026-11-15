/**
 * Forecast history (wave 4, spec 014): the forecast to month-end stored once a day per cost center and for the month
 * as a whole (`TOTAL`), so the calendar-day-10 forecast is kept as it stood and measured at close, and variance notes
 * cite one forecast. The total is Overview's (P50 plus reservations, commitments and contracts, each netted against
 * the run rate); a cost center's P10 and P90 take the total band in proportion to its projected remainder.
 */
import type { ForecastHistoryView, StoredForecast } from '@landledger/contracts';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import { day as dayOf, type Sql } from './db.js';
import { amount, type Spend } from './spend.js';
import { CORRECTIONS } from './spend.js';

const USD = REPORTING_CURRENCY;
export const TOTAL = 'TOTAL';

/** Scales a cost center's remainder by the band: actual + (forecast − actual) × (bound − mtd) ÷ (P50 − mtd). */
export function apportion(actual: Money, forecast: Money, mtd: Money, bound: Money, mid: Money): Money {
  const denom = mid.minus(mtd);
  if (denom.isZero()) return forecast;
  const rest = forecast.minus(actual);
  return actual.plus(
    Money.fromDecimal(
      rest.toDecimal().times(bound.minus(mtd).toDecimal()).divide(denom.toDecimal(), 6, 'halfEven'),
      USD,
    ),
  );
}

type Row = {
  day: Date;
  month: Date;
  cost_center: string;
  p10_micros: string | null;
  p50_micros: string | null;
  p90_micros: string | null;
  actual_micros: string;
  status: 'ok' | 'insufficient';
};

const m6 = (micros: string | null) => (micros === null ? null : amount(Money.ofMicros(micros, USD)));
const storedOf = (r: Row): StoredForecast => ({
  day: dayOf(r.day),
  month: dayOf(r.month).slice(0, 7),
  costCenter: r.cost_center,
  p10: m6(r.p10_micros),
  p50: m6(r.p50_micros),
  p90: m6(r.p90_micros),
  actualToDate: m6(r.actual_micros)!,
  status: r.status,
});

export class ForecastHistory {
  constructor(
    private readonly sql: Sql,
    private readonly spend: Spend,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Stores today's forecast once (the first call of a UTC day); returns the rows written. */
  async record(): Promise<number> {
    const today = this.now().toISOString().slice(0, 10);
    const [done] = await this.sql`SELECT 1 FROM forecast_history WHERE day = ${today} LIMIT 1`;
    if (done) return 0;
    const month = today.slice(0, 7);
    const o = await this.spend.overview(month);
    const mtd = Money.parse(o.monthToDate.total, USD);
    const ok = o.forecast.status === 'ok' && o.forecast.amount !== null;
    const T50 = ok ? Money.parse(o.forecast.amount!, USD) : null;
    const T10 = ok ? Money.parse(o.forecast.low!, USD) : null;
    const T90 = ok ? Money.parse(o.forecast.high!, USD) : null;
    const rows: Array<Record<string, unknown>> = [
      {
        day: today,
        month: `${month}-01`,
        cost_center: TOTAL,
        p10_micros: T10?.micros.toString() ?? null,
        p50_micros: T50?.micros.toString() ?? null,
        p90_micros: T90?.micros.toString() ?? null,
        actual_micros: mtd.micros.toString(),
        status: ok ? 'ok' : 'insufficient',
      },
    ];
    for (const cc of o.costCenters) {
      if (cc.code === CORRECTIONS) continue;
      const actual = Money.parse(cc.monthToDate, USD);
      const f = ok && cc.forecast !== null ? Money.parse(cc.forecast, USD) : null;
      let p = f
        ? [apportion(actual, f, mtd, T10!, T50!), f, apportion(actual, f, mtd, T90!, T50!)]
        : [null, null, null];
      if (f) p = [...(p as Money[])].sort((a, b) => a.compare(b));
      rows.push({
        day: today,
        month: `${month}-01`,
        cost_center: cc.code,
        p10_micros: p[0]?.micros.toString() ?? null,
        p50_micros: p[1]?.micros.toString() ?? null,
        p90_micros: p[2]?.micros.toString() ?? null,
        actual_micros: actual.micros.toString(),
        status: f ? 'ok' : 'insufficient',
      });
    }
    const res = await this.sql`INSERT INTO forecast_history ${this.sql(rows as never)} ON CONFLICT DO NOTHING`;
    return res.count;
  }

  /** The forecast stored on calendar day 10 of `month`, or the last one before it. */
  async day10(month: string, costCenter: string): Promise<StoredForecast | null> {
    const [r] = await this.sql<Row[]>`
      SELECT * FROM forecast_history
      WHERE month = ${`${month}-01`} AND cost_center = ${costCenter} AND day <= ${`${month}-10`}
      ORDER BY day DESC LIMIT 1`;
    return r ? storedOf(r) : null;
  }

  async view(month: string, costCenter: string, actual: string | null): Promise<ForecastHistoryView> {
    const rows = await this.sql<Row[]>`
      SELECT * FROM forecast_history WHERE month = ${`${month}-01`} AND cost_center = ${costCenter} ORDER BY day`;
    const day10 = await this.day10(month, costCenter);
    let accuracy: ForecastHistoryView['accuracy'] = null;
    if (actual !== null && day10?.p50) {
      const a = Money.parse(actual, USD);
      const p = Money.parse(day10.p50, USD);
      const err = a.isZero() ? null : p.minus(a).toDecimal().times('100').divide(a.toDecimal(), 1, 'halfEven');
      if (err)
        accuracy = {
          actual: amount(a),
          p50: amount(p),
          errorPct: err.toFixed(1, 'halfEven'),
          within10: err.abs().compare(Decimal.parse('10')) <= 0,
        };
    }
    return { month, costCenter, days: rows.map(storedOf), day10, accuracy };
  }
}
