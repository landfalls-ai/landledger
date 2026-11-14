/**
 * Wave 2's contract (spec 004, docs/approvals.md): requests, policies, decisions, reservations, the exceptions report,
 * rate card and rule set proposals, and the webhook payloads. What the API enforces and what the console, the MCP
 * server and Landflow's `landledger` plugin read and send.
 *
 * Money in requests is `MoneyJson` (`{ amount: "1840.00", currency: "USD" }`, at most six decimals); read views carry
 * six-decimal amount strings in USD like the rest of the read API. Nothing is a JSON number.
 *
 * **Agents request; people decide.** An agent may raise a request, always with an accountable sponsor (a person); a
 * decision is always a person's: from their signed-in session, or relayed by a key with `decisions:relay` that names
 * the person, whom Landledger checks itself. No route, key, MCP tool or agent token decides otherwise.
 */
import { z } from 'zod';

const Day = z.iso.date();
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month, YYYY-MM');
const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'an ISO 4217 code');
/** A non-negative amount in major units, exact to the micro-unit, as a string. */
const PositiveAmount = z.string().regex(/^\d+(\.\d{1,6})?$/, 'a non-negative amount as a decimal string, ≤ 6 decimals');
const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'a decimal number as a string');
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256, 64 hex characters');
/** An amount in major units with six decimals, as the read views carry it (`"1840.000000"`). */
type Amount = string;

// Kinds and states ---------------------------------------------------------------------------------------------------

export const RequestKind = z.enum([
  'infra_change',
  'ai_budget',
  'tool_or_seat',
  'rate_card_change',
  'rule_set_change',
  'policy_change',
  'other',
]);
export type RequestKind = z.infer<typeof RequestKind>;

export const REQUEST_KIND_LABEL: Readonly<Record<RequestKind, string>> = {
  infra_change: 'Infra change',
  ai_budget: 'AI budget',
  tool_or_seat: 'Tool or seat',
  rate_card_change: 'Rate-card change',
  rule_set_change: 'Rule-set change',
  policy_change: 'Policy change',
  other: 'Other',
};

/** Kinds whose change Landledger applies itself when the last step approves (the others are applied by Landflow). */
export const SELF_APPLIED_KINDS: readonly RequestKind[] = ['rate_card_change', 'rule_set_change', 'policy_change'];

/**
 * Only forward: `draft → pending → approved | rejected | cancelled | expired`, and `approved → applied`. A draft can be
 * cancelled; nothing else moves back or sideways (the database refuses it).
 */
export const RequestStatus = z.enum(['draft', 'pending', 'approved', 'rejected', 'cancelled', 'expired', 'applied']);
export type RequestStatus = z.infer<typeof RequestStatus>;

/** `monthly`: a recurring amount per month from `start` (to `end`, or open-ended); `once`: a one-off amount. */
export const Recurrence = z.enum(['monthly', 'once']);
export type Recurrence = z.infer<typeof Recurrence>;

// Where a request comes from -------------------------------------------------------------------------------------------

export const RequestOrigin = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('landflow_run'),
    workflowId: z.string().min(1).max(200),
    executionId: z.string().min(1).max(200),
    /** The run's page in Landflow, for a link. */
    url: z.url({ protocol: /^https?$/ }).optional(),
    title: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('pull_request'),
    url: z.url({ protocol: /^https?$/ }),
    title: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('landbright_request'),
    id: z.string().min(1).max(200),
    url: z.url({ protocol: /^https?$/ }).optional(),
    title: z.string().max(300).optional(),
  }),
  z.object({ type: z.literal('console') }),
  z.object({ type: z.literal('mcp') }),
]);
export type RequestOrigin = z.infer<typeof RequestOrigin>;

// Who --------------------------------------------------------------------------------------------------------------

/** A person by their Landbright identity: the `sub` (SCIM `externalId`), or the email. Landledger finds the user. */
export const PersonRef = z
  .object({ sub: z.string().min(1).max(200).optional(), email: z.email().max(320).optional() })
  .refine((p) => p.sub || p.email, { message: 'Name the person by sub or email' });
export type PersonRef = z.infer<typeof PersonRef>;

export const AgentRef = z.object({
  /** The agent's id where it runs (a Landflow agent id, a kagent name). */
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  /** Where the agent runs: `landflow`, `kagent`, `claude`, … */
  system: z.string().min(1).max(50).default('landflow'),
});
export type AgentRef = z.infer<typeof AgentRef>;

/**
 * Who asks. A signed-in person raising a request is the requester (omit this). A key (`requests:write`) or an MCP
 * session on a key must say: a person, or an agent and its sponsor, the person who answers for it.
 */
export const RequesterInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), person: PersonRef }),
  z.object({ kind: z.literal('agent'), agent: AgentRef, sponsor: PersonRef }),
]);
export type RequesterInput = z.infer<typeof RequesterInput>;

export const PersonView = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  /** Landbright's subject (`sub`); null for a system actor. */
  sub: z.string().nullable(),
});
export type PersonView = z.infer<typeof PersonView>;

export type Requester =
  { kind: 'person'; person: PersonView } | { kind: 'agent'; agent: AgentRef; sponsor: PersonView };

// The change a self-applied request carries -----------------------------------------------------------------------------

/** What a rate-card, rule-set or policy change request applies when approved. */
export const RequestChange = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rate_card_version'), versionId: z.string() }),
  z.object({ type: z.literal('rule_set_version'), versionId: z.string() }),
  z.object({ type: z.literal('policy'), policyId: z.string() }),
]);
export type RequestChange = z.infer<typeof RequestChange>;

// Creating a request ----------------------------------------------------------------------------------------------------

/**
 * `POST /api/requests`. `kind`s `rate_card_change`, `rule_set_change` and `policy_change` are raised by their own
 * routes (a proposal and its request in one step), not here.
 */
export const CreateRequestInput = z
  .object({
    kind: RequestKind.exclude(['rate_card_change', 'rule_set_change', 'policy_change']),
    title: z.string().trim().min(3).max(200),
    /** The requester's why, in their words. */
    note: z.string().trim().max(4000).default(''),
    costCenter: z.string().trim().min(1).max(50),
    amount: z.object({ amount: PositiveAmount, currency: CurrencyCode }),
    recurrence: Recurrence,
    /** First day the spend applies (default: today). */
    start: Day.optional(),
    /** Last day (inclusive); null or omitted: open-ended (monthly) or the start day (once). */
    end: Day.nullable().optional(),
    /**
     * The requester's evidence, any JSON object (≤ 64 kB). Recognised keys the console shows: `lines`
     * (`[{ label, amount }]`, the cost change), `basis` (how it was sized), `links` (`[{ label, url }]`), and `match`
     * (a selector, as allocation rules have: `namespace`, `workload`, `service`, `agent`, `workflow`, `provider`,
     * `model`, … with `*` wildcards) that tells the reservation which real cost consumes it.
     */
    evidence: z.record(z.string(), z.unknown()).default({}),
    /** Default: `console` for a person's session, `mcp` from the MCP server; a key must say. */
    origin: RequestOrigin.optional(),
    /** Further sources (a pull request beside the Landflow run, …). */
    related: z.array(RequestOrigin).max(10).default([]),
    requester: RequesterInput.optional(),
    /** `false` keeps it a draft (submit later); default `true`: pending, or approved at once below the threshold. */
    submit: z.boolean().default(true),
    /** Retries with the same key and caller return the first request instead of a second (≤ 200 characters). */
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .refine((r) => !r.end || !r.start || r.end >= r.start, { message: 'end is on or after start', path: ['end'] });
export type CreateRequestInput = z.input<typeof CreateRequestInput>;

// Steps, decisions, reservations ---------------------------------------------------------------------------------------

/**
 * A step of a request's path. `waiting`: an earlier step is open; `pending`: waiting on its approvers (until
 * `deadlineAt`); `approved` / `rejected`: decided; `skipped`: not reached (the request ended first); `expired`: the
 * escalated deadline passed too.
 */
export const StepStatus = z.enum(['waiting', 'pending', 'approved', 'rejected', 'skipped', 'expired']);
export type StepStatus = z.infer<typeof StepStatus>;

export interface DecisionView {
  id: string;
  /** The step's position, 1-based. */
  step: number;
  stepKey: string;
  outcome: 'approve' | 'reject';
  comment: string;
  person: PersonView;
  at: string;
  /** The sha256 of the evidence snapshot the person was shown (`GET /api/requests/:id` → `evidenceSha256`). */
  evidenceSha256: string;
  /** `console`: their signed-in session; `relay`: a key with `decisions:relay` carried it (Landflow, Slack, email). */
  via: 'console' | 'relay';
  /** For a relay: the key's name and the channel the person pressed the button in. */
  relayedBy: string | null;
  channel: string | null;
}

export interface StepView {
  position: number;
  key: string;
  label: string;
  status: StepStatus;
  approvers: {
    /** Landbright groups whose members may decide this step. */
    groups: string[];
    /** The cost center's owner, when the step is the owner's and the cost center names a person. */
    costCenterOwner: PersonView | null;
    /** The people who may decide it now: the owner, else the groups' members; never the requester or sponsor. */
    people: PersonView[];
  };
  /** When a pending step escalates (or, once escalated, expires). */
  deadlineAt: string | null;
  /** When it escalated, and to whom. */
  escalatedAt: string | null;
  escalatedTo: string[];
  decision: DecisionView | null;
}

export const ReservationStatus = z.enum(['reserved', 'consumed', 'released']);
export type ReservationStatus = z.infer<typeof ReservationStatus>;

export interface ReservationView {
  id: string;
  requestId: string;
  requestTitle: string;
  costCenter: string;
  month: string;
  amount: Amount;
  /** Real cost matched to it so far (cost center, month, the request's `match` selector, from its start). */
  consumed: Amount;
  /** `amount − consumed` while reserved; zero once consumed or released. What budget left subtracts. */
  remaining: Amount;
  status: ReservationStatus;
  createdAt: string;
  closedAt: string | null;
  /** Why it was released (`month ended`, `released by …`, `request cancelled`). */
  note: string;
}

export interface RequestView {
  id: string;
  /** A short, human number (`R-12`). */
  number: string;
  kind: RequestKind;
  title: string;
  note: string;
  status: RequestStatus;
  costCenter: { code: string; name: string; owner: string | null };
  amount: { amount: Amount; currency: string };
  recurrence: Recurrence;
  start: string;
  end: string | null;
  /** What the policy's thresholds compare: the monthly amount, or the one-off amount. */
  thresholdAmount: Amount;
  evidence: Record<string, unknown>;
  origin: RequestOrigin;
  related: RequestOrigin[];
  requester: Requester;
  createdVia: 'session' | 'key' | 'mcp';
  /** The key that created it (its name), if one did. */
  createdByKey: string | null;
  change: RequestChange | null;
  /** Approved by policy below the threshold: no person decided. */
  automatic: boolean;
  policy: { id: string; version: number; reason: string } | null;
  steps: StepView[];
  /** The pending step's position, if any. */
  currentStep: number | null;
  decisions: DecisionView[];
  reservations: ReservationView[];
  createdAt: string;
  submittedAt: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
  /** What the caller may do with it. */
  you: {
    isRequester: boolean;
    isSponsor: boolean;
    canDecide: boolean;
    /** Why not, in words, when `canDecide` is false. */
    reason: string | null;
    canCancel: boolean;
  };
}

/** A row of the inbox: the request without its decisions and reservations, plus budget left after it. */
export interface RequestSummary extends Omit<
  RequestView,
  'decisions' | 'reservations' | 'evidence' | 'steps' | 'related'
> {
  /** e.g. `Step 2 of 3 · Finance`, `Approved`, `Rejected`. */
  stepLabel: string;
  stepCount: number;
  /** The cost center's budget left in the request's first month, after this request (null without a budget). */
  budgetLeftAfter: Amount | null;
}

export const RequestBox = z.enum(['waiting', 'mine', 'decided', 'open', 'all']);
export type RequestBox = z.infer<typeof RequestBox>;

/** `GET /api/requests`. `waiting`: on me now; `mine`: I raised or sponsor; `decided`: no longer pending; `open`: pending. */
export const RequestsQuery = z.object({
  box: RequestBox.default('all'),
  status: RequestStatus.optional(),
  kind: RequestKind.optional(),
  costCenter: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type RequestsQuery = z.infer<typeof RequestsQuery>;

export interface RequestsList {
  requests: RequestSummary[];
  /** For the inbox's headings and the bottom bar's count. */
  counts: { waiting: number; mine: number; decided: number; open: number };
}

// Evidence -----------------------------------------------------------------------------------------------------------

/**
 * What Landledger shows beside a request (the console's "The evidence"), computed when asked: the cost center's month
 * now and with the request, the rate card in effect, similar past requests. `GET /api/requests/:id` returns it with
 * `evidenceSha256`, the hash of the whole snapshot (request and evidence) the caller was shown; a decision names it.
 */
export interface LedgerEvidence {
  month: string;
  currency: string;
  /** The amount this request adds in `month`. */
  adds: Amount;
  budget: Amount | null;
  actual: Amount;
  reserved: Amount;
  leftNow: Amount | null;
  leftAfter: Amount | null;
  forecastNow: Amount | null;
  forecastWith: Amount | null;
  stateNow: 'ok' | 'risk' | 'over' | 'none' | 'early';
  stateWith: 'ok' | 'risk' | 'over' | 'none' | 'early';
  rateCard: { version: number; effectiveFrom: string; approvedBy: string | null } | null;
  similar: {
    id: string;
    number: string;
    title: string;
    amount: Amount;
    recurrence: Recurrence;
    status: RequestStatus;
    decidedAt: string | null;
  }[];
  /** The policy's path for this amount, in words (`$1,840 a month is in the budget owner's range …`). */
  why: string;
}

export interface RequestDetail {
  request: RequestView;
  evidence: LedgerEvidence;
  /** sha256 of the canonical JSON of `{ request (as shown, without `you`), evidence }`: send it with a decision. */
  evidenceSha256: string;
}

// Decisions ----------------------------------------------------------------------------------------------------------

/**
 * `POST /api/requests/:id/decisions`. From a signed-in person: they decide. From a key with `decisions:relay`: `person`
 * names who pressed the button (their Landbright `sub` or email); Landledger checks that they exist, are active, are a
 * person, are among the step's approvers, and aren't the requester or the sponsor. An agent never decides.
 */
export const DecisionInput = z
  .object({
    outcome: z.enum(['approve', 'reject']),
    /** Required to reject (so the requester knows what to change). */
    comment: z.string().trim().max(2000).default(''),
    /** The `evidenceSha256` of the `GET /api/requests/:id` the person was shown. */
    evidenceSha256: Sha256,
    /** The step the person saw (1-based); 409 if the request has moved on. */
    step: z.number().int().min(1).optional(),
    /** Relay only: the person deciding. */
    person: PersonRef.optional(),
    /** Relay only: where they decided (`slack`, `teams`, `email`, `landflow`). */
    channel: z.string().trim().min(1).max(50).optional(),
  })
  .refine((d) => d.outcome === 'approve' || d.comment.length >= 3, {
    message: 'Say why you reject it (a comment of 3 characters or more)',
    path: ['comment'],
  });
export type DecisionInput = z.input<typeof DecisionInput>;

/** `POST /api/requests/:id/applied` (scope `requests:write`): Landflow says the approved change is in place. */
export const AppliedInput = z.object({
  note: z.string().trim().max(2000).default(''),
  links: z
    .array(z.object({ label: z.string().max(200), url: z.url({ protocol: /^https?$/ }) }))
    .max(10)
    .default([]),
});
export type AppliedInput = z.input<typeof AppliedInput>;

/** `POST /api/requests/:id/cancel`: the requester, the sponsor or an admin, while draft or pending. */
export const CancelInput = z.object({ reason: z.string().trim().max(1000).default('') });

// Reservations ---------------------------------------------------------------------------------------------------------

/**
 * `POST /api/reservations` (scope `reservations:write`; MCP `reserve`). Approval reserves the request's months
 * itself (the start month and, for an open-ended monthly request, the two after); this reserves another month of an
 * approved or applied request's window, at most its monthly amount (or the one-off amount). Idempotent per month.
 */
export const ReserveInput = z.object({
  requestId: z.string().min(1).max(100),
  month: Month.optional(),
  amount: PositiveAmount.optional(),
});
export type ReserveInput = z.input<typeof ReserveInput>;

export const ReservationsQuery = z.object({
  month: Month.optional(),
  costCenter: z.string().max(50).optional(),
  status: ReservationStatus.optional(),
});

// Policies -----------------------------------------------------------------------------------------------------------

/** When a step applies: any condition that holds adds it. Amounts compare against the request's threshold amount. */
export const StepWhen = z.object({
  always: z.boolean().optional(),
  /** amount ≥ this */
  amountAtLeast: PositiveAmount.optional(),
  /** amount > this */
  amountAbove: PositiveAmount.optional(),
  /** The cost center is at risk or over in the request's month, or this request would take it over its budget. */
  costCenterAtRisk: z.boolean().optional(),
});

export const PolicyStepDef = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().min(1).max(60),
  approvers: z.object({
    /** Landbright groups whose members decide this step. */
    groups: z.array(z.string().min(1).max(100)).max(10).default([]),
    /** The cost center's owner decides, when the cost center names one who is a person here; else the groups. */
    costCenterOwner: z.boolean().default(false),
  }),
  when: StepWhen,
  /** Business hours before the step escalates (default `LANDLEDGER_STEP_DEADLINE_HOURS`, 24). */
  deadlineHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
  /** Who it escalates to when the deadline passes (default: Finance CFO). */
  escalateTo: z.array(z.string().min(1).max(100)).max(10).optional(),
});
export type PolicyStepDef = z.infer<typeof PolicyStepDef>;

export const PolicyDef = z.object({
  kind: RequestKind,
  /** A cost center code, or null for every cost center (a cost center's own policy wins). */
  costCenter: z.string().max(50).nullable().default(null),
  /** Below this threshold amount a request is approved by policy at once; null: never automatic. */
  automaticBelow: PositiveAmount.nullable(),
  steps: z.array(PolicyStepDef).min(1).max(8),
});
export type PolicyDef = z.infer<typeof PolicyDef>;

export interface PolicyView extends PolicyDef {
  id: string;
  version: number;
  status: 'proposed' | 'approved' | 'rejected';
  /** In effect now (the newest approved version for its kind and cost center). */
  current: boolean;
  note: string;
  proposedBy: string;
  proposedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  requestId: string | null;
}

/** `POST /api/policies` (scope `requests:write`): a policy change is itself a request (Finance, then the CFO). */
export const ProposePolicyInput = z.object({
  policy: PolicyDef,
  title: z.string().trim().min(3).max(200).optional(),
  note: z.string().trim().max(4000).default(''),
});
export type ProposePolicyInput = z.input<typeof ProposePolicyInput>;

// Rate card and rule set proposals (spec 003 T010) ---------------------------------------------------------------------

/** New prices for lines of the rate card in effect; every other line is carried over unchanged. */
export const RateCardProposalInput = z.object({
  effectiveFrom: Day,
  changes: z
    .array(z.object({ skuPriceId: z.string().min(1).max(300), unitPrice: DecimalString }))
    .min(1)
    .max(500),
  title: z.string().trim().min(3).max(200).optional(),
  note: z.string().trim().max(4000).default(''),
});
export type RateCardProposalInput = z.input<typeof RateCardProposalInput>;

export const RuleSetProposalInput = z.object({
  effectiveFrom: Day,
  /** The whole ordered list (libs/allocation `Rule`) and the share rules: a version is the full set. */
  rules: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
  shares: z.array(z.record(z.string(), z.unknown())).max(50).default([]),
  title: z.string().trim().min(3).max(200).optional(),
  note: z.string().trim().max(4000).default(''),
});
export type RuleSetProposalInput = z.input<typeof RuleSetProposalInput>;

/** A proposal's effect on the open month: every record of it as booked now, against the same under the proposal. */
export interface ProposalPreview {
  month: string;
  currency: string;
  /** In words: what was compared (e.g. "November 2026 to date, repriced as if v2 applied to all of it"). */
  basis: string;
  current: Amount;
  proposed: Amount;
  delta: Amount;
  byCostCenter: { code: string; name: string; current: Amount; proposed: Amount; delta: Amount }[];
  /** Rate card: each changed line's quantity and cost; rule set: each rule's records and cost. */
  byLine: { key: string; label: string; detail: string; current: Amount; proposed: Amount; delta: Amount }[];
  warnings: string[];
}

export interface ProposalCreated {
  request: RequestView;
  versionId: string;
  preview: ProposalPreview;
}

// The weekly exceptions report ------------------------------------------------------------------------------------------

export const ExceptionsQuery = z.object({
  /** One month, or a range (`from`, `to`, months); default: this month and the last. */
  month: Month.optional(),
  from: Month.optional(),
  to: Month.optional(),
});

/**
 * Spend above the automatic threshold per cost center and month that no approved request covers: the month's actual
 * (direct layer) less what approved or applied requests cover in that month; listed when it is above the threshold.
 */
export interface ExceptionRow {
  month: string;
  costCenter: string;
  name: string;
  owner: string | null;
  actual: Amount;
  covered: Amount;
  uncovered: Amount;
  threshold: Amount;
  /** The approved requests counted as cover. */
  requests: { id: string; number: string; title: string; amount: Amount }[];
}

export interface ExceptionsReport {
  from: string;
  to: string;
  currency: string;
  generatedAt: string;
  rows: ExceptionRow[];
  /** Shared pool and Unallocated have no owner to ask: reported apart, never exceptions. */
  unowned: { month: string; costCenter: string; actual: Amount }[];
}

// Webhook payloads (Standard Webhooks; `data` of each event) ------------------------------------------------------------

/** The approvers of a pending step, for a card in Slack or an email: the group and each person in it. */
export interface StepPendingData {
  request: RequestSummary;
  step: {
    position: number;
    key: string;
    label: string;
    groups: string[];
    deadlineAt: string | null;
    escalated: boolean;
  };
  approvers: { name: string; email: string | null; sub: string | null; via: 'group' | 'owner'; group: string | null }[];
  /** Where a person decides in the console. */
  url: string;
  evidenceSha256: string;
}

export interface RequestDecidedData {
  request: RequestSummary;
  outcome: 'approved' | 'rejected' | 'cancelled' | 'expired';
  /** The decision that ended it, if a person's. */
  decision: DecisionView | null;
  reservations: ReservationView[];
}

export interface BudgetAtRiskData {
  month: string;
  costCenter: string;
  name: string;
  owner: string | null;
  state: 'risk' | 'over';
  budget: Amount;
  actual: Amount;
  reserved: Amount;
  forecast: Amount | null;
}
