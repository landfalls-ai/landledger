/**
 * Spec 005 by property and by example: an invoice's split always totals the invoice, every figure shows each charge
 * once (invoiced + estimates not replaced), and reconciliation's variance is exact.
 */
import { readFileSync } from 'node:fs';
import { Decimal, Money } from '@landledger/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  invoicedShare,
  parseInvoiceCsv,
  reconcile,
  type ShownRecord,
  shownTotal,
  splitOverEstimates,
} from '../src/invoices.js';

const RUNS = { numRuns: 400 };
const usd = (micros: bigint) => Money.ofMicros(micros, 'USD');
const micros = fc.bigInt({ min: 0n, max: 10n ** 12n });
const HEADER = 'provider,invoice_number,period,model,sku,quantity,unit,amount,currency';

describe('the invoice CSV', () => {
  it('reads the fixtures: Anthropic (two models and a credit) and Ollama at $0', () => {
    const anthropic = parseInvoiceCsv(
      readFileSync(new URL('../fixtures/invoices/anthropic-2026-11.csv', import.meta.url), 'utf8'),
      '2026-12-02',
    );
    expect(anthropic.problems).toEqual([]);
    expect(anthropic.invoices).toHaveLength(1);
    const inv = anthropic.invoices[0]!;
    expect(inv).toMatchObject({ provider: 'Anthropic', providerKey: 'anthropic', month: '2026-11' });
    expect(Money.sum(inv.lines.map((l) => l.amount)).toString()).toBe(usd(23_500_000n).toString());
    expect(inv.lines.at(-1)).toMatchObject({ chargeCategory: 'Credit', model: null, sku: 'promotional-credit' });
    const ollama = parseInvoiceCsv(
      readFileSync(new URL('../fixtures/invoices/ollama-2026-11.csv', import.meta.url), 'utf8'),
      '2026-12-02',
    );
    expect(ollama.problems).toEqual([]);
    expect(ollama.invoices[0]!.lines.every((l) => l.amount.isZero())).toBe(true);
  });

  it('reports every problem with its line, and a non-USD line separately (the whole file is refused)', () => {
    const out = parseInvoiceCsv(
      [
        HEADER,
        'Anthropic,A-1,2026-13,m,,1,Tokens,1,USD',
        'Anthropic,A-1,2026-11,,,1,Tokens,1,USD',
        'Anthropic,A-1,2026-11,m,,1,Tokens,1.1234567,USD',
        'Anthropic,A-1,2026-11,m,,1,Tokens,-1,USD',
        'Anthropic,A-1,2026-11,m,,,,1,USD',
        'Anthropic,A-1,2026-12,m,,1,Tokens,1,USD',
        'Anthropic,A-1,2026-11,m,,1,Tokens,1,EUR',
        'Anthropic,A-1,2027-01,m,,1,Tokens,1,USD',
      ].join('\n'),
      '2026-12-02',
    );
    expect(out.problems).toEqual([
      'Line 2: period "2026-13" is not a month (YYYY-MM)',
      'Line 3: a line names a model or a sku',
      'Line 4: amount "1.1234567" is a decimal with at most six decimals',
      'Line 5: a negative amount is a Credit or an Adjustment',
      'Line 6: a Usage line has a quantity and a unit',
      // B1 (review of wave 3): the month must be over, in LANDLEDGER_TZ, before its invoice comes in.
      "Line 7: period 2026-12 hasn't ended yet (UTC): an invoice is imported once its month is over",
      "Line 9: period 2027-01 hasn't started yet",
    ]);
    expect(out.currency).toEqual(['Line 8: currency "EUR" — only USD until FX is set up']);
    expect(parseInvoiceCsv('provider,amount\nx,1', '2026-11-16').problems[0]).toMatch(/header is missing/);
  });

  it('takes the month as over only in LANDLEDGER_TZ (B1)', () => {
    const csv = [HEADER, 'Anthropic,A-1,2026-11,m,,1,Tokens,1,USD'].join('\n');
    // 1 December 01:30 in Jerusalem is still 30 November in UTC: refused there, taken here.
    expect(parseInvoiceCsv(csv, '2026-11-30', 'UTC').problems).toEqual([
      "Line 2: period 2026-11 hasn't ended yet (UTC): an invoice is imported once its month is over",
    ]);
    expect(parseInvoiceCsv(csv, '2026-12-01', 'Asia/Jerusalem').problems).toEqual([]);
  });
});

describe('posting never double counts (property)', () => {
  const estimates = fc.array(
    fc.record({ cost: micros, qty: fc.option(fc.bigInt({ min: 0n, max: 10n ** 9n }), { nil: null }) }),
    { minLength: 1, maxLength: 20 },
  );

  it('the parts of an invoiced amount always sum exactly to it, whatever the estimates', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), estimates, (total, ests) => {
        const parts = splitOverEstimates(
          usd(total),
          ests.map((e, i) => ({
            key: `k${i}`,
            cost: usd(e.cost),
            quantity: e.qty === null ? null : Decimal.of(e.qty),
          })),
        );
        expect(parts).toHaveLength(ests.length);
        expect(Money.sum(parts, 'USD').micros).toBe(total);
      }),
      RUNS,
    );
  });

  it('shown = Σ invoiced + Σ estimates not replaced, for any split and any set of linked estimates', () => {
    fc.assert(
      fc.property(estimates, micros, fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }), (ests, inv, linked) => {
        const records: ShownRecord[] = [];
        const replaced = ests.filter((_, i) => linked[i]);
        const parts = replaced.length
          ? splitOverEstimates(
              usd(inv),
              replaced.map((e, i) => ({ key: `e${i}`, cost: usd(e.cost), quantity: null })),
            )
          : [];
        let unlinked = usd(0n);
        let r = 0;
        ests.forEach((e, i) => {
          const key = `e${i}`;
          if (linked[i]) {
            records.push({ key: `inv:${key}`, basis: 'invoiced', amount: parts[r++]!, linkedTo: [] });
            records.push({ key, basis: 'estimated', amount: usd(e.cost), linkedTo: [`inv:${key}`] });
          } else {
            records.push({ key, basis: 'estimated', amount: usd(e.cost), linkedTo: [] });
            unlinked = unlinked.plus(usd(e.cost));
          }
        });
        const invoiced = replaced.length ? usd(inv) : usd(0n);
        expect(shownTotal(records).micros).toBe(invoiced.plus(unlinked).micros);
        // A voided invoice (its invoiced records gone) gives every estimate back.
        const voided = records.filter((x) => x.basis === 'estimated');
        expect(shownTotal(voided).micros).toBe(
          Money.sum(
            ests.map((e) => usd(e.cost)),
            'USD',
          ).micros,
        );
      }),
      RUNS,
    );
  });
});

describe('reconciliation arithmetic (property)', () => {
  it('variance = invoiced − estimated exactly; within ⇔ |variance| × 100 ≤ tolerance × |estimated|', () => {
    fc.assert(
      fc.property(micros, micros, fc.constantFrom('0', '2', '2.5', '10'), (e, i, tol) => {
        const out = reconcile(usd(e), usd(i), { estimates: 1, invoiced: 1 }, tol);
        expect(out.variance.micros).toBe(i - e);
        const d = i - e < 0n ? e - i : i - e;
        const [w, f = ''] = tol.split('.');
        const tolTimes10 = BigInt(w!) * 10n + BigInt((f + '0').slice(0, 1));
        expect(out.within).toBe(d * 100n * 10n <= tolTimes10 * e);
        expect(out.status).toBe(out.within ? 'matched' : 'outside');
        if (e === 0n) expect(out.variancePct).toBeNull();
      }),
      RUNS,
    );
  });

  it('names what is missing: nothing invoiced, or nothing estimated', () => {
    expect(reconcile(usd(5n), usd(0n), { estimates: 2, invoiced: 0 }, '2').status).toBe('not_invoiced');
    expect(reconcile(usd(0n), usd(5n), { estimates: 0, invoiced: 1 }, '2').status).toBe('no_estimate');
    expect(reconcile(usd(0n), usd(0n), { estimates: 3, invoiced: 2 }, '2').status).toBe('matched');
    expect(reconcile(usd(100_000_000n), usd(101_500_000n), { estimates: 1, invoiced: 1 }, '2')).toMatchObject({
      status: 'matched',
      variancePct: '1.5',
    });
    expect(reconcile(usd(100_000_000n), usd(97_000_000n), { estimates: 1, invoiced: 1 }, '2')).toMatchObject({
      status: 'outside',
      variancePct: '-3.0',
    });
  });

  it('says how much of a total is invoiced', () => {
    expect(invoicedShare(usd(71n), usd(100n), true)).toBe('71');
    expect(invoicedShare(usd(0n), usd(100n), false)).toBe('0');
    expect(invoicedShare(usd(0n), usd(0n), true)).toBe('100');
  });
});
