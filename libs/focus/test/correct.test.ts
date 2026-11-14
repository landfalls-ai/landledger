import { Decimal, Money } from '@landledger/money';
import { describe, expect, it } from 'vitest';
import {
  ADDITIVE_COLUMNS,
  check,
  type CostRecord,
  correct,
  fromRow,
  reverse,
  toRow,
  toWire,
  ulid,
} from '../src/index.js';
import { aiInputRow, clusterRow } from '../src/testing.js';

const ctx = {
  ingestRunId: 'run_2',
  newId: (() => {
    let n = 0;
    return () => `01KZZZZZZZZZZZZZZZZZZZZZZ${n++}`;
  })(),
};
const openNovember = { isLocked: (m: string) => m <= '2026-10', openMonth: '2026-11' };
const allOpen = { isLocked: () => false, openMonth: '2026-11' };

function sumsToZero(a: CostRecord, b: CostRecord) {
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const name of ADDITIVE_COLUMNS) {
    const x = ra[name];
    const y = rb[name];
    if (x === null) expect(y).toBeNull();
    else if (x instanceof Money) expect(x.plus(y as Money).isZero()).toBe(true);
    else expect((x as Decimal).plus(y as Decimal).isZero()).toBe(true);
  }
}

describe('reverse and correct (T009)', () => {
  it('a reversal negates every additive column and keeps every other one', () => {
    const original = aiInputRow();
    const reversal = reverse(original, ctx);
    sumsToZero(original, reversal);
    expect(reversal.x_CorrectionOfId).toBe(original.x_RecordId);
    expect(reversal.x_RecordId).not.toBe(original.x_RecordId);
    expect(reversal.x_IngestRunId).toBe('run_2');
    for (const key of [
      'ListUnitPrice',
      'PricingUnit',
      'ChargePeriodStart',
      'BillingPeriodStart',
      'x_SourceKey',
      'x_Basis',
      'SkuPriceId',
    ] as const)
      expect(reversal[key]).toEqual(original[key]);
    expect(reversal.ChargeClass).toBeNull();
    expect(check(reversal)).toEqual([]);
  });

  it('in an open month: reversal and re-entry in the same month, ChargeClass null', () => {
    const original = aiInputRow();
    const fixed = aiInputRow({
      ConsumedQuantity: Decimal.parse('2500000'),
      PricingQuantity: Decimal.parse('2.5'),
      ListCost: Money.parse('7.5', 'USD'),
      ContractedCost: Money.parse('7.5', 'USD'),
      EffectiveCost: Money.parse('7.5', 'USD'),
    });
    const [reversal, reentry] = correct(original, fixed, allOpen, ctx);
    expect(reversal!.BillingPeriodStart).toBe('2026-11-01T00:00:00Z');
    expect(reentry!.BillingPeriodStart).toBe('2026-11-01T00:00:00Z');
    expect(reversal!.ChargeClass).toBeNull();
    expect(reentry!.ChargeClass).toBeNull();
    expect(reentry!.x_CorrectionOfId).toBeNull();
    // The key's value is the sum of its rows: 7.2 − 7.2 + 7.5
    const net = Money.sum([original, reversal!, reentry!].map((r) => r.EffectiveCost));
    expect(net.toString()).toBe('USD 7.500000');
  });

  it('for a locked month: both rows go to the open month as Corrections, dated to the original day (§6)', () => {
    const october = clusterRow();
    const more = clusterRow({
      ConsumedQuantity: Decimal.parse('2.5'),
      PricingQuantity: Decimal.parse('2.5'),
      ListCost: Money.parse('0.085', 'USD'),
      ContractedCost: Money.parse('0.085', 'USD'),
      EffectiveCost: Money.parse('0.085', 'USD'),
    });
    const [reversal, reentry] = correct(october, more, openNovember, ctx);
    for (const row of [reversal!, reentry!]) {
      expect(row.ChargeClass).toBe('Correction');
      expect(row.BillingPeriodStart).toBe('2026-11-01T00:00:00Z');
      expect(row.BillingPeriodEnd).toBe('2026-12-01T00:00:00Z');
      expect(row.ChargePeriodStart).toBe('2026-10-30T00:00:00Z');
      expect(row.ChargePeriodEnd).toBe('2026-10-31T00:00:00Z');
      expect(row.x_RateCardVersion).toBe(october.x_RateCardVersion);
      expect(check(row)).toEqual([]);
    }
    sumsToZero(october, reversal!);
    expect(reentry!.EffectiveCost.toString()).toBe('USD 0.085000');
  });

  it('a reversal alone takes a record out', () => {
    const rows = correct(aiInputRow(), null, allOpen, ctx);
    expect(rows).toHaveLength(1);
  });

  it('refuses to reverse a reversal, to change the key or the charge day, or to book into a locked month', () => {
    const reversal = reverse(aiInputRow(), ctx);
    expect(() => reverse(reversal, ctx)).toThrow(/never reversed/);
    expect(() => correct(aiInputRow(), aiInputRow({ x_SourceKey: 'other' }), allOpen, ctx)).toThrow(/source key/);
    expect(() =>
      correct(
        aiInputRow(),
        aiInputRow({ ChargePeriodStart: '2026-11-12T00:00:00Z', ChargePeriodEnd: '2026-11-13T00:00:00Z' }),
        allOpen,
        ctx,
      ),
    ).toThrow(/charge period/);
    expect(() => correct(clusterRow(), null, { isLocked: () => true, openMonth: '2026-11' }, ctx)).toThrow(/locked/);
  });
});

describe('the table mapping', () => {
  it('round-trips a record through a cost_records row exactly', () => {
    const record = clusterRow();
    const row = toRow(record);
    expect(row.effective_cost_micros).toBe('42500');
    expect(row.billed_cost_micros).toBe('0');
    expect(row.pricing_quantity).toBe('1.25');
    expect(row.record_id).toBe(record.x_RecordId);
    const back = fromRow({ ...row, charge_period_start: new Date('2026-10-30T00:00:00Z') });
    expect(toWire(back)).toEqual(toWire(record));
  });

  it('puts amounts on the wire as decimal strings, never JSON numbers', () => {
    const wire = toWire(aiInputRow());
    expect(wire.EffectiveCost).toBe('7.200000');
    expect(wire.BilledCost).toBe('0.000000');
    expect(wire.PricingQuantity).toBe('2.4');
    expect(JSON.stringify(wire)).not.toMatch(/":\d/);
  });

  it('makes sortable ULIDs', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});
