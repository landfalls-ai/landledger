import { Decimal, Money } from '@landledger/money';
import { COLUMNS } from './columns.js';
import type {
  Basis,
  ChargeCategory,
  ChargeClass,
  ChargeFrequency,
  PricingCategory,
  ServiceCategory,
  Source,
} from './values.js';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** A FOCUS date/time: UTC, `YYYY-MM-DDTHH:mm:ssZ` (`attributes/datetime_format.md:9`-`:15`). */
export type DateTime = string;

/**
 * One cost record under its FOCUS names. Amounts are `Money` (micro-units) in `BillingCurrency`; prices and quantities
 * are exact `Decimal`s; nothing is a float. Build one, `check` it, append it; never change one: correct it.
 */
export interface CostRecord {
  BilledCost: Money;
  EffectiveCost: Money;
  ListCost: Money;
  ContractedCost: Money;
  ListUnitPrice: Decimal | null;
  ContractedUnitPrice: Decimal | null;
  PricingQuantity: Decimal | null;
  PricingUnit: string | null;
  ConsumedQuantity: Decimal | null;
  ConsumedUnit: string | null;
  BillingCurrency: string;

  ChargePeriodStart: DateTime;
  ChargePeriodEnd: DateTime;
  BillingPeriodStart: DateTime;
  BillingPeriodEnd: DateTime;

  ChargeCategory: ChargeCategory;
  ChargeClass: ChargeClass | null;
  ChargeDescription: string | null;
  ChargeFrequency: ChargeFrequency;
  PricingCategory: PricingCategory | null;
  ServiceCategory: ServiceCategory;
  ServiceSubcategory: string;
  ServiceName: string;
  ServiceProviderName: string;
  HostProviderName: string | null;
  InvoiceIssuerName: string;
  BillingAccountId: string;
  BillingAccountName: string | null;
  SubAccountId: string | null;
  SubAccountName: string | null;
  SubAccountType: string | null;
  InvoiceId: string | null;

  ResourceId: string | null;
  ResourceName: string | null;
  ResourceType: string | null;
  SkuId: string | null;
  SkuMeter: string | null;
  SkuPriceId: string | null;
  SkuPriceDetails: JsonObject | null;
  Tags: JsonObject | null;

  AllocatedMethodId: string | null;
  AllocatedMethodDetails: JsonObject | null;
  AllocatedResourceId: string | null;
  AllocatedResourceName: string | null;
  AllocatedTags: JsonObject | null;

  x_RecordId: string;
  x_Basis: Basis;
  x_Source: Source;
  x_SourceKey: string;
  x_SourceCost: Decimal | null;
  x_RateCardVersion: string | null;
  x_IngestRunId: string;
  x_CorrectionOfId: string | null;
  x_WorkflowId: string | null;
  x_AgentId: string | null;
  x_ActorId: string | null;
  /** The amount in the source's currency when it isn't BillingCurrency (EffectiveCost is its conversion). */
  x_OriginalCost: Decimal | null;
  x_OriginalCurrency: string | null;
  /** The `fx_rates` row the conversion used. */
  x_FxRateId: string | null;
}

/** A row of `cost_records` as postgres.js reads and writes it: bigint and numeric as strings, times as Date or text. */
export type CostRow = Record<string, string | Date | JsonObject | null>;

/** The table row for a record: micro-units and decimals as strings (exact), times as ISO text, JSON as objects. */
export function toRow(record: CostRecord): Record<string, string | JsonObject | null> {
  const row: Record<string, string | JsonObject | null> = {};
  for (const col of COLUMNS) {
    const value = (record as unknown as Record<string, unknown>)[col.name] ?? null;
    if (value === null) row[col.column] = null;
    else if (col.storage === 'micros') row[col.column] = (value as Money).micros.toString();
    else if (col.storage === 'numeric') row[col.column] = (value as Decimal).toString();
    else if (col.storage === 'jsonb') row[col.column] = value as JsonObject;
    else row[col.column] = value as string;
  }
  return row;
}

/** A FOCUS date/time from a Postgres timestamptz (a Date) or text. */
export function dateTime(value: Date | string): DateTime {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new SyntaxError(`Not a date/time: ${String(value)}`);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The record a `cost_records` row holds. */
export function fromRow(row: CostRow): CostRecord {
  const out: Record<string, unknown> = {};
  const code = row.billing_currency as string;
  for (const col of COLUMNS) {
    const value = row[col.column] ?? null;
    if (value === null) out[col.name] = null;
    else if (col.storage === 'micros') out[col.name] = Money.ofMicros(value as string, code);
    else if (col.storage === 'numeric') out[col.name] = Decimal.parse(value as string);
    else if (col.storage === 'timestamptz') out[col.name] = dateTime(value as Date | string);
    else out[col.name] = value;
  }
  return out as unknown as CostRecord;
}

/** A record as JSON on the wire: FOCUS names, amounts and decimals as strings (never JSON numbers). */
export function toWire(record: CostRecord): Record<string, string | JsonObject | null> {
  const out: Record<string, string | JsonObject | null> = {};
  for (const col of COLUMNS) {
    const value = (record as unknown as Record<string, unknown>)[col.name] ?? null;
    if (value === null) out[col.name] = null;
    else if (col.storage === 'micros') out[col.name] = (value as Money).toDecimal().toString();
    else if (col.storage === 'numeric') out[col.name] = (value as Decimal).toString();
    else out[col.name] = value as string | JsonObject;
  }
  return out;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: 48 bits of milliseconds and 80 random bits in Crockford base 32; sorts by time. `x_RecordId`. */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = '';
  for (let i = 0; i < 16; i++) random += CROCKFORD[bytes[i]! % 32];
  return time + random;
}
