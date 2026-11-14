import { CurrencyMismatchError, Decimal, Money } from '@landledger/money';
import { describe, expect, it } from 'vitest';
import { type Line, MIN_FULL_DAYS, reportingAmount, runRateOf, stateOf } from '../src/spend.js';

const H = 3_600_000;
const usd = (s: string) => Money.parse(s, 'USD');

const line = (source: string, day: string, cost: string, costCenter = 'ENG-PLATFORM'): Line => ({
  recordId: `${source}-${day}-${cost}`,
  day,
  month: day.slice(0, 7),
  postDay: day,
  basis: 'estimated',
  provisional: false,
  correction: false,
  source,
  amount: usd(cost),
  tags: {},
  serviceName: 's',
  serviceCategory: 'Compute',
  providerName: 'p',
  resourceName: null,
  costCenter,
  team: null,
  product: null,
  plClass: null,
  capitalisable: false,
  ruleId: null,
});

const window = { from: '2026-11-08', to: '2026-11-14' };
const since = new Map([
  ['landflow', '2026-10-31T00:00:00.000Z'],
  ['clickland', '2026-11-14T15:15:05.000Z'],
]);

describe('the run rate', () => {
  it('is not claimed on a few hours of data: a partial day is not a day', () => {
    // Landflow: seven full days. Clickland: four hours of today, at USD 0.90 an hour.
    const observed = new Map([
      ['landflow', new Map(['08', '09', '10', '11', '12', '13', '14'].map((d) => [`2026-11-${d}`, 24 * H]))],
      ['clickland', new Map([['2026-11-14', 4 * H]])],
    ]);
    const lines = [line('landflow', '2026-11-13', '1.00'), line('clickland', '2026-11-14', '3.60')];
    const rr = runRateOf(lines, observed, since, window);
    expect(rr.enough).toBe(false);
    expect(rr.perHour).toBeNull();
    expect(rr.basis).toMatch(/Not enough data yet.*clickland has 0/);
    expect(rr.dataSince).toBe('2026-11-14T15:15:05.000Z'); // the newest source's first data
    const ck = rr.sources.find((s) => s.source === 'clickland')!;
    expect(ck.perHour!.toFixed(6, 'halfEven')).toBe('0.900000'); // its rate is known; there are just too few days
    expect(ck.fullDays).toBe(0);
  });

  it('is Σ cost ÷ Σ observed hours per source, so a partial today weighs by its hours', () => {
    const observed = new Map([
      [
        'clickland',
        new Map([
          ['2026-11-11', 24 * H],
          ['2026-11-12', 24 * H],
          ['2026-11-13', 23.5 * H],
          ['2026-11-14', 6 * H],
        ]),
      ],
    ]);
    const lines = [
      line('clickland', '2026-11-11', '24.00'),
      line('clickland', '2026-11-12', '48.00'),
      line('clickland', '2026-11-13', '23.50'),
      line('clickland', '2026-11-14', '12.00'), // a busy morning: USD 2 an hour for 6 hours
      line('clickland', '2026-11-05', '999.00'), // outside the seven days
    ];
    const rr = runRateOf(lines, observed, since, window);
    expect(rr.enough).toBe(true);
    // (24 + 48 + 23.5 + 12) ÷ (24 + 24 + 23.5 + 6) = 107.5 ÷ 77.5
    expect(rr.perHour!.mid.toFixed(9, 'halfEven')).toBe(
      Decimal.parse('107.5').divide('77.5', 9, 'halfEven').toString(),
    );
    // The range: the lowest and highest full day (1 and 2 an hour); today's partial day isn't one.
    expect(rr.perHour!.low.toFixed(6, 'halfEven')).toBe('1.000000');
    expect(rr.perHour!.high.toFixed(6, 'halfEven')).toBe('2.000000');
    expect(rr.sources[0]!.fullDays).toBe(3);
  });

  it(`needs ${MIN_FULL_DAYS} full days of every source, and reads only the seven-day window`, () => {
    const observed = new Map([
      [
        'clickland',
        new Map([
          ['2026-11-07', 24 * H], // the eighth day back: outside
          ['2026-11-12', 24 * H],
          ['2026-11-13', 22 * H], // not full
          ['2026-11-14', 24 * H],
        ]),
      ],
    ]);
    const rr = runRateOf([], observed, since, window);
    expect(rr.sources[0]!.fullDays).toBe(2);
    expect(rr.enough).toBe(false);
  });
});

describe('budget states', () => {
  it('says over when actual is over, and claims nothing else without a forecast', () => {
    expect(stateOf(usd('5'), null, usd('10'))).toBe('early');
    expect(stateOf(usd('11'), null, usd('10'))).toBe('over');
    expect(stateOf(usd('5'), usd('12'), usd('10'))).toBe('risk');
    expect(stateOf(usd('5'), usd('9'), usd('10'))).toBe('ok');
    expect(stateOf(usd('5'), null, null)).toBe('none');
  });
});

describe('the reporting currency', () => {
  it('refuses a record in another currency rather than adding it to USD', () => {
    expect(reportingAmount('1500000', 'USD', 'r1').toString()).toBe('USD 1.500000');
    expect(() => reportingAmount('1500000', 'EUR', 'r2')).toThrow(/r2 is in EUR.*converted at ingest/);
    // And Money.sum never adds across currencies: the conversion is explicit, with a dated rate.
    expect(() => Money.sum([usd('1'), Money.parse('1', 'EUR')], 'USD')).toThrow(CurrencyMismatchError);
  });
});
