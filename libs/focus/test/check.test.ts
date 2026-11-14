import { Decimal, Money } from '@landledger/money';
import { describe, expect, it } from 'vitest';
import { assertValid, billingPeriod, check, type CostRecord, dayPeriod, InvalidRecordError } from '../src/index.js';
import { aiInputRow, clusterRow } from '../src/testing.js';

const usd = (amount: string) => Money.parse(amount, 'USD');
const rules = (r: CostRecord) => check(r).map((v) => v.rule);

describe('check (T008)', () => {
  it('passes the research examples', () => {
    expect(check(aiInputRow())).toEqual([]);
    expect(check(clusterRow())).toEqual([]);
    expect(aiInputRow().EffectiveCost.toString()).toBe('USD 7.200000');
    expect(clusterRow().EffectiveCost.toString()).toBe('USD 0.042500');
  });

  it('requires the non-null columns', () => {
    expect(rules(aiInputRow({ ServiceName: '' }))).toContain('required');
    expect(rules(aiInputRow({ x_SourceKey: null as unknown as string }))).toContain('required');
    expect(rules(aiInputRow({ x_IngestRunId: undefined as unknown as string }))).toContain('required');
  });

  it('checks allowed values', () => {
    expect(rules(aiInputRow({ ChargeCategory: 'Fee' as never }))).toContain('allowed-values');
    expect(rules(aiInputRow({ ServiceCategory: 'AI' as never }))).toContain('allowed-values');
    expect(rules(aiInputRow({ x_Basis: 'guessed' as never }))).toContain('allowed-values');
    expect(rules(aiInputRow({ ChargeCategory: 'Purchase', ConsumedQuantity: null, ConsumedUnit: null }))).toContain(
      'purchase-not-usage-based',
    );
  });

  it('keeps every amount in BillingCurrency, as Money', () => {
    expect(rules(aiInputRow({ BilledCost: Money.zero('EUR') }))).toContain('currency');
    expect(rules(aiInputRow({ BillingCurrency: 'usd' }))).toContain('currency');
    expect(rules(aiInputRow({ ListCost: 7.2 as unknown as Money }))).toContain('money');
  });

  it('keeps an amount in another currency beside its conversion: amount, currency and rate together', () => {
    const eur = { x_OriginalCost: Decimal.parse('6.65'), x_OriginalCurrency: 'EUR', x_FxRateId: 'fx_eur_usd_1113' };
    expect(check(aiInputRow(eur))).toEqual([]);
    expect(rules(aiInputRow({ ...eur, x_FxRateId: null }))).toContain('original-currency');
    expect(rules(aiInputRow({ ...eur, x_OriginalCurrency: 'USD' }))).toContain('original-currency');
    expect(rules(aiInputRow({ ...eur, x_OriginalCurrency: 'eur' }))).toContain('currency');
  });

  it('wants units in FOCUS Unit Format, set with their quantity', () => {
    expect(rules(aiInputRow({ PricingUnit: '1M tokens' }))).toContain('unit-format');
    expect(rules(aiInputRow({ ConsumedUnit: null }))).toContain('quantity-unit');
    expect(rules(aiInputRow({ ConsumedQuantity: null, ConsumedUnit: null }))).toContain('consumed-on-usage');
    expect(rules(aiInputRow({ SkuPriceId: null }))).toContain('price-on-usage');
  });

  it('wants cost = unit price × pricing quantity, to the micro-unit', () => {
    expect(rules(aiInputRow({ ListCost: usd('7.200001') }))).toContain('price-times-quantity');
    const off = aiInputRow({ ContractedCost: usd('7.19'), EffectiveCost: usd('7.19') });
    expect(rules(off)).toEqual(['price-times-quantity']);
  });

  it('keeps BilledCost 0 on estimated rows and EffectiveCost = ContractedCost', () => {
    expect(rules(aiInputRow({ BilledCost: usd('7.2') }))).toContain('estimated-billed-zero');
    expect(rules(aiInputRow({ EffectiveCost: usd('7') }))).toContain('estimated-effective');
  });

  it('applies FOCUS in full to invoiced rows', () => {
    const invoiced = aiInputRow({
      x_Basis: 'invoiced',
      x_RateCardVersion: null,
      BilledCost: usd('7.2'),
      InvoiceId: 'inv_1',
    });
    expect(check(invoiced)).toEqual([]);
    expect(rules({ ...invoiced, BilledCost: usd('7') })).toContain('invoiced-effective');
    expect(rules({ ...invoiced, x_RateCardVersion: 'rcv_1' })).toContain('invoiced-no-rate-card');
  });

  it('wants UTC days and months', () => {
    expect(rules(aiInputRow({ ChargePeriodStart: '2026-11-13T00:00:00+02:00' }))).toContain('datetime');
    expect(rules(aiInputRow({ ChargePeriodStart: '2026-11-13T01:00:00Z' }))).toContain('utc-day');
    expect(rules(aiInputRow({ ChargePeriodEnd: '2026-11-13T00:00:00Z' }))).toContain('period-order');
    expect(rules(aiInputRow({ BillingPeriodStart: '2026-11-02T00:00:00Z' }))).toContain('utc-month');
    expect(rules(aiInputRow({ BillingPeriodEnd: '2026-11-30T00:00:00Z' }))).toContain('utc-month');
    expect(rules(aiInputRow({ ChargePeriodStart: '2026-02-30T00:00:00Z' }))).toContain('datetime');
  });

  it('allows ChargeClass only on corrections booked in a later month', () => {
    expect(rules(aiInputRow({ ChargeClass: 'Correction' }))).toContain('correction-later-month');
    expect(rules(aiInputRow({ ...billingPeriod('2026-12') }))).toContain('correction-class');
    expect(check(clusterRow({ ...billingPeriod('2026-11'), ChargeClass: 'Correction' }))).toEqual([]);
    expect(rules(clusterRow({ ...dayPeriod('2026-11-02'), ChargeClass: 'Correction' }))).toContain(
      'correction-later-month',
    );
  });

  it('refuses a record that reverses itself', () => {
    expect(rules(aiInputRow({ x_CorrectionOfId: aiInputRow().x_RecordId }))).toContain('self-reversal');
  });

  it('returns every rule at once, and assertValid throws them', () => {
    const bad = aiInputRow({ BilledCost: usd('1'), PricingUnit: 'tokens!', ChargeClass: 'Correction' });
    expect(check(bad).length).toBeGreaterThanOrEqual(3);
    expect(() => assertValid(bad)).toThrow(InvalidRecordError);
  });

  it('takes no floats anywhere: quantities are Decimals', () => {
    expect(() => Decimal.from(2.4 as unknown as string)).toThrow(TypeError);
  });
});
