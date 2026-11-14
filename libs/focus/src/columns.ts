/**
 * The FOCUS 1.4 cost-and-usage columns Landledger keeps (45 of 65) and its `x_` columns, as data: the FOCUS name, its
 * type, feature level and nullability (each column file's Content Constraints), the snake-case column of
 * `cost_records` that holds it, and how a value is stored. docs/research/focus.md §3, §4 and §7 give the reasons.
 */

export type FocusType = 'Decimal' | 'String' | 'DateTime' | 'JSON';
export type FeatureLevel = 'Mandatory' | 'Conditional' | 'Recommended' | 'Custom';
/** How `cost_records` stores it: amounts as bigint micro-units, decimals as numeric, times as timestamptz. */
export type Storage = 'micros' | 'numeric' | 'text' | 'timestamptz' | 'jsonb';

export interface FocusColumn {
  name: string;
  type: FocusType;
  level: FeatureLevel;
  nullable: boolean;
  /** The column of `cost_records`. */
  column: string;
  storage: Storage;
  /** An additive metric: negated on a reversal (FOCUS Correction Handling, ledger style). */
  additive?: true;
}

const c = (
  name: string,
  type: FocusType,
  level: FeatureLevel,
  nullable: boolean,
  column: string,
  storage: Storage,
  additive?: true,
): FocusColumn =>
  additive
    ? { name, type, level, nullable, column, storage, additive }
    : { name, type, level, nullable, column, storage };

/** The kept FOCUS columns, in docs/research/focus.md §3's order. */
export const FOCUS_COLUMNS: readonly FocusColumn[] = [
  // Money, quantity and price
  c('BilledCost', 'Decimal', 'Mandatory', false, 'billed_cost_micros', 'micros', true),
  c('EffectiveCost', 'Decimal', 'Mandatory', false, 'effective_cost_micros', 'micros', true),
  c('ListCost', 'Decimal', 'Mandatory', false, 'list_cost_micros', 'micros', true),
  c('ContractedCost', 'Decimal', 'Mandatory', false, 'contracted_cost_micros', 'micros', true),
  c('ListUnitPrice', 'Decimal', 'Conditional', true, 'list_unit_price', 'numeric'),
  c('ContractedUnitPrice', 'Decimal', 'Conditional', true, 'contracted_unit_price', 'numeric'),
  c('PricingQuantity', 'Decimal', 'Mandatory', true, 'pricing_quantity', 'numeric', true),
  c('PricingUnit', 'String', 'Mandatory', true, 'pricing_unit', 'text'),
  c('ConsumedQuantity', 'Decimal', 'Conditional', true, 'consumed_quantity', 'numeric', true),
  c('ConsumedUnit', 'String', 'Conditional', true, 'consumed_unit', 'text'),
  c('BillingCurrency', 'String', 'Mandatory', false, 'billing_currency', 'text'),
  // When, and which period
  c('ChargePeriodStart', 'DateTime', 'Mandatory', false, 'charge_period_start', 'timestamptz'),
  c('ChargePeriodEnd', 'DateTime', 'Mandatory', false, 'charge_period_end', 'timestamptz'),
  c('BillingPeriodStart', 'DateTime', 'Mandatory', false, 'billing_period_start', 'timestamptz'),
  c('BillingPeriodEnd', 'DateTime', 'Mandatory', false, 'billing_period_end', 'timestamptz'),
  // What it is, and who provides it
  c('ChargeCategory', 'String', 'Mandatory', false, 'charge_category', 'text'),
  c('ChargeClass', 'String', 'Mandatory', true, 'charge_class', 'text'),
  c('ChargeDescription', 'String', 'Mandatory', true, 'charge_description', 'text'),
  c('ChargeFrequency', 'String', 'Recommended', false, 'charge_frequency', 'text'),
  c('PricingCategory', 'String', 'Conditional', true, 'pricing_category', 'text'),
  c('ServiceCategory', 'String', 'Mandatory', false, 'service_category', 'text'),
  c('ServiceSubcategory', 'String', 'Recommended', false, 'service_subcategory', 'text'),
  c('ServiceName', 'String', 'Mandatory', false, 'service_name', 'text'),
  c('ServiceProviderName', 'String', 'Mandatory', false, 'service_provider_name', 'text'),
  c('HostProviderName', 'String', 'Mandatory', true, 'host_provider_name', 'text'),
  c('InvoiceIssuerName', 'String', 'Mandatory', false, 'invoice_issuer_name', 'text'),
  c('BillingAccountId', 'String', 'Mandatory', false, 'billing_account_id', 'text'),
  c('BillingAccountName', 'String', 'Mandatory', true, 'billing_account_name', 'text'),
  c('SubAccountId', 'String', 'Conditional', true, 'sub_account_id', 'text'),
  c('SubAccountName', 'String', 'Conditional', true, 'sub_account_name', 'text'),
  c('SubAccountType', 'String', 'Conditional', true, 'sub_account_type', 'text'),
  c('InvoiceId', 'String', 'Conditional', true, 'invoice_id', 'text'),
  // The resource and the price line
  c('ResourceId', 'String', 'Conditional', true, 'resource_id', 'text'),
  c('ResourceName', 'String', 'Conditional', true, 'resource_name', 'text'),
  c('ResourceType', 'String', 'Conditional', true, 'resource_type', 'text'),
  c('SkuId', 'String', 'Conditional', true, 'sku_id', 'text'),
  c('SkuMeter', 'String', 'Conditional', true, 'sku_meter', 'text'),
  c('SkuPriceId', 'String', 'Conditional', true, 'sku_price_id', 'text'),
  c('SkuPriceDetails', 'JSON', 'Conditional', true, 'sku_price_details', 'jsonb'),
  c('Tags', 'JSON', 'Conditional', true, 'tags', 'jsonb'),
  // Split cost allocation: cluster cost, workloads and idle
  c('AllocatedMethodId', 'String', 'Conditional', true, 'allocated_method_id', 'text'),
  c('AllocatedMethodDetails', 'JSON', 'Recommended', true, 'allocated_method_details', 'jsonb'),
  c('AllocatedResourceId', 'String', 'Conditional', true, 'allocated_resource_id', 'text'),
  c('AllocatedResourceName', 'String', 'Conditional', true, 'allocated_resource_name', 'text'),
  c('AllocatedTags', 'JSON', 'Conditional', true, 'allocated_tags', 'jsonb'),
];

/** Landledger's custom columns (docs/research/focus.md §7). */
export const CUSTOM_COLUMNS: readonly FocusColumn[] = [
  c('x_RecordId', 'String', 'Custom', false, 'record_id', 'text'),
  c('x_Basis', 'String', 'Custom', false, 'basis', 'text'),
  c('x_Source', 'String', 'Custom', false, 'source', 'text'),
  c('x_SourceKey', 'String', 'Custom', false, 'source_key', 'text'),
  c('x_SourceCost', 'Decimal', 'Custom', true, 'source_cost', 'numeric', true),
  c('x_RateCardVersion', 'String', 'Custom', true, 'rate_card_version_id', 'text'),
  c('x_IngestRunId', 'String', 'Custom', false, 'ingest_run_id', 'text'),
  c('x_CorrectionOfId', 'String', 'Custom', true, 'correction_of_id', 'text'),
  c('x_WorkflowId', 'String', 'Custom', true, 'workflow_id', 'text'),
  c('x_AgentId', 'String', 'Custom', true, 'agent_id', 'text'),
  c('x_ActorId', 'String', 'Custom', true, 'actor_id', 'text'),
];

/** Every column a record carries, FOCUS first: the `cost_records_focus` view's column list, in order. */
export const COLUMNS: readonly FocusColumn[] = [...FOCUS_COLUMNS, ...CUSTOM_COLUMNS];

/**
 * Columns of `cost_records` that are not FOCUS: the ledger's own bookkeeping, never in the view.
 * `source_revision` counts entries per source key and basis (a reversal carries its original's), `is_reversal` is
 * generated from `correction_of_id`, `seq` orders rows, `recorded_at` is when the row was appended.
 */
export const LEDGER_COLUMNS = ['seq', 'source_revision', 'is_reversal', 'recorded_at'] as const;

/** The FOCUS 1.4 cost-and-usage columns Landledger leaves out, each for a reason (docs/research/focus.md §4). */
export const DROPPED_COLUMNS: Readonly<Record<string, string>> = {
  AvailabilityZone: 'One local machine; back with a cloud bill (wave 5)',
  RegionId: 'One local machine; back with a cloud bill (wave 5)',
  RegionName: 'One local machine; back with a cloud bill (wave 5)',
  CapacityReservationId: 'No reserved capacity',
  CapacityReservationStatus: 'No reserved capacity',
  CommitmentDiscountCategory: 'No commitment discounts yet (wave 5)',
  CommitmentDiscountId: 'No commitment discounts yet (wave 5)',
  CommitmentDiscountName: 'No commitment discounts yet (wave 5)',
  CommitmentDiscountQuantity: 'No commitment discounts yet (wave 5)',
  CommitmentDiscountStatus: 'No commitment discounts yet (wave 5)',
  CommitmentDiscountType: 'No commitment discounts yet (wave 5)',
  CommitmentDiscountUnit: 'No commitment discounts yet (wave 5)',
  CommitmentProgramEligibilityDetails: 'No commitment discounts yet (wave 5)',
  ContractApplied: "Contracts are wave 3's table",
  PricingCurrency: 'Every price is in USD (decision 6)',
  PricingCurrencyContractedUnitPrice: 'Every price is in USD (decision 6)',
  PricingCurrencyEffectiveCost: 'Every price is in USD (decision 6)',
  PricingCurrencyListUnitPrice: 'Every price is in USD (decision 6)',
  InvoiceDetailId: 'Invoice Detail is wave 3',
  BillingAccountType: 'One account type per issuer',
};

const byName = new Map(COLUMNS.map((col) => [col.name, col]));

export function columnOf(name: string): FocusColumn | undefined {
  return byName.get(name);
}

/** The additive columns: what a reversal negates and what sums. */
export const ADDITIVE_COLUMNS: readonly string[] = COLUMNS.filter((col) => col.additive).map((col) => col.name);
