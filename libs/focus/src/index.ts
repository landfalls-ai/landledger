/**
 * The FOCUS columns Landledger keeps on `cost_records`, and its `x_` extension columns.
 *
 * TODO(specs/001-money-and-records): this is the minimal set docs/architecture.md names ("The data"). The research
 * study is reading the FOCUS 1.4 specification now; when specs/001 lands, this list, the allowed values and the
 * checks follow it (adding a column is a new migration, never an edit of 0001). Until then, nothing here claims to be
 * complete FOCUS.
 */

/** A FOCUS column (PascalCase, as the specification names it) and the snake_case column that holds it in Postgres. */
export interface FocusColumn {
  focus: string;
  column: string;
  /** What Landledger keeps in it. */
  about: string;
}

/** The FOCUS columns, minimal for now (TODO: specs/001). */
export const FOCUS_COLUMNS = [
  {
    focus: 'ChargePeriodStart',
    column: 'charge_period_start',
    about: 'Start of the charge (inclusive); partitions the table by month',
  },
  { focus: 'ChargePeriodEnd', column: 'charge_period_end', about: 'End of the charge (exclusive)' },
  { focus: 'ChargeCategory', column: 'charge_category', about: 'Usage, Purchase, Tax, Credit or Adjustment' },
  { focus: 'ChargeClass', column: 'charge_class', about: 'Correction for a correcting row, otherwise empty' },
  { focus: 'ChargeDescription', column: 'charge_description', about: 'What the charge is, in words' },
  { focus: 'ServiceName', column: 'service_name', about: 'The service the charge is for' },
  { focus: 'ProviderName', column: 'provider_name', about: 'Who provides it (Own cluster, Anthropic, GitHub)' },
  { focus: 'ResourceId', column: 'resource_id', about: 'The resource (deploy/landflow-host, agent/triage-lead)' },
  { focus: 'ConsumedQuantity', column: 'consumed_quantity', about: 'How much was used (exact numeric)' },
  { focus: 'ConsumedUnit', column: 'consumed_unit', about: 'In what unit (vCPU-hour, GiB-hour, GB-month, 1M tokens)' },
  { focus: 'ListUnitPrice', column: 'list_unit_price', about: 'The rate card or list price per unit (exact numeric)' },
  { focus: 'BilledCost', column: 'billed_cost_minor', about: 'Integer minor units of BillingCurrency' },
  {
    focus: 'EffectiveCost',
    column: 'effective_cost_minor',
    about: 'Integer minor units of BillingCurrency, after discounts',
  },
  { focus: 'BillingCurrency', column: 'billing_currency', about: 'ISO 4217 code' },
  { focus: 'Tags', column: 'tags', about: 'Key-value labels (namespace, workload, agent, workflow)' },
] as const satisfies readonly FocusColumn[];

/** Landledger's extension columns (FOCUS reserves the `x_` prefix for them). */
export const EXTENSION_COLUMNS = [
  { focus: 'x_Basis', column: 'x_basis', about: 'estimated (usage × rate card) or invoiced (matched to a bill)' },
  { focus: 'x_Source', column: 'x_source', about: 'Where the record came from (landflow, clickland, invoice, manual)' },
  { focus: 'x_RateCardVersion', column: 'x_rate_card_version', about: 'The rate card version that priced it' },
  { focus: 'x_IngestRun', column: 'x_ingest_run', about: 'The ingest run that appended it' },
] as const satisfies readonly FocusColumn[];

/** FOCUS ChargeCategory values (TODO: confirm against FOCUS 1.4 in specs/001). */
export const CHARGE_CATEGORIES = ['Usage', 'Purchase', 'Tax', 'Credit', 'Adjustment'] as const;
export type ChargeCategory = (typeof CHARGE_CATEGORIES)[number];

/** FOCUS ChargeClass: only corrections carry one. Records are append-only, so a correction is a new row. */
export const CHARGE_CLASSES = ['Correction'] as const;
export type ChargeClass = (typeof CHARGE_CLASSES)[number];

/** Every figure says what it is (docs/ui.md): usage × the rate card, or matched to a bill. */
export const BASES = ['estimated', 'invoiced'] as const;
export type Basis = (typeof BASES)[number];

/** Where records come from (TODO: specs/002-ingest). */
export const SOURCES = ['landflow', 'clickland', 'invoice', 'manual'] as const;
export type Source = (typeof SOURCES)[number];

/** The Postgres column for a FOCUS or extension column name. */
export function columnFor(focusName: string): string | undefined {
  return [...FOCUS_COLUMNS, ...EXTENSION_COLUMNS].find((c) => c.focus === focusName)?.column;
}
