/**
 * Wave 3's contract, "Plan and reconcile" (specs 005–011): invoices and reconciliation, the year ahead, anomalies,
 * agents' unit economics, contracts and seats, the access review. Amounts on the wire are six-decimal strings in USD
 * (`Amount`), never JSON numbers; inputs take decimal strings.
 */
import { z } from 'zod';

const Day = z.iso.date();
const PositiveAmount = z.string().regex(/^\d+(\.\d{1,6})?$/, 'a non-negative amount as a decimal string, ≤ 6 decimals');
/** An amount in major units with six decimals (`"1840.000000"`). */
type Amount = string;

// 005 Invoices and reconciliation ----------------------------------------------------------------------------------

/**
 * `POST /api/invoices/import` (a controller or the CFO, signed in): a CSV with the header
 * `provider,invoice_number,period,model,sku,quantity,unit,amount,currency` and optional `charge_category`
 * (`Usage` default, `Credit`, `Tax`, `Adjustment`, `Purchase`) and `description`. USD only (422). A bad file imports
 * nothing; every problem is reported by line. Importing a provider's invoice number again corrects it by reversal and
 * re-entry. `origin: dev-fixture` labels a development fixture (shown as such everywhere).
 */
export const InvoiceImportInput = z.object({
  csv: z.string().min(1).max(2_000_000),
  fileName: z.string().max(300).optional(),
  note: z.string().trim().max(1000).default(''),
  origin: z.enum(['entered', 'dev-fixture']).default('entered'),
});
export type InvoiceImportInput = z.input<typeof InvoiceImportInput>;

export const InvoiceVoidInput = z.object({ reason: z.string().trim().min(3).max(1000) });

export const ReconcileStatus = z.enum(['matched', 'outside', 'not_invoiced', 'no_estimate']);
export type ReconcileStatus = z.infer<typeof ReconcileStatus>;

export interface InvoiceLineView {
  line: number;
  model: string | null;
  sku: string | null;
  quantity: string | null;
  unit: string | null;
  amount: Amount;
  chargeCategory: 'Usage' | 'Credit' | 'Tax' | 'Adjustment' | 'Purchase';
  description: string;
}

export interface InvoiceView {
  /** `inv_…`: one id per provider and invoice number, across versions. */
  id: string;
  provider: string;
  number: string;
  month: string;
  version: number;
  status: 'posted' | 'voided';
  origin: 'entered' | 'dev-fixture';
  total: Amount;
  lines: InvoiceLineView[];
  /** What the last import did to the ledger. */
  posted: { added: number; reversed: number; unchanged: number; linkedEstimates: number };
  /** Booked in the open month as `ChargeClass = Correction` because its month is locked. */
  correction: boolean;
  importedBy: string;
  importedAt: string;
  note: string;
  fileSha256: string;
}

export interface ReconciliationRow {
  provider: string;
  model: string;
  month: string;
  /** Every live estimate of the provider and model in the month, linked to an invoice or not. */
  estimated: Amount;
  invoiced: Amount;
  /** invoiced − estimated. */
  variance: Amount;
  /** variance ÷ estimated, percent with one decimal; null when nothing was estimated. */
  variancePct: string | null;
  status: ReconcileStatus;
  invoices: string[];
}

export interface ReconciliationView {
  month: string;
  currency: string;
  /** The tolerance, percent (`"2"`: ±2%). */
  tolerancePct: string;
  rows: ReconciliationRow[];
  totals: {
    estimated: Amount;
    invoiced: Amount;
    variance: Amount;
    variancePct: string | null;
    /** Of the month's AI spend as shown (each charge once), the share that is invoiced, percent. */
    invoicedShare: string;
    within: boolean;
  };
  invoices: InvoiceView[];
}

/** An approved request from decision to bill (spec 005). */
export interface RequestLifecycle {
  requestId: string;
  stages: {
    key: 'approved' | 'reserved' | 'consumed' | 'invoiced';
    label: string;
    amount: Amount | null;
    at: string | null;
    note: string;
  }[];
  /** The months the request has run so far: what it was approved for in them. */
  approvedToDate: Amount;
  /** What it consumed, at the invoiced figure where its matched cost is invoiced. */
  actualToDate: Amount;
  /** actualToDate − approvedToDate. */
  variance: Amount;
  variancePct: string | null;
  invoicedShare: string;
}

// 006 Forecasts -----------------------------------------------------------------------------------------------------

export interface ForecastMonth {
  month: string;
  days: number;
  /** The run rate over the month's days (or the days left of the current month), with its band; null without data. */
  runRate: { p10: Amount; p50: Amount; p90: Amount } | null;
  /** Month to date (the current and past months). */
  actual: Amount;
  /** Reservations still held in the month. */
  reserved: Amount;
  /** Approved monthly requests beyond their reserved months. */
  committed: Amount;
  /** actual + run rate P50 + reserved + committed. */
  total: Amount | null;
  budget: Amount | null;
  state: 'ok' | 'risk' | 'over' | 'none' | 'early';
}

/** `GET /api/forecast?months=12`: the year ahead. */
export interface ForecastView {
  from: string;
  months: ForecastMonth[];
  status: 'ok' | 'insufficient';
  basis: string;
  annualised: {
    /** The run rate's cost per day × 365 (P10, P50, P90); null without data. */
    runRate: { p10: Amount; p50: Amount; p90: Amount } | null;
    /** Every approved monthly commitment active now, × 12. */
    commitments: Amount;
    /** Σ of the months shown. */
    total: Amount | null;
    budget: Amount | null;
  };
  commitments: {
    requestId: string;
    number: string;
    title: string;
    costCenter: string;
    monthly: Amount;
    reservedThrough: string | null;
  }[];
}

// 007 Anomalies -----------------------------------------------------------------------------------------------------

export const AnomalyKind = z.enum(['cost', 'approval']);
export type AnomalyKind = z.infer<typeof AnomalyKind>;

export const AnomalyRule = z.enum(['cost_jump', 'split', 'automatic_ratchet', 'fast_relay', 'same_pair']);
export type AnomalyRule = z.infer<typeof AnomalyRule>;

export const AgentsQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

export const ForecastQuery = z.object({ months: z.coerce.number().int().min(1).max(24).default(12) });

export const ReconciliationQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

export const AnomaliesQuery = z.object({
  status: z.enum(['open', 'all']).default('open'),
  kind: AnomalyKind.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const AcknowledgeInput = z.object({ note: z.string().trim().min(3).max(1000) });

export interface AnomalyView {
  id: string;
  kind: AnomalyKind;
  rule: AnomalyRule;
  /** Cost: `costCenter`, `service`, `agent`, `model`; approval: `requester`, `costCenter`, `approver`, `request`. */
  dimension: string;
  key: string;
  label: string;
  /** The day (cost) or the window's start (approval). */
  windowStart: string;
  windowEnd: string;
  /** In words, with the figures. */
  summary: string;
  /** Cost: the day's cost, the baseline's median and MAD, the robust score. */
  observed: Amount | null;
  baseline: Amount | null;
  mad: Amount | null;
  score: string | null;
  costCenter: string | null;
  requests: { id: string; number: string; title: string }[];
  detectedAt: string;
  acknowledged: { by: string; at: string; note: string } | null;
  /** A dev-only test spike's (source `dev-anomaly`), never a real cost. */
  dev: boolean;
}

export interface CostAnomalyData {
  anomaly: AnomalyView;
  url: string;
}

// 008 Agents --------------------------------------------------------------------------------------------------------

export const AgentSuggestion = z.enum(['keep', 'scale', 'review', 'retire']);
export type AgentSuggestion = z.infer<typeof AgentSuggestion>;

export interface AgentRow {
  /** Landflow's agent id (`ag_…`), or Clickland's key when only Clickland knows it. */
  id: string;
  name: string;
  cost: { total: Amount; models: Amount; compute: Amount | null; invoiced: Amount };
  costCenter: { code: string; name: string } | null;
  owner: string | null;
  /** From Clickland's Agent Value; null without a match or without Clickland. */
  value: {
    runs: number;
    outcomes: number;
    successRate: string | null;
    /** Clickland's value, USD (capacity, not cash). */
    value: Amount;
    hoursSaved: string;
    clicklandKey: string;
  } | null;
  costPerOutcome: Amount | null;
  valuePerOutcome: Amount | null;
  suggestion: AgentSuggestion;
  /** The rule that gave the suggestion, in words. */
  why: string;
}

export interface AgentsView {
  month: string;
  from: string;
  to: string;
  currency: string;
  agents: AgentRow[];
  totals: { cost: Amount; invoiced: Amount; outcomes: number; hoursSaved: string; capacity: Amount };
  clickland: { status: 'ok' | 'unconfigured' | 'unavailable'; hourlyRate: string | null; note: string };
  /** Compute isn't attributed to agents yet (no agent labels on workloads): said, not shown as zero. */
  computeNote: string;
}

/** What an AI budget raise buys, in the request's evidence. */
export interface AgentEconomics {
  agentId: string;
  name: string;
  month: string;
  cost: Amount;
  outcomes: number | null;
  costPerOutcome: Amount | null;
  valuePerOutcome: Amount | null;
  suggestion: AgentSuggestion;
  why: string;
  /** The request's monthly amount ÷ the cost per outcome: outcomes a month it buys at this month's rate. */
  buys: string | null;
  source: string;
}

// 009 Contracts and 010 seats ---------------------------------------------------------------------------------------

/**
 * `POST /api/contracts/import` (a controller or the CFO, signed in): header
 * `vendor,product,cost_center,tcv,currency,term_start,term_end,seats_paid,seats_used,renewal_date,notice_days`,
 * optional `auto_renew` (`true`/`false`, default true) and `landbright_app`. USD only (422).
 */
export const ContractImportInput = z.object({
  csv: z.string().min(1).max(1_000_000),
  fileName: z.string().max(300).optional(),
  note: z.string().trim().max(1000).default(''),
  origin: z.enum(['entered', 'dev-fixture']).default('entered'),
});
export type ContractImportInput = z.input<typeof ContractImportInput>;

export interface ContractView {
  /** `con_…`, stable across versions (vendor and product). */
  id: string;
  version: number;
  vendor: string;
  product: string;
  costCenter: { code: string; name: string };
  tcv: Amount;
  annualValue: Amount;
  termStart: string;
  termEnd: string;
  termMonths: number;
  seats: { paid: number; used: number; reserved: number; left: number } | null;
  /** The contract's price per seat a month: annual value ÷ seats paid ÷ 12. */
  seatPrice: Amount | null;
  renewalDate: string;
  noticeDays: number;
  noticeDate: string;
  autoRenew: boolean;
  landbrightApp: string | null;
  /** Today is inside [notice date − window, renewal date]. */
  inNoticeWindow: boolean;
  daysToNotice: number;
  origin: 'entered' | 'dev-fixture' | 'request';
  requestId: string | null;
  importedBy: string;
  importedAt: string;
}

export interface ContractsView {
  today: string;
  windowDays: number;
  /** Inside the notice window first (by notice date), then the rest by renewal date. */
  contracts: ContractView[];
  totals: { annualValue: Amount; tcv: Amount; seatsPaid: number; seatsUsed: number };
}

/** A contract request's terms (kind `contract`): the amount is the TCV, once. Seats are what it reserves. */
export const ContractTerms = z.object({
  vendor: z.string().trim().min(1).max(200),
  product: z.string().trim().min(1).max(200),
  tcv: PositiveAmount,
  termMonths: z.number().int().min(1).max(120),
  start: Day,
  seats: z.number().int().min(1).max(100_000).optional(),
  noticeDays: z.number().int().min(0).max(365).default(30),
  autoRenew: z.boolean().default(true),
  landbrightApp: z.string().trim().min(1).max(200).optional(),
  /** The contract it renews or extends, if any. */
  contractId: z.string().min(1).max(100).optional(),
});
export type ContractTerms = z.input<typeof ContractTerms>;

/** A seat request's terms (kind `tool_or_seat`): the amount is seats × seat price a month. */
export const SeatTerms = z.object({
  contractId: z.string().min(1).max(100),
  seats: z.number().int().min(1).max(100).default(1),
  seatPrice: PositiveAmount,
});
export type SeatTerms = z.input<typeof SeatTerms>;

/** The seat a request reserves, and where it stands. */
export interface SeatView {
  contractId: string;
  vendor: string;
  product: string;
  seats: number;
  seatPrice: Amount;
  status: 'none' | 'reserved' | 'applied' | 'released';
}

/** In a seat request's evidence. */
export interface SeatEvidence {
  contractId: string;
  vendor: string;
  product: string;
  renewalDate: string;
  paid: number;
  used: number;
  reserved: number;
  leftNow: number;
  leftAfter: number;
  seatPrice: Amount;
  contractSeatPrice: Amount | null;
  note: string | null;
}

/** `GET /api/contracts/seats?landbrightApp=`: what Landflow needs to raise a seat request. */
export interface ContractSeats {
  contract: ContractView;
  seatPrice: Amount | null;
  left: number;
}

export interface ContractRenewalDueData {
  contract: ContractView;
  url: string;
}

// 011 Access review ---------------------------------------------------------------------------------------------------

export const AccessItemKind = z.enum(['person', 'key', 'link', 'relay_channel', 'owner']);
export type AccessItemKind = z.infer<typeof AccessItemKind>;

export const AttestInput = z
  .object({ decision: z.enum(['keep', 'revoke']), comment: z.string().trim().max(1000).default('') })
  .refine((a) => a.decision === 'keep' || a.comment.length >= 3, {
    message: 'Say why it should be revoked (3 characters or more)',
    path: ['comment'],
  });
export type AttestInput = z.input<typeof AttestInput>;

export interface AccessItemView {
  id: string;
  kind: AccessItemKind;
  subjectId: string;
  label: string;
  /** What it grants, in words (`CFO · read, requests:write, admin`). */
  detail: string;
  snapshot: Record<string, unknown>;
  /** The people (`usr_…`) it is about: they never attest it. */
  about: string[];
  attestation: { decision: 'keep' | 'revoke'; comment: string; by: string; at: string } | null;
}

export interface AccessReviewView {
  id: string;
  quarter: string;
  status: 'open' | 'completed';
  openedBy: string;
  openedAt: string;
  completedAt: string | null;
  items: AccessItemView[];
  counts: { total: number; attested: number; revoke: number };
}

export interface AccessReviewDueData {
  quarter: string;
  reviewId: string | null;
  url: string;
}
