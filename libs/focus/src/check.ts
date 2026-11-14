import { isCurrencyCode, isUnit, Money, Quantity, Rate, type Decimal } from '@landledger/money';
import { COLUMNS } from './columns.js';
import { isDateTime, isUtcDayStart, isUtcMonthStart, monthOf, monthStart, nextMonth } from './periods.js';
import type { CostRecord } from './record.js';
import {
  BASES,
  CHARGE_CATEGORIES,
  CHARGE_CLASSES,
  CHARGE_FREQUENCIES,
  PRICING_CATEGORIES,
  SERVICE_CATEGORIES,
  SOURCES,
} from './values.js';

/** A rule a record breaks: the column, a stable rule id, and a sentence for a person. */
export interface Violation {
  column: string;
  rule: string;
  message: string;
}

const MONEY_COLUMNS = ['BilledCost', 'EffectiveCost', 'ListCost', 'ContractedCost'] as const;

/**
 * Every rule a record breaks, FOCUS 1.4's and Landledger's own (spec 001, docs/research/focus.md §2–§7); an empty list
 * means it may be appended. FOCUS rules apply in full to `invoiced` rows; `estimated` rows follow the one documented
 * departure (`BilledCost` 0, `EffectiveCost` = `ContractedCost`).
 */
export function check(record: CostRecord): Violation[] {
  const out: Violation[] = [];
  const add = (column: string, rule: string, message: string) => out.push({ column, rule, message });
  const r = record as unknown as Record<string, unknown>;

  // Required columns
  for (const col of COLUMNS)
    if (!col.nullable && (r[col.name] === null || r[col.name] === undefined || r[col.name] === ''))
      add(col.name, 'required', `${col.name} is required`);

  // Allowed values
  const allowed = (column: string, values: readonly string[], nullable = false) => {
    const v = r[column];
    if ((v === null || v === undefined) && nullable) return;
    if (typeof v !== 'string' || !values.includes(v))
      add(column, 'allowed-values', `${column} is one of ${values.join(', ')}; got ${JSON.stringify(v)}`);
  };
  allowed('ChargeCategory', CHARGE_CATEGORIES);
  allowed('ChargeClass', CHARGE_CLASSES, true);
  allowed('ChargeFrequency', CHARGE_FREQUENCIES);
  allowed('PricingCategory', PRICING_CATEGORIES, true);
  allowed('ServiceCategory', SERVICE_CATEGORIES);
  allowed('x_Basis', BASES);
  allowed('x_Source', SOURCES);
  if (record.ChargeCategory === 'Purchase' && record.ChargeFrequency === 'Usage-Based')
    add('ChargeFrequency', 'purchase-not-usage-based', 'A Purchase is never Usage-Based');

  // Currency: one ISO 4217 code, every amount in it
  if (!isCurrencyCode(record.BillingCurrency))
    add(
      'BillingCurrency',
      'currency',
      `BillingCurrency is an ISO 4217 code; got ${JSON.stringify(record.BillingCurrency)}`,
    );
  for (const name of MONEY_COLUMNS) {
    const m = record[name];
    if (!(m instanceof Money)) add(name, 'money', `${name} is Money (micro-units), not ${typeof m}`);
    else if (m.currency !== record.BillingCurrency)
      add(name, 'currency', `${name} is in ${m.currency}, not BillingCurrency ${record.BillingCurrency}`);
  }
  if (out.some((v) => v.rule === 'money' || v.rule === 'currency' || v.rule === 'required')) return out;

  // Units in Unit Format, quantity and unit together
  const pair = (q: 'PricingQuantity' | 'ConsumedQuantity', u: 'PricingUnit' | 'ConsumedUnit') => {
    if ((record[q] === null) !== (record[u] === null)) add(u, 'quantity-unit', `${q} and ${u} are set together`);
    const unit = record[u];
    if (unit !== null && !isUnit(unit))
      add(u, 'unit-format', `${u} ${JSON.stringify(unit)} is not in FOCUS Unit Format`);
  };
  pair('PricingQuantity', 'PricingUnit');
  pair('ConsumedQuantity', 'ConsumedUnit');
  const correction = record.ChargeClass === 'Correction';
  if (record.ChargeCategory === 'Usage' && !correction && record.ConsumedQuantity === null)
    add('ConsumedQuantity', 'consumed-on-usage', 'ConsumedQuantity is set on Usage rows that are not corrections');
  if (record.ChargeCategory === 'Usage' && record.SkuPriceId === null)
    add('SkuPriceId', 'price-on-usage', 'SkuPriceId is set on Usage rows');

  // Cost = unit price × pricing quantity, to the micro-unit
  const product = (cost: 'ListCost' | 'ContractedCost', price: 'ListUnitPrice' | 'ContractedUnitPrice') => {
    const p: Decimal | null = record[price];
    if (p === null || record.PricingQuantity === null || record.PricingUnit === null || !isUnit(record.PricingUnit))
      return;
    const expected = Money.fromProduct(
      Rate.of(p.abs(), record.BillingCurrency, record.PricingUnit),
      Quantity.of(p.isNegative() ? record.PricingQuantity.negate() : record.PricingQuantity, record.PricingUnit),
    );
    if (!expected.equals(record[cost]))
      add(
        cost,
        'price-times-quantity',
        `${cost} ${record[cost].toString()} is not ${price} × PricingQuantity (${expected.toString()})`,
      );
  };
  product('ListCost', 'ListUnitPrice');
  product('ContractedCost', 'ContractedUnitPrice');

  // Another currency: the original amount, its currency and the rate, all or none; never the billing currency itself
  const original = [record.x_OriginalCost, record.x_OriginalCurrency, record.x_FxRateId];
  if (original.some((v) => v !== null && v !== undefined) && original.some((v) => v === null || v === undefined))
    add(
      'x_OriginalCurrency',
      'original-currency',
      'x_OriginalCost, x_OriginalCurrency and x_FxRateId go together: an amount converted at a dated rate',
    );
  else if (record.x_OriginalCurrency != null) {
    if (!isCurrencyCode(record.x_OriginalCurrency))
      add('x_OriginalCurrency', 'currency', `x_OriginalCurrency is an ISO 4217 code; got ${record.x_OriginalCurrency}`);
    else if (record.x_OriginalCurrency === record.BillingCurrency)
      add(
        'x_OriginalCurrency',
        'original-currency',
        'x_OriginalCurrency is set only when it differs from BillingCurrency',
      );
  }

  // Estimated against invoiced (docs/research/focus.md §2)
  if (record.x_Basis === 'estimated') {
    if (!record.BilledCost.isZero())
      add('BilledCost', 'estimated-billed-zero', 'An estimated row has BilledCost 0: nothing was invoiced');
    if (!record.EffectiveCost.equals(record.ContractedCost))
      add('EffectiveCost', 'estimated-effective', 'An estimated row has EffectiveCost = ContractedCost');
  } else if (record.x_Basis === 'invoiced') {
    if (record.ChargeCategory === 'Usage' && !record.EffectiveCost.equals(record.BilledCost))
      add('EffectiveCost', 'invoiced-effective', 'An invoiced Usage row has EffectiveCost = BilledCost');
    if (record.x_RateCardVersion !== null)
      add('x_RateCardVersion', 'invoiced-no-rate-card', 'An invoiced row is priced by its invoice, not a rate card');
  }

  // Periods: UTC days and months
  for (const name of ['ChargePeriodStart', 'ChargePeriodEnd', 'BillingPeriodStart', 'BillingPeriodEnd'] as const)
    if (!isDateTime(record[name])) add(name, 'datetime', `${name} is a UTC date/time YYYY-MM-DDTHH:mm:ssZ`);
  if (out.some((v) => v.rule === 'datetime')) return out;
  if (!isUtcDayStart(record.ChargePeriodStart) || !isUtcDayStart(record.ChargePeriodEnd))
    add('ChargePeriodStart', 'utc-day', 'A charge period starts and ends on UTC day boundaries');
  if (record.ChargePeriodEnd <= record.ChargePeriodStart)
    add('ChargePeriodEnd', 'period-order', 'ChargePeriodEnd is after ChargePeriodStart (exclusive end)');
  if (!isUtcMonthStart(record.BillingPeriodStart))
    add('BillingPeriodStart', 'utc-month', 'A billing period is a UTC month');
  else if (record.BillingPeriodEnd !== monthStart(nextMonth(monthOf(record.BillingPeriodStart))))
    add('BillingPeriodEnd', 'utc-month', 'BillingPeriodEnd is the first instant of the next month');

  // ChargeClass only on corrections to a locked month, booked in a later month with the original charge dates
  const chargeMonth = monthOf(record.ChargePeriodStart);
  const billingMonth = monthOf(record.BillingPeriodStart);
  if (correction && chargeMonth >= billingMonth)
    add('ChargeClass', 'correction-later-month', 'A Correction is booked in a month after the one it corrects');
  if (!correction && chargeMonth !== billingMonth)
    add('ChargeClass', 'correction-class', 'A row booked outside its charge month is a Correction');

  // A reversal names what it reverses; a record never reverses itself
  if (record.x_CorrectionOfId !== null && record.x_CorrectionOfId === record.x_RecordId)
    add('x_CorrectionOfId', 'self-reversal', 'A record never reverses itself');

  return out;
}

export class InvalidRecordError extends Error {
  constructor(readonly violations: Violation[]) {
    super(`The record breaks ${violations.length} rule(s): ${violations.map((v) => v.message).join('; ')}`);
    this.name = 'InvalidRecordError';
  }
}

/** `check`, throwing every violation at once. */
export function assertValid(record: CostRecord): CostRecord {
  const violations = check(record);
  if (violations.length) throw new InvalidRecordError(violations);
  return record;
}
