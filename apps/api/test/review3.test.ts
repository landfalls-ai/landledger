/**
 * The review of wave 3, the pure parts: the reconciliation's absolute floor, exact contract terms, the notice date's
 * last business day, the dev spike's loopback guard and Clickland's runbook link.
 */
import { Money } from '@landledger/money';
import { describe, expect, it } from 'vitest';
import { assertLoopbackDatabase, clicklandAlert } from '../src/anomalies.js';
import { lastBusinessDayOnOrBefore } from '../src/business-hours.js';
import { annualValue, parseContractCsv, termMonths, termMonthsExact } from '../src/contracts.js';
import { reconcile } from '../src/invoices.js';

const usd = (a: string) => Money.parse(a, 'USD');

describe('reconciliation tolerance (nit)', () => {
  it('treats a variance within the absolute floor as within, whatever the percent', () => {
    const counts = { estimates: 1, invoiced: 1 };
    expect(reconcile(usd('0.10'), usd('0.11'), counts, '5').status).toBe('outside');
    expect(reconcile(usd('0.10'), usd('0.11'), counts, '5', '0.50').status).toBe('matched');
    expect(reconcile(usd('100'), usd('110'), counts, '5', '0.50').status).toBe('outside');
  });
});

describe('contract terms (nits, should-fix 15)', () => {
  it('counts a part month exactly, so an 11.5-month term does not inflate the annual value', () => {
    expect(termMonths('2026-01-01', '2026-12-31')).toBe(12);
    expect(termMonthsExact('2026-01-01', '2026-12-31').toString()).toBe('12');
    expect(termMonths('2026-01-01', '2026-12-15')).toBe(11);
    expect(termMonthsExact('2026-01-01', '2026-12-15').toFixed(6, 'halfEven')).toBe('11.483871');
    // $115,000 over 11 + 15/31 months is $120,168.54 a year, not $125,454.55 (11 whole months).
    expect(
      annualValue(usd('115000'), termMonthsExact('2026-01-01', '2026-12-15')).toDecimal().toFixed(2, 'halfEven'),
    ).toBe('120168.54');
  });

  it('gives notice by the last business day on or before the date (Sunday–Thursday, holidays)', () => {
    const cal = { days: [0, 1, 2, 3, 4], holidays: new Set(['2026-12-24']) };
    expect(lastBusinessDayOnOrBefore('2026-12-26', cal)).toBe('2026-12-23'); // Sat → Fri → Thu is a holiday → Wed
    expect(lastBusinessDayOnOrBefore('2026-12-27', cal)).toBe('2026-12-27'); // a Sunday works
  });

  it('reads seats_used_as_of, never after today and only with seats_used', () => {
    const head =
      'vendor,product,cost_center,tcv,currency,term_start,term_end,seats_paid,seats_used,renewal_date,notice_days,seats_used_as_of';
    const ok = parseContractCsv(
      `${head}\nV,P,ENG,1200,USD,2026-01-01,2026-12-31,10,4,2027-01-01,30,2026-11-10`,
      new Set(['ENG']),
      '2026-11-15',
    );
    expect(ok.problems).toEqual([]);
    expect(ok.contracts[0]).toMatchObject({ seatsUsed: 4, seatsUsedAsOf: '2026-11-10' });
    const bad = parseContractCsv(
      `${head}\nV,P,ENG,1200,USD,2026-01-01,2026-12-31,10,4,2027-01-01,30,2026-11-20`,
      new Set(['ENG']),
      '2026-11-15',
    );
    expect(bad.problems).toEqual(['Line 2: seats_used_as_of 2026-11-20 is after today']);
  });
});

describe('the dev spike and Clickland (should-fix 11, nit)', () => {
  it('runs only against a database on this machine', () => {
    expect(() => assertLoopbackDatabase('postgres://u:p@127.0.0.1:25532/landledger')).not.toThrow();
    expect(() => assertLoopbackDatabase('postgres://u:p@localhost/landledger')).not.toThrow();
    expect(() => assertLoopbackDatabase('postgres://u:p@[::1]:5432/x')).not.toThrow();
    expect(() => assertLoopbackDatabase('postgres://u:p@db.example.com:5432/landledger')).toThrow(/this machine/);
  });

  it("links Clickland's alert to this Landledger's own Anomalies page", () => {
    expect(clicklandAlert('http://ledger.local:4811/').runbookUrl).toBe('http://ledger.local:4811/anomalies');
  });
});
