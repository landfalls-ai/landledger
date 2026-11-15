/**
 * The review of wave 4, the parts that need no database: the amounts a note states (should-fix 8), cent posting that
 * keeps an entry equal to its total (should-fix 11), CSV cells that start with `-` (nit), seats beyond a contract
 * (should-fix 14), a contract's months summing to its value (nit), and the problems an explanation is bound to
 * (should-fix 3).
 */
import { Money } from '@landledger/money';
import { describe, expect, it } from 'vitest';
import { valueThrough } from '../src/accruals.js';
import { problemsSha, rowProblem } from '../src/close.js';
import { csvCell } from '../src/export.js';
import { accrualEntries, postToCents } from '../src/journal.js';
import { amountsIn, uncitedAmounts } from '../src/notes.js';
import { addsInMonth, type Reservable, withinContract } from '../src/reservations.js';

const USD = 'USD';
const m = (a: string) => Money.parse(a, USD);

describe('review of wave 4: units', () => {
  it('reads the amounts a note states, and finds those no cite carries (should-fix 8)', () => {
    expect(amountsIn('Spend was $1,234.56, up $12 and USD 40.00; 3 agents, 12% over; 7.50 USD and 2 dollars')).toEqual([
      '1234.56',
      '12',
      '40.00',
      '7.50',
      '2',
    ]);
    expect(amountsIn('No amounts here: 12 calls, 4.5% growth.')).toEqual([]);
    const cites = [{ figure: 'actual' as const, amount: '1234.560000' }];
    expect(uncitedAmounts('It came to $1,234.56.', cites)).toEqual([]);
    expect(uncitedAmounts('It came to −$1,234.56, down $3.00.', cites)).toEqual([
      '$3.00 is stated in the text but no cite carries it',
    ]);
  });

  it('posts an entry to the cent so it equals its total posted (should-fix 11)', () => {
    const lines = ['0.335000', '0.335000', '0.330000'].map(m);
    const cents = postToCents(lines);
    expect(cents.map((c) => c.toCsv())).toEqual(['0.34', '0.33', '0.33']);
    expect(Money.sum(cents, USD).equals(Money.sum(lines, USD).posted())).toBe(true);
    // Per-line rounding would give 1.01 against a total of 1.00.
    expect(
      Money.sum(
        lines.map((l) => l.posted()),
        USD,
      ).toCsv(),
    ).toBe('1.01');
    expect(Money.sum(cents, USD).toCsv()).toBe('1.00');
  });

  it('writes a supersede entry as the mirror of the accrual entry it reverses (should-fix 11)', () => {
    const a = {
      id: 'acr_1',
      month: '2026-10',
      version: 1,
      lines: [
        {
          line: 1,
          kind: 'usage',
          provider: 'Anthropic',
          item: 'sonnet',
          costCenter: 'ENG',
          plClass: 'rnd',
          amount: '10.005000',
        },
        {
          line: 2,
          kind: 'prepaid',
          provider: 'Figma',
          item: 'Org',
          costCenter: 'ENG',
          plClass: 'rnd',
          amount: '310.000000',
        },
      ],
    } as never;
    const acc = accrualEntries(a, 'accrual');
    const sup = accrualEntries(a, 'supersede');
    expect(acc.map((e) => e[0]!.kind)).toEqual(['accrual', 'prepaid']);
    expect(sup.map((e) => e[0]!.kind)).toEqual(['supersede', 'supersede']);
    const flat = (es: typeof acc, swap = false) =>
      es
        .flat()
        .map((l) => `${l.account}:${(swap ? l.credit : l.debit).toCsv()}:${(swap ? l.debit : l.credit).toCsv()}`)
        .sort();
    expect(flat(sup)).toEqual(flat(acc, true));
    expect(acc[0]!.find((l) => l.account === 'LIAB-ACCRUED')!.credit.toCsv()).toBe('10.01');
  });

  it('neutralises a CSV cell that a spreadsheet reads as a formula, and leaves a plain negative number (nit)', () => {
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('-')).toBe("'-");
  });

  it('reserves seats beyond the contract at the seat price; within it, nothing (should-fix 14)', () => {
    const base: Reservable = {
      id: 'r',
      title: 't',
      status: 'approved',
      cost_center: 'ENG',
      amount_micros: '30000000',
      currency: 'USD',
      recurrence: 'monthly',
      start_day: new Date('2026-12-01T00:00:00Z'),
      end_day: null,
      evidence: {},
      kind: 'tool_or_seat',
      seat: { contractId: 'c', seats: 3, seatPrice: '10', beyond: 0 },
    };
    expect(withinContract(base)).toBe(true);
    expect(addsInMonth(base, '2026-12').isZero()).toBe(true);
    const over = { ...base, seat: { contractId: 'c', seats: 3, seatPrice: '10', beyond: 2 } };
    expect(withinContract(over)).toBe(false);
    expect(addsInMonth(over, '2026-12').toDecimal().toString()).toBe('20.000000');
  });

  it("sums a contract's months back to its value (nit)", () => {
    const tcv = m('1000.00');
    let sum = Money.zero(USD);
    let prev = '2026-03-14';
    for (const end of ['2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-14']) {
      sum = sum.plus(
        valueThrough(tcv, '2026-03-15', '2026-07-14', end).minus(valueThrough(tcv, '2026-03-15', '2026-07-14', prev)),
      );
      prev = end;
    }
    expect(sum.equals(tcv)).toBe(true);
  });

  it('binds an explanation to its problems, in any order (should-fix 3)', () => {
    expect(problemsSha(['a', 'b'])).toBe(problemsSha(['b', 'a']));
    expect(problemsSha(['a'])).not.toBe(problemsSha(['a', 'b']));
    const row = {
      provider: 'anthropic',
      model: 'sonnet',
      status: 'not_invoiced',
      estimated: '3.004000',
      invoiced: '0',
    };
    expect(rowProblem(row)).toBe('anthropic sonnet: not invoiced (estimated 3.00, invoiced 0.00)');
    expect(rowProblem({ ...row, estimated: '3000.00' })).not.toBe(rowProblem(row));
  });
});
