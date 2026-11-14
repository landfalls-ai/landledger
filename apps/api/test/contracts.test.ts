/** Specs 009 and 010, pure: the contracts CSV, terms and annual value, the seat price. */
import { Money } from '@landledger/money';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addMonthsToDay, annualValue, parseContractCsv, seatPriceOf, termMonths } from '../src/contracts.js';

const CCS = new Set(['ENG-PRODUCT', 'GA-IT']);
const HEAD =
  'vendor,product,cost_center,tcv,currency,term_start,term_end,seats_paid,seats_used,renewal_date,notice_days';

describe('contracts', () => {
  it('reads the dev fixture: two contracts, with their terms and seats', () => {
    const csv = readFileSync(new URL('../fixtures/contracts/contracts-2026.dev.csv', import.meta.url), 'utf8');
    const r = parseContractCsv(csv, CCS);
    expect(r.problems).toEqual([]);
    expect(r.contracts.map((c) => [c.vendor, c.termMonths, c.seatsPaid, c.seatsUsed, c.landbrightApp])).toEqual([
      ['Linear', 12, 40, 34, 'linear'],
      ['Notion', 12, 30, 22, 'notion'],
    ]);
  });

  it('reports every problem by line and imports nothing; another currency apart (422)', () => {
    const csv = [
      HEAD,
      'Acme,Pro,NOPE,12.3456789,USD,2026-01-01,2025-12-31,5,,2026-01-01,400',
      'Acme,Pro,ENG-PRODUCT,100,EUR,2026-01-01,2026-12-31,,,2027-01-01,30',
    ].join('\n');
    const r = parseContractCsv(csv, CCS);
    expect(r.problems).toEqual([
      'Line 2: no cost center NOPE',
      'Line 2: tcv 12.3456789 is not an amount (at most six decimals)',
      'Line 2: term_end is before term_start',
      'Line 2: seats_paid and seats_used are both given or both empty',
      'Line 2: notice_days 400 is 0 to 365',
      'Line 3: Acme Pro appears twice',
    ]);
    expect(r.currency).toEqual(['Line 3: EUR (only USD until FX is set up)']);
  });

  it('counts whole months, annualises half to even, and prices a seat a month', () => {
    expect(termMonths('2026-01-01', '2026-12-31')).toBe(12);
    expect(termMonths('2026-06-15', '2027-06-14')).toBe(12);
    expect(termMonths('2026-01-01', '2028-12-31')).toBe(36);
    expect(termMonths('2026-01-01', '2026-01-10')).toBe(1);
    expect(addMonthsToDay('2026-01-31', 1)).toBe('2026-02-28');
    const annual = annualValue(Money.parse('10000', 'USD'), 36);
    expect(annual.toString()).toBe(Money.parse('3333.333333', 'USD').toString());
    expect(seatPriceOf(Money.parse('9600', 'USD'), 40)!.toString()).toBe(Money.parse('20', 'USD').toString());
    expect(seatPriceOf(Money.parse('9600', 'USD'), null)).toBeNull();
  });
});
