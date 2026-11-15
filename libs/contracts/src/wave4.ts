/**
 * Wave 4's contract, "Month-end" (specs 012–019): periods and the close checklist, the four-eyes lock and a reopen by
 * request, accruals and their journal entry, the stored forecast, variance notes (an agent drafts, an analyst
 * accepts), the frozen close snapshot, the Datarails connector (against fake-datarails), the month-end package and the
 * cost of a window of services. Amounts on the wire are six-decimal strings in USD (`Amount`), never JSON numbers.
 *
 * After the contract's first commit it changes only additively: new optional fields, new routes, new events.
 */
import { z } from 'zod';

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month, YYYY-MM');
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256, 64 hex characters');
const AmountIn = z.string().regex(/^-?\d+(\.\d{1,6})?$/, 'an amount as a decimal string, ≤ 6 decimals');
/** An amount in major units with six decimals (`"1840.000000"`). */
type Amount = string;

// 012 Periods and the close -----------------------------------------------------------------------------------------

/**
 * The close checklist of a month, in order. Each step's gate is computed by Landledger, never ticked by hand:
 * 1 `usage_ingested`: the month has ended, every source has a complete run for every day since its first data, no
 *   provisional rows are left and every record is allocated;
 * 2 `reconciled`: every AI provider × model row is within tolerance (or has nothing to invoice), or is explained;
 * 3 `unallocated`: Unallocated spend is at most its limit (`LANDLEDGER_CLOSE_UNALLOCATED_PCT`, default 5% of the month);
 * 4 `no_dev_rows`: no live dev-fixture record and no `dev-anomaly` row in the month (never explained);
 * 5 `no_open_anomalies`: no anomaly of the month is still open;
 * 6 `no_outstanding_revokes`: no access-review revoke is outstanding;
 * 7 `accrual_accepted`: the month's accrual proposal is accepted by a controller (this freezes the snapshot, spec 016);
 * 8 `notes_accepted`: every note the snapshot needs is accepted by an analyst;
 * 9 `datarails_uploaded`: the snapshot and the accepted notes were uploaded to Datarails;
 * 10 `locked`: a controller and the CFO, two people, signed the lock (never explained).
 */
export const CloseStepKey = z.enum([
  'usage_ingested',
  'reconciled',
  'unallocated',
  'no_dev_rows',
  'no_open_anomalies',
  'no_outstanding_revokes',
  'accrual_accepted',
  'notes_accepted',
  'datarails_uploaded',
  'locked',
]);
export type CloseStepKey = z.infer<typeof CloseStepKey>;

/** Steps a person may mark explained with a note: all but 4 (`no_dev_rows`) and 10 (`locked`). */
export const EXPLAINABLE_STEPS: readonly CloseStepKey[] = [
  'usage_ingested',
  'reconciled',
  'unallocated',
  'no_open_anomalies',
  'no_outstanding_revokes',
  'accrual_accepted',
  'notes_accepted',
  'datarails_uploaded',
];

/**
 * `done`: the gate is green; `explained`: red, and a person explained it (audited); `red`: the gate fails now (its
 * `problems` say why); `waiting`: an earlier step is not done or explained yet, so this one can't be acted on.
 */
export const CloseStepState = z.enum(['done', 'explained', 'red', 'waiting']);
export type CloseStepState = z.infer<typeof CloseStepState>;

export interface CloseExplanation {
  id: string;
  step: CloseStepKey;
  /** Step 2 explains one reconciliation row (`provider|model`); null for a whole step. */
  rowKey: string | null;
  note: string;
  by: string;
  at: string;
}

export interface CloseStepView {
  /** 1–10, the order the steps run in. */
  number: number;
  key: CloseStepKey;
  title: string;
  state: CloseStepState;
  /** What the gate found, in a line ("0.4% unallocated, limit 5%"). */
  summary: string;
  /** Why it is red, one line each. */
  problems: string[];
  /** Who did it and when: a person for 7–10 and explanations; `Landledger` for a computed gate (when it was checked). */
  by: string | null;
  at: string | null;
  explainable: boolean;
  explanations: CloseExplanation[];
  /** Step 2: each reconciliation row's state, so each can be explained on its own. */
  rows?: Array<{
    key: string;
    provider: string;
    model: string;
    status: string;
    estimated: Amount;
    invoiced: Amount;
    variancePct: string | null;
    ok: boolean;
    explained: boolean;
  }>;
}

export interface LockSignoff {
  person: { id: string; name: string; email: string | null };
  /** The role the person signed as. */
  role: 'controller' | 'cfo';
  at: string;
}

/** `GET /api/close?month=`: the month's close, computed now (a dry run for a month still open). */
export interface CloseView {
  month: string;
  status: 'open' | 'closing' | 'locked';
  /** A locked month reopened by an approved `period_reopen` request, waiting to be locked again. */
  reopened: boolean;
  /** How many times the month was reopened; signatures and locks are per round. */
  round: number;
  /** Has the month ended (in UTC, as the ledger books it)? */
  ended: boolean;
  /** True when this is a month still open: what the gates say today, nothing can be acted on. */
  dryRun: boolean;
  steps: CloseStepView[];
  /** Steps done or explained, of 10. */
  done: number;
  /** The first step not done or explained, or null when all are. */
  next: CloseStepKey | null;
  /** The frozen snapshot (step 7), if any: its id and sha256. */
  snapshot: { id: string; sha256: string; frozenAt: string; frozenBy: string; current: boolean } | null;
  /** This round's lock signatures (two people: a controller and the CFO). */
  signoffs: LockSignoff[];
  /** The lock of each round: who signed, when, the audit entry and its anchor. */
  locks: Array<{
    round: number;
    at: string;
    signoffs: LockSignoff[];
    auditSeq: number;
    auditHash: string;
    anchor: { seq: number; hash: string; at: string } | null;
    snapshotSha256: string | null;
  }>;
  reopens: Array<{
    round: number;
    requestId: string;
    number: number | null;
    reason: string;
    requestedBy: string;
    approvedBy: string | null;
    at: string;
  }>;
  /** A `period_reopen` request still pending for the month, if any. */
  pendingReopen: { requestId: string; number: number | null } | null;
  /** The limit step 3 checks against (percent). */
  unallocatedLimitPct: string;
}

/** `POST /api/close/:month/start`: open → closing (a controller or the CFO, signed in). Body optional. */
export const CloseStartInput = z.object({ note: z.string().trim().max(1000).default('') });

/**
 * `POST /api/close/:month/explain`: marks a red step explained with a note (a controller, the CFO or FP&A, signed in;
 * audited `close.explained`). Never step 4 or 10. Step 2 explains one row: `rowKey` `provider|model`.
 */
export const CloseExplainInput = z.object({
  step: CloseStepKey,
  rowKey: z.string().trim().min(1).max(300).optional(),
  note: z.string().trim().min(3).max(2000),
});
export type CloseExplainInput = z.input<typeof CloseExplainInput>;

/**
 * `POST /api/close/:month/lock` (also `POST /api/periods/:month/lock`): a signature on the lock. The first person (a
 * controller or the CFO) signs; the lock happens when a second, different person signs, and the two are a controller
 * and the CFO. Steps 1–9 must be done or explained and the figures must still be the snapshot's.
 */
export const LockSignInput = z.object({
  /** The role to sign as, when the person holds both. */
  as: z.enum(['controller', 'cfo']).optional(),
  note: z.string().trim().max(1000).default(''),
});
export type LockSignInput = z.input<typeof LockSignInput>;

export interface LockResult {
  close: CloseView;
  /** True when this signature locked the month. */
  locked: boolean;
  /** Who still has to sign, when not locked yet. */
  waitingFor: Array<'controller' | 'cfo'>;
  /** The anchored audit entry of the lock. */
  anchor: { seq: number; hash: string; at: string } | null;
}

/**
 * `POST /api/close/:month/reopen`: a controller asks to reopen a locked month. It raises a `period_reopen` request
 * that only the CFO decides (and never the person who asked). Approved, the month is reopened: its ledger stays
 * closed to inserts (corrections still post to the open month), steps 8 and 9 can be done again, and it is locked
 * again by two people.
 */
export const ReopenInput = z.object({ reason: z.string().trim().min(10).max(2000) });
export type ReopenInput = z.input<typeof ReopenInput>;

// 013 Accruals ------------------------------------------------------------------------------------------------------

export const AccrualLineKind = z.enum(['usage', 'contract']);
export type AccrualLineKind = z.infer<typeof AccrualLineKind>;

export interface AccrualLineView {
  line: number;
  kind: AccrualLineKind;
  /** The provider (usage) or the vendor (contract). */
  provider: string;
  /** The model (usage) or the product (contract). */
  item: string;
  costCenter: string;
  costCenterName: string;
  plClass: string;
  amount: Amount;
  /** Usage: how many estimates it accrues; contract: the contract's id. */
  estimates: number;
  contractId: string | null;
  basis: string;
  /** Reversed when the invoice for it posted: the invoice and the month the reversal is booked in. */
  reversal: { invoice: string; month: string; at: string } | null;
}

export interface AccrualView {
  id: string;
  month: string;
  version: number;
  status: 'proposed' | 'accepted' | 'superseded';
  proposedBy: string;
  proposedAt: string;
  acceptedBy: string | null;
  acceptedAt: string | null;
  note: string;
  total: Amount;
  lines: AccrualLineView[];
  /** The snapshot accepting it froze (spec 016). */
  snapshotSha256: string | null;
  /** The sha256 of the lines as proposed: what the acceptor saw. */
  sha256: string;
}

/** `GET /api/accruals?month=`: the month's newest proposal and the reversals booked in it of earlier accruals. */
export interface AccrualsView {
  month: string;
  current: AccrualView | null;
  history: Array<Pick<AccrualView, 'id' | 'version' | 'status' | 'proposedAt' | 'proposedBy' | 'total'>>;
  /** Earlier months' accrual lines reversed in this month (their invoices posted in it). */
  reversalsIn: Array<{ accrualId: string; month: string; line: number; amount: Amount; invoice: string }>;
}

/** `POST /api/accruals/:month/propose` (a controller, the CFO or FP&A, signed in). */
export const AccrualProposeInput = z.object({ note: z.string().trim().max(1000).default('') });

/** `POST /api/accruals/:id/accept` (a controller, signed in): `sha256` is the proposal's, as shown. */
export const AccrualAcceptInput = z.object({ sha256: Sha256, note: z.string().trim().max(1000).default('') });
export type AccrualAcceptInput = z.input<typeof AccrualAcceptInput>;

// 014 Forecast history -----------------------------------------------------------------------------------------------

/** One stored forecast: a day's P10/P50/P90 to month-end for a cost center (or `TOTAL`). */
export interface StoredForecast {
  day: string;
  month: string;
  costCenter: string;
  p10: Amount | null;
  p50: Amount | null;
  p90: Amount | null;
  actualToDate: Amount;
  status: 'ok' | 'insufficient';
}

/** `GET /api/forecast/history?month=&costCenter=`: what was forecast each day, and day 10 against the actual. */
export interface ForecastHistoryView {
  month: string;
  costCenter: string;
  days: StoredForecast[];
  /** The forecast stored on calendar day 10 (or the last before it), the one variance notes cite. */
  day10: StoredForecast | null;
  /** At close: day 10's P50 against the actual (the snapshot's), percent; null before the snapshot or without day 10. */
  accuracy: { actual: Amount; p50: Amount; errorPct: string; within10: boolean } | null;
}

// 015 Variance notes ---------------------------------------------------------------------------------------------------

/** A figure a note may cite; each is checked against the frozen snapshot. */
export const NoteFigure = z.enum([
  'actual',
  'budget',
  'forecast_day10',
  'variance_budget',
  'variance_forecast',
  'driver_service',
  'driver_agent',
  'driver_model',
]);
export type NoteFigure = z.infer<typeof NoteFigure>;

export const NoteCite = z.object({
  figure: NoteFigure,
  /** For a driver: the service, agent or model key as the figures list it. */
  key: z.string().trim().max(300).optional(),
  /** The amount cited; must equal the snapshot's, to the cent. A driver cites its change against last month. */
  amount: AmountIn,
});
export type NoteCite = z.infer<typeof NoteCite>;

/** The figures of one note: a cost center's month (or `TOTAL`, the whole month), from the snapshot. */
export interface NoteFigures {
  costCenter: string;
  name: string;
  actual: Amount;
  budget: Amount | null;
  forecastDay10: Amount | null;
  varianceBudget: Amount | null;
  varianceBudgetPct: string | null;
  varianceForecast: Amount | null;
  drivers: Array<{
    dimension: 'service' | 'agent' | 'model';
    key: string;
    label: string;
    amount: Amount;
    previous: Amount;
    change: Amount;
  }>;
}

/**
 * `POST /api/notes/:month/drafts` (a key with `notes:draft`, or `admin`): an agent's draft for one cost center (or
 * `TOTAL`). Every cite is checked against the snapshot named by `snapshotSha256` (the current one); a mismatch is
 * refused (422, `details.mismatches`). The draft names its agent and the agent's sponsor (a person, who never
 * accepts it).
 */
export const NoteDraftInput = z.object({
  costCenter: z.string().trim().min(1).max(50),
  snapshotSha256: Sha256,
  text: z.string().trim().min(10).max(8000),
  cites: z.array(NoteCite).max(50).default([]),
  agent: z
    .object({
      id: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(200),
      system: z.string().trim().max(100).default('landflow'),
    })
    .optional(),
  /** The person who answers for the agent; defaults to the key's minter. */
  sponsor: z.object({ email: z.string().email().optional(), sub: z.string().optional() }).optional(),
  /** A Landflow run, for the trail. */
  runId: z.string().trim().max(200).optional(),
});
export type NoteDraftInput = z.input<typeof NoteDraftInput>;

/** `POST /api/notes/:month/template` (a person): deterministic drafts from the figures, for every note not drafted. */
export const NoteTemplateInput = z.object({ costCenter: z.string().trim().min(1).max(50).optional() });

/** `POST /api/notes/:id/accept` (FP&A or a controller, not the sponsor or the drafter): accepts, edited or as drafted. */
export const NoteAcceptInput = z.object({
  /** The version accepted (the one shown). */
  version: z.number().int().min(1),
  /** An edited text: accepted as a new version by the analyst. */
  text: z.string().trim().min(10).max(8000).optional(),
  comment: z.string().trim().max(1000).default(''),
});
export type NoteAcceptInput = z.input<typeof NoteAcceptInput>;

export const NoteRejectInput = z.object({
  version: z.number().int().min(1),
  reason: z.string().trim().min(3).max(1000),
});
export type NoteRejectInput = z.input<typeof NoteRejectInput>;

export interface NoteVersionView {
  version: number;
  text: string;
  cites: NoteCite[];
  kind: 'draft' | 'template' | 'edit';
  /** Who wrote it: the key and its agent, the template, or the analyst who edited. */
  by: string;
  agent: { id: string; name: string; system: string } | null;
  sponsor: { id: string; name: string; email: string | null } | null;
  at: string;
  snapshotSha256: string;
  decision: { outcome: 'accepted' | 'rejected'; by: string; at: string; comment: string } | null;
}

export interface NoteView {
  id: string;
  month: string;
  costCenter: string;
  name: string;
  status: 'drafted' | 'accepted' | 'rejected';
  /** The accepted version, if any. */
  accepted: number | null;
  versions: NoteVersionView[];
  /** True when its snapshot is still the month's current one. */
  current: boolean;
}

/** `GET /api/notes?month=`: the notes the snapshot needs, their figures and their versions. */
export interface NotesView {
  month: string;
  snapshotSha256: string | null;
  needed: NoteFigures[];
  notes: NoteView[];
  /** `notes.draft_requested` went out at (once per snapshot). */
  requestedAt: string | null;
}

/** `notes.draft_requested`: the close reached step 8; Landflow's flow drafts each needed note. */
export interface NotesDraftRequestedData {
  month: string;
  snapshotSha256: string;
  /** Each note needed, with the figures it may cite. */
  needed: NoteFigures[];
  /** Where to send drafts. */
  draftUrl: string;
  url: string;
}

// 016 The frozen close snapshot ----------------------------------------------------------------------------------------

/** The month's figures frozen at step 7 (canonical JSON; its sha256 is what notes, uploads and the package cite). */
export interface CloseSnapshotFigures {
  month: string;
  currency: 'USD';
  total: { estimated: Amount; invoiced: Amount; notional: Amount; total: Amount };
  byCostCenter: Array<{
    code: string;
    name: string;
    estimated: Amount;
    invoiced: Amount;
    /** Cluster cost (Clickland): notional, never actuals. */
    notional: Amount;
    total: Amount;
    budget: Amount | null;
  }>;
  byPlClass: Array<{ key: string; label: string; total: Amount; invoiced: Amount }>;
  byProvider: Array<{ provider: string; estimated: Amount; invoiced: Amount; total: Amount }>;
  reconciliation: {
    rows: Array<{
      provider: string;
      model: string;
      estimated: Amount;
      invoiced: Amount;
      variance: Amount;
      status: string;
    }>;
    totals: { estimated: Amount; invoiced: Amount };
  };
  /** Approved requests whose window touches the month: approved, consumed and invoiced. */
  requests: Array<{
    id: string;
    number: number | null;
    title: string;
    costCenter: string;
    approved: Amount;
    consumed: Amount;
    invoiced: Amount;
  }>;
  accrual: { id: string; version: number; total: Amount; sha256: string } | null;
  notes: NoteFigures[];
  gates: Array<{ key: CloseStepKey; state: CloseStepState; summary: string }>;
}

export interface CloseSnapshotView {
  id: string;
  month: string;
  version: number;
  sha256: string;
  frozenBy: string;
  frozenAt: string;
  /** True while the month's live figures still hash to it. */
  current: boolean;
  figures: CloseSnapshotFigures;
}

// 017 Datarails (against fake-datarails) -----------------------------------------------------------------------------

export interface DatarailsStatus {
  /** The MCP server and the upload API, and whether they are the fake on this machine. */
  mcpUrl: string;
  uploadUrl: string;
  filebox: string;
  loopback: boolean;
  /** `LANDLEDGER_DATARAILS_REAL`: a real tenant, wave 5 and the user's decision. False here. */
  real: boolean;
  configured: boolean;
  pulls: DatarailsPullView[];
  uploads: DatarailsUploadView[];
}

export interface DatarailsPullView {
  id: string;
  status: 'pending' | 'accepted' | 'rejected';
  dataModel: string;
  rows: number;
  months: string[];
  total: Amount;
  /** sha256 of the rows as received. */
  sha256: string;
  pulledBy: string;
  pulledAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  /** The budget version it became, once accepted. */
  budgetVersion: number | null;
  reason: string | null;
  preview: Array<{ costCenter: string; month: string; amount: Amount; current: Amount | null }>;
}

export interface DatarailsUploadView {
  id: string;
  month: string;
  snapshotSha256: string;
  files: Array<{ name: string; sha256: string; rows: number; bytes: number }>;
  ok: boolean;
  status: number;
  /** What Datarails answered (the fake's JSON), kept as received. */
  response: Record<string, unknown>;
  uploadedBy: string;
  uploadedAt: string;
}

/** `POST /api/datarails/budgets/pull` (a controller or the CFO): reads the budget over MCP as a pending change. */
export const DatarailsPullInput = z.object({
  dataModel: z.string().trim().min(1).max(200).default('Budget'),
  scenario: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().max(1000).default(''),
});
/** `POST /api/datarails/budgets/pulls/:id/accept` (a controller or the CFO, as a CSV budget import is). */
export const DatarailsPullDecideInput = z.object({ sha256: Sha256, note: z.string().trim().max(1000).default('') });
export const DatarailsPullRejectInput = z.object({ reason: z.string().trim().min(3).max(1000) });
/** `POST /api/datarails/uploads` (a controller or the CFO): step 9, the month's snapshot and accepted notes. */
export const DatarailsUploadInput = z.object({ month: Month });

// 018 The month-end package ------------------------------------------------------------------------------------------

/** `GET /api/close/:month/package` (JSON), `?format=html`, and `GET /api/close/:month/package.zip`. */
export interface MonthEndPackage {
  month: string;
  generatedAt: string;
  status: 'open' | 'closing' | 'locked';
  snapshot: CloseSnapshotView | null;
  close: CloseView;
  accrual: AccrualView | null;
  notes: NoteView[];
  exceptions: Array<{ costCenter: string; month: string; uncovered: Amount; actual: Amount; budget: Amount | null }>;
  anomaliesClosed: Array<{ id: string; kind: string; rule: string; key: string; outcome: string | null; at: string }>;
  decisions: Array<{
    requestId: string;
    number: number | null;
    title: string;
    step: number;
    outcome: string;
    person: string;
    at: string;
  }>;
  uploads: DatarailsUploadView[];
  /** The chain proof: the lock's audit entry, its anchor, and the chain checked to the head. */
  chain: {
    ok: boolean;
    checked: number;
    head: string | null;
    lock: { seq: number; hash: string } | null;
    anchor: { seq: number; hash: string; at: string } | null;
    truncated: boolean;
  };
  /** Each file of the zip and its sha256. */
  files: Array<{ name: string; sha256: string; rows: number }>;
}

// 019 Incident cost -----------------------------------------------------------------------------------------------------

/**
 * `GET /api/cost/window?services=a,b&from=&to=` (scope `read`): the estimated cost of named services over a window,
 * for Landflow's flow that writes an incident's cost into Landfall's postmortem. The ledger is daily: each day's cost
 * is taken by the share of the day inside the window (today's provisional figures included), and labelled estimated.
 */
export const CostWindowQuery = z.object({
  services: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().min(1).max(200)).min(1).max(50)),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});
export type CostWindowQuery = z.input<typeof CostWindowQuery>;

export interface CostWindowView {
  from: string;
  to: string;
  currency: 'USD';
  /** Always `estimated`: a share of daily cost, never an invoiced figure. */
  basis: 'estimated';
  method: string;
  total: Amount;
  services: Array<{
    service: string;
    /** False when Landledger has no cost for that name in the window. */
    known: boolean;
    amount: Amount;
    days: Array<{ day: string; dayCost: Amount; share: string; amount: Amount }>;
  }>;
}

// Wave 3 leftover: a seat on a contract ------------------------------------------------------------------------------

/**
 * A `tool_or_seat` request on a contract reserves seats only, not money, until Landbright prices seats: its amount
 * shows as "within contract" (`RequestSummary.withinContract`) and counts in no reservation, commitment or forecast
 * beside the contract's own contracted line.
 */
export const WITHIN_CONTRACT_LABEL = 'within contract';

// Webhook payloads -------------------------------------------------------------------------------------------------

export interface PeriodLockedData {
  month: string;
  round: number;
  signoffs: LockSignoff[];
  auditSeq: number;
  auditHash: string;
  snapshotSha256: string | null;
  url: string;
}

export interface PeriodReopenedData {
  month: string;
  round: number;
  requestId: string;
  reason: string;
  url: string;
}

export interface AccrualAcceptedData {
  month: string;
  accrualId: string;
  total: Amount;
  snapshotSha256: string;
  url: string;
}

export interface NoteAcceptedData {
  month: string;
  costCenter: string;
  noteId: string;
  version: number;
  url: string;
}

export interface DatarailsUploadedData {
  month: string;
  uploadId: string;
  snapshotSha256: string;
  ok: boolean;
  files: Array<{ name: string; sha256: string }>;
}
