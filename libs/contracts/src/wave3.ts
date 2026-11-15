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
 * re-entry. The period is a month that is over in LANDLEDGER_TZ (400 otherwise); an invoice keeps its month (409 to
 * change it while posted: void it first). `origin: dev-fixture` is accepted only while the API runs with dev auth on
 * this machine (403 otherwise): its records are tagged and left out of every total, the invoiced share, budgets,
 * exports, MCP and the cost metrics, and shown only on Reconciliation with a badge.
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
  /** A dev fixture's lines, against the same estimates: shown with a badge, in no total (review of wave 3). */
  devFixture: boolean;
  /**
   * Estimates that arrived after the month was invoiced: left out of every figure (linked `late`), waiting for the
   * invoice to be imported again so the split covers them.
   */
  lateEstimates: number;
  /** `estimates after invoice: re-reconcile` when there are late estimates; null otherwise. */
  note: string | null;
}

export interface ReconciliationView {
  month: string;
  currency: string;
  /** The tolerance, percent (`"2"`: ±2%). */
  tolerancePct: string;
  /** A variance at most this is within whatever the percent (`"0.500000"`; review of wave 3). */
  toleranceUsd: string;
  rows: ReconciliationRow[];
  totals: {
    estimated: Amount;
    invoiced: Amount;
    variance: Amount;
    variancePct: string | null;
    /** Of the month's AI spend as shown (each charge once), the share that is invoiced, percent. */
    invoicedShare: string;
    within: boolean;
    /** Late estimates across the month's rows (dev fixtures apart). */
    lateEstimates: number;
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
  /** Reservations still held in the month, net of what the run rate already projects of their requests. */
  reserved: Amount;
  /** Approved monthly requests beyond their reserved months, net the same way. */
  committed: Amount;
  /** What real contracts hold in the month: annual value ÷ 12 over the term, pro rata by day. */
  contracted: Amount;
  /** actual + run rate P50 + reserved + committed + contracted (the current month: Overview's forecast). */
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
    /** What every approved monthly request adds over the next 12 months, bounded by its end date. */
    commitments: Amount;
    /** What contracts hold over the next 12 months. */
    contracted: Amount;
    /** Σ of the next 12 months' totals (whatever `months` shows). */
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
  /** Open: not closed, however old (nothing ages out). */
  status: z.enum(['open', 'all']).default('open'),
  kind: AnomalyKind.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const AcknowledgeInput = z.object({ note: z.string().trim().min(3).max(1000) });

export const AnomalyOutcome = z.enum(['expected', 'fixed', 'false_positive']);
export type AnomalyOutcome = z.infer<typeof AnomalyOutcome>;

/** Assigns an anomaly to an active person, by id or email (never someone the pattern names). */
export const AssignAnomalyInput = z.object({
  assignee: z
    .object({ id: z.string().min(1).max(100).optional(), email: z.string().email().max(320).optional() })
    .refine((a) => !!a.id || !!a.email, 'an id or an email'),
  note: z.string().trim().max(1000).default(''),
});

/** Closes an anomaly once, with an outcome and a note. */
export const CloseAnomalyInput = z.object({ outcome: AnomalyOutcome, note: z.string().trim().min(3).max(1000) });

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
  /** Cost: the day's cost when first found, the baseline's median and MAD, the robust score (the latest). */
  observed: Amount | null;
  /** Cost: the day's cost as last seen (it follows the day as it accrues), and when. */
  current: Amount | null;
  currentAt: string;
  /** How many times it alerted: once when found, and again each time the figure doubled since the last alert. */
  alerts: number;
  baseline: Amount | null;
  mad: Amount | null;
  score: string | null;
  costCenter: string | null;
  requests: { id: string; number: string; title: string }[];
  detectedAt: string;
  acknowledged: { by: string; at: string; note: string } | null;
  /** Who it is assigned to now (the latest assignment), by whom. */
  assignee: { id: string; name: string; by: string; at: string } | null;
  closed: { by: string; at: string; outcome: AnomalyOutcome; note: string } | null;
  status: 'open' | 'acknowledged' | 'closed';
  /** The people an approval pattern names (user ids): they never acknowledge, assign or close it. */
  named: string[];
  /** Found only with a dev-only test spike (source `dev-anomaly`) in it: the real cost alone was ordinary. */
  dev: boolean;
}

export interface CostAnomalyData {
  anomaly: AnomalyView;
  url: string;
}

// 008 Agents --------------------------------------------------------------------------------------------------------

/** `not_measured`: Clickland reports no outcomes for the agent (none instrumented), so nothing about value is said. */
export const AgentSuggestion = z.enum(['keep', 'scale', 'review', 'retire', 'not_measured']);
export type AgentSuggestion = z.infer<typeof AgentSuggestion>;

export interface AgentRow {
  /** Landflow's agent id (`ag_…`), or Clickland's key when only Clickland knows it. */
  id: string;
  name: string;
  cost: { total: Amount; models: Amount; compute: Amount | null; invoiced: Amount };
  costCenter: { code: string; name: string } | null;
  owner: string | null;
  /**
   * Whether Clickland measures this agent's outcomes (it says the agent is instrumented, or reports outcomes for it).
   * Without that, "no outcome" means nothing: the row says "Outcomes not measured".
   */
  measured: boolean;
  /** From Clickland's Agent Value; null without a match or without Clickland. */
  value: {
    runs: number;
    /** Self-reported: the agent's own telemetry, as Clickland's outcome definitions credit it. */
    outcomes: number;
    outcomesSource: 'self-reported';
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
  /** Outcomes are the agent's own telemetry (self-reported), and whether Clickland measures them at all. */
  outcomesSource: 'self-reported';
  measured: boolean;
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
 * optional `auto_renew` (`true`/`false`, default true), `landbright_app` and `seats_used_as_of` (the day the count was
 * taken; default the import day). USD only (422). A new contract, or a TCV raised by more than the second-person line
 * (USD 25,000), is held as a pending `contract` request (origin `contract_import`) that a second person approves under
 * the policy; the rest is entered at once and listed in the exceptions report unless an approved contract request
 * covers it. `dev-fixture` is for a development API only (dev auth on this machine).
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
  /**
   * The last business day (LANDLEDGER_BUSINESS_DAYS, holidays, in LANDLEDGER_TZ) on or before renewal − notice days:
   * when notice must be given by.
   */
  noticeDate: string;
  /** Renewal − notice days, as the contract counts it (it may fall on a weekend or holiday). */
  noticeCalendarDate: string;
  autoRenew: boolean;
  landbrightApp: string | null;
  /** The day `seats.used` was counted (the CSV's `seats_used_as_of`, or the import day). */
  seatsUsedAsOf: string | null;
  /** An approved (or applied) contract request covers this version; false lists it in the exceptions report. */
  covered: boolean;
  /** Today is inside [notice date − window, renewal date]. */
  inNoticeWindow: boolean;
  daysToNotice: number;
  origin: 'entered' | 'dev-fixture' | 'request';
  requestId: string | null;
  importedBy: string;
  importedAt: string;
}

/** A contract import held for a second person: the pending contract request it raised. */
export interface HeldContractImport {
  requestId: string;
  number: string;
  status: string;
  vendor: string;
  product: string;
  tcv: Amount;
  /** The TCV it raises from (null: a new contract). */
  previousTcv: Amount | null;
  importedBy: string;
  at: string;
}

export interface ContractsView {
  today: string;
  windowDays: number;
  /** Inside the notice window first (by notice date), then the rest by renewal date. */
  contracts: ContractView[];
  /** Imports waiting for a second person (open contract requests from an import). */
  held: HeldContractImport[];
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
  /** From a held import: the CSV's own term end and renewal date (otherwise start + termMonths). */
  termEnd: Day.optional(),
  renewalDate: Day.optional(),
  /** From a held import: seats used and the day they were counted. */
  seatsUsed: z.number().int().min(0).max(100_000).optional(),
  seatsUsedAsOf: Day.optional(),
});
export type ContractTerms = z.input<typeof ContractTerms>;

/**
 * `POST /api/requests/:id/seats/release` (the creating key, the requester or sponsor, or an admin person): the cost was
 * approved but Landbright denied the access, or a grant was revoked. A reserved seat is released (and the request's
 * reservations with it); an applied seat is released when its grant was revoked. Sends `seat.released`.
 */
export const SeatReleaseInput = z.object({
  reason: z.enum(['access_denied', 'grant_revoked', 'not_needed']),
  note: z.string().trim().max(1000).default(''),
});
export type SeatReleaseInput = z.input<typeof SeatReleaseInput>;

/** `seat.released`: seats went back to their contract. */
export interface SeatReleasedData {
  requestId: string;
  number: string;
  contractId: string;
  seats: number;
  reason: 'access_denied' | 'grant_revoked' | 'not_needed' | 'expired';
  from: 'reserved' | 'applied';
  url: string;
}

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

export const AccessItemKind = z.enum(['person', 'key', 'link', 'relay_channel', 'owner', 'webhook', 'session']);
export type AccessItemKind = z.infer<typeof AccessItemKind>;

/**
 * Keep, or revoke with a reason. A key, a Slack link or a person's sessions are revoked at once when the attester
 * confirms (`confirm: true`, required for those); every other revoke is tracked until the access is gone, and the
 * review completes only when none is outstanding.
 */
export const AttestInput = z
  .object({
    decision: z.enum(['keep', 'revoke']),
    comment: z.string().trim().max(1000).default(''),
    confirm: z.boolean().default(false),
  })
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
  /** The people (`usr_…`) it is about, as snapshotted and as they stand now: they never attest it. */
  about: string[];
  /** Picked up after the review opened (a key minted, a deputy named); null for the opening snapshot. */
  addedAt: string | null;
  /** Nobody in Landledger stands behind it (a key a system minted): only the CFO attests it. */
  cfoOnly: boolean;
  attestation: { decision: 'keep' | 'revoke'; comment: string; by: string; at: string } | null;
  /** What Landledger revoked itself when the attester confirmed (a key, a link, sessions). */
  revocation: { how: string; by: string; at: string } | null;
  /** A revoke whose access is still there: the review does not complete while any is. */
  outstanding: boolean;
}

export interface AccessReviewView {
  id: string;
  quarter: string;
  status: 'open' | 'completed';
  openedBy: string;
  openedAt: string;
  completedAt: string | null;
  items: AccessItemView[];
  counts: { total: number; attested: number; revoke: number; outstanding: number; added: number };
}

export interface AccessReviewDueData {
  quarter: string;
  reviewId: string | null;
  url: string;
  /** A weekly reminder while the quarter's review is not complete (the first notice is not one). */
  reminder?: boolean;
  /** `access_review.missed`: the quarter ended with its review not complete (or never opened). */
  missed?: boolean;
}
