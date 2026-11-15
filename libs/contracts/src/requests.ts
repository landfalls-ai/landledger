/**
 * Wave 2's contract (spec 004, docs/approvals.md): requests, policies, decisions, reservations, the exceptions report,
 * rate card and rule set proposals, and the webhook payloads. What the API enforces and what the console, the MCP
 * server and Landflow's `landledger` plugin read and send.
 *
 * Money in requests is `MoneyJson` (`{ amount: "1840.00", currency: "USD" }`, at most six decimals); read views carry
 * six-decimal amount strings in USD like the rest of the read API. Nothing is a JSON number.
 *
 * **Agents request; people decide.** An agent may raise a request, always with an accountable sponsor (a person); a
 * decision is always a person's: from their signed-in session, or a press in a relay channel (Slack) that Landledger
 * verifies itself (the channel's signature, team and app) and maps to a person through a link that person made from
 * their own session. A key never names who decided. No route, key, MCP tool or agent token decides otherwise.
 *
 * Review of wave 2 (this file's second version): a request a key raises naming a person (requester or sponsor) waits
 * in `awaiting_confirmation` until that person confirms it from their own session; every request carries `createdBy`
 * (the key or person that raised it) and its origin's `verified`; relays carry the raw Slack interaction.
 */
import { z } from 'zod';
import { type AgentEconomics, ContractTerms, type SeatEvidence, SeatTerms, type SeatView } from './wave3.js';

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
  /** Wave 3 (spec 009): a contract, for its total contract value and term; it reserves seats, not money. */
  'contract',
  /** Wave 4 (spec 012): reopen a locked month; the CFO decides, Landledger applies it. */
  'period_reopen',
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
  contract: 'Contract',
  period_reopen: 'Reopen a month',
};

/** Kinds whose change Landledger applies itself when the last step approves (the others are applied by Landflow). */
export const SELF_APPLIED_KINDS: readonly RequestKind[] = [
  'rate_card_change',
  'rule_set_change',
  'policy_change',
  'period_reopen',
];

/**
 * Only forward: `draft → pending → approved | rejected | cancelled | expired`, and `approved → applied`. A draft can be
 * cancelled; nothing else moves back or sideways (the database refuses it). A request a key raised naming a person
 * goes `draft → awaiting_confirmation → pending` when that person confirms it (or `→ cancelled` when they decline,
 * `→ expired` when nobody answers); only then does the policy give it a path.
 */
export const RequestStatus = z.enum([
  'draft',
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'expired',
  'applied',
  'awaiting_confirmation',
]);
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
    /**
     * Landbright granted the access first, under break-glass, and raises the cost request afterwards: it is listed in
     * the exceptions report until it is approved (review of wave 3; additive).
     */
    breakGlass: z.boolean().optional(),
  }),
  z.object({ type: z.literal('console') }),
  z.object({ type: z.literal('mcp') }),
  /**
   * Landledger's own: a contract import held for a second person (a new contract, or a TCV raised by more than USD
   * 25,000). Never accepted from a caller.
   */
  z.object({
    type: z.literal('contract_import'),
    fileName: z.string().max(300).optional(),
    line: z.number().int().min(1),
    contractId: z.string().max(100).optional(),
    previousTcv: z.string().max(40).optional(),
  }),
]);
export type RequestOrigin = z.infer<typeof RequestOrigin>;

/**
 * An origin as stored and shown. `verified`: Landledger set it itself (`console` from a session, `mcp`), or a key bound
 * to that workflow (`boundWorkflowIds`) sent a `landflow_run` for it. Anything else a key sends is stored as said,
 * `verified: false`: a flow checks `createdBy` and `verified` before trusting a request is its own.
 */
export type OriginView = RequestOrigin & { verified: boolean };

/** Who raised a request, stamped by Landledger: the key (`requests:write`, or MCP on a key) or the signed-in person. */
export type CreatedBy = { kind: 'key'; id: string; name: string } | { kind: 'person'; id: string; name: string };

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
  /** Wave 4 (spec 012): reopen a locked month (`YYYY-MM`). */
  z.object({ type: z.literal('period_reopen'), month: z.string() }),
]);
export type RequestChange = z.infer<typeof RequestChange>;

// Creating a request ----------------------------------------------------------------------------------------------------

/**
 * `POST /api/requests`. `kind`s `rate_card_change`, `rule_set_change` and `policy_change` are raised by their own
 * routes (a proposal and its request in one step), not here.
 */
export const CreateRequestInput = z
  .object({
    kind: RequestKind.exclude(['rate_card_change', 'rule_set_change', 'policy_change', 'period_reopen']),
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
    /**
     * Default: `console` for a person's session, `mcp` from the MCP server (always, whatever is sent); a key must say,
     * and what it says is stored `verified: false` unless the key is bound to that `landflow_run`'s workflow.
     */
    origin: RequestOrigin.optional(),
    /** Further sources (a pull request beside the Landflow run, …). */
    related: z.array(RequestOrigin).max(10).default([]),
    /**
     * Who asks, from a key: a person, or an agent and its sponsor. That person confirms it from their own session
     * before it enters the policy (`awaiting_confirmation`, webhook `request.needs_confirmation`).
     */
    requester: RequesterInput.optional(),
    /**
     * `false` keeps it a draft (submit later); default `true`: pending (or awaiting the named person's confirmation),
     * or approved at once below the threshold.
     */
    submit: z.boolean().default(true),
    /**
     * Retries with the same key, caller and body return the first request instead of a second (≤ 200 characters); the
     * same key with a different body is a 409.
     */
    idempotencyKey: z.string().min(1).max(200).optional(),
    /** Kind `contract` only (spec 009): the contract's TCV and term; the amount is the TCV, once. */
    contract: ContractTerms.optional(),
    /** Kind `tool_or_seat` only (spec 010): the contract it takes a seat from; amount = seats × seat price a month. */
    seat: SeatTerms.optional(),
  })
  .refine((r) => !r.end || !r.start || r.end >= r.start, { message: 'end is on or after start', path: ['end'] })
  .refine((r) => (r.kind === 'contract') === !!r.contract, {
    message: 'A contract request carries `contract` (vendor, product, tcv, termMonths, start), and only it does',
    path: ['contract'],
  })
  .refine((r) => !r.seat || r.kind === 'tool_or_seat', {
    message: '`seat` is for a tool_or_seat request',
    path: ['seat'],
  });
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
  /** `console`: their signed-in session; `relay`: a key with `decisions:relay` carried their press from a channel. */
  via: 'console' | 'relay';
  /** For a relay: the key's name and the channel's kind (`slack`). */
  relayedBy: string | null;
  channel: string | null;
  /** For a relay: the registered channel, and the channel's user id that pressed (linked to the person). */
  relay: { channelId: string; kind: RelayChannelKind; externalUserId: string } | null;
  /**
   * The decider and the request's cost center: its `owner` or a `deputy` (Budgets' owner map), or `not_owner` (shown
   * as a flag on the Request page when a budget-owner step was decided by someone else).
   */
  ownerRole: 'owner' | 'deputy' | 'not_owner';
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
    /** The cost center's deputies, who decide the owner's step beside the owner. */
    deputies: PersonView[];
    /** Why the groups decide an owner's step: the cost center has no owner mapped (null when the owner decides). */
    fallback: string | null;
    /**
     * The people who may decide it now: the owner and deputies, else the groups' members; never the requester, the
     * sponsor, or a service-like account (a generic `Administrator`, `admin@…`), listed apart below.
     */
    people: PersonView[];
    /** Accounts in the step's groups that look like services, not people: never approvers. */
    serviceAccounts: PersonView[];
  };
  /** Why the step went straight to escalation, if it did (the owner raised it; its only approver decided before). */
  note: string | null;
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
  /**
   * `matched`: real cost matching the request's `match` selector consumes it, only above `baselineDaily` (the matched
   * cost's daily average over the 30 days before approval); `none`: no selector, held until the month ends.
   */
  consumption: 'matched' | 'none';
  baselineDaily: Amount | null;
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
  origin: OriginView;
  /** Further sources, as the caller said them (never verified). */
  related: RequestOrigin[];
  requester: Requester;
  createdVia: 'session' | 'key' | 'mcp';
  /** The key that created it (its name), if one did. */
  createdByKey: string | null;
  /** Who raised it, stamped by Landledger: compare `createdBy.id` with your own key's id. */
  createdBy: CreatedBy;
  /**
   * The named person's confirmation, when a key raised it naming them (requester, or the agent's sponsor): `waiting`
   * until they confirm or decline it from their own session. Null when a person raised it themselves.
   */
  confirmation: {
    person: PersonView;
    status: 'waiting' | 'confirmed' | 'declined' | 'expired';
    at: string | null;
    reason: string;
  } | null;
  change: RequestChange | null;
  /** Kind `contract`: its terms (spec 009). */
  contract: z.output<typeof ContractTerms> | null;
  /** Kind `tool_or_seat` with a contract: the seat it reserves (spec 010). */
  seat: SeatView | null;
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
    /** The caller is the named person and it waits on their confirmation. */
    canConfirm: boolean;
    /** The creating key, the requester or an admin person (a reservation's release, `applied`). */
    canManage: boolean;
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
  /**
   * Wave 4: a `tool_or_seat` request on a contract reserves seats, not money, until Landbright prices seats; its
   * amount shows as "within contract" and is in no reservation, commitment or forecast. Absent on older answers.
   */
  withinContract?: boolean;
}

export const RequestBox = z.enum(['waiting', 'mine', 'decided', 'open', 'all', 'confirm']);
export type RequestBox = z.infer<typeof RequestBox>;

/**
 * `GET /api/requests`. `waiting`: on me now; `mine`: I raised or sponsor; `decided`: no longer pending; `open`: pending;
 * `confirm`: raised by a key naming me, waiting on my confirmation.
 */
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
  counts: { waiting: number; mine: number; decided: number; open: number; confirm: number };
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
  /**
   * A monthly request that starts mid-month adds only part of a month first: the first whole month's budget with it
   * (null for a one-off, or one that starts on the 1st). The over-budget check uses both months.
   */
  firstFullMonth: {
    month: string;
    adds: Amount;
    budget: Amount | null;
    reserved: Amount;
    leftAfter: Amount | null;
    stateWith: 'ok' | 'risk' | 'over' | 'none' | 'early';
  } | null;
  /** What the request commits: per month, a year of it (open-ended too), and the whole window when it has an end. */
  commitment: { monthly: Amount | null; annualised: Amount; window: Amount | null };
  /**
   * Approved by policy so far this month, which counts toward the automatic threshold: on this cost center, and for an
   * AI budget, for this agent.
   */
  automaticThisMonth: { costCenter: Amount; agent: Amount | null };
  /** A rate card change: the version's lines, frozen once its request exists, and their sha256. */
  rateCardChange: { versionId: string; lines: number; linesSha256: string } | null;
  /**
   * Wave 3 (spec 006): the month (or first full month) has no budget for the cost center, in words: such a request is
   * never automatic and goes to Finance. Null when there is a budget.
   */
  budgetMissing?: string | null;
  /** Wave 3 (spec 006): approved monthly requests beyond their reservations, counted in `forecastNow`. */
  committed?: Amount;
  /** Wave 3 (spec 008): an AI budget's agent this month, and what the request buys at its cost per outcome. */
  agentEconomics?: AgentEconomics | null;
  /** Wave 3 (spec 010): a seat request's contract and its seats. */
  seat?: SeatEvidence | null;
}

export interface RequestDetail {
  request: RequestView;
  evidence: LedgerEvidence;
  /**
   * sha256 of the canonical JSON of `{ request (as shown, without `you`), evidence }`: send it with a decision. Each
   * serving is recorded (who, when); a decision cites one served to that person within 30 minutes, else 409.
   */
  evidenceSha256: string;
  servedAt: string;
}

// Decisions ----------------------------------------------------------------------------------------------------------

/**
 * `POST /api/requests/:id/decisions`: a signed-in person's decision, on evidence served to them within 30 minutes. A
 * key gets 403 here (no key names who decided): a relay sends the raw channel interaction to `POST /api/relays/slack`.
 * `person` may only name the signed-in person themselves; `channel` is ignored. An agent never decides.
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

/**
 * `POST /api/requests/:id/confirm` and `/decline`: the person a key named (requester, or the agent's sponsor), from
 * their own signed-in session only. Confirming enters the policy (pending, or approved below the threshold); declining
 * cancels it, with a reason.
 */
export const ConfirmInput = z.object({ comment: z.string().trim().max(1000).default('') });
export const DeclineInput = z.object({
  reason: z.string().trim().min(3, 'Say why (3 characters or more)').max(1000),
});

// Relay channels and person links (review of wave 2) ----------------------------------------------------------------

/** Kinds of relay channel. Only `slack` is implemented; the table and these schemas leave room for the others. */
export const RelayChannelKind = z.enum(['slack', 'teams', 'email']);
export type RelayChannelKind = z.infer<typeof RelayChannelKind>;

/**
 * `POST /api/relay-channels` (an admin person): a channel Landledger verifies presses from itself. Slack: the app's
 * signing secret (sealed at rest, never shown again), its workspace (`teamId`, `T…`) and app (`appId`, `A…`).
 */
export const RelayChannelInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('slack'),
    name: z.string().trim().min(1).max(100),
    signingSecret: z.string().min(16).max(200),
    teamId: z.string().regex(/^T[A-Z0-9_]+$/, 'a Slack team id (T…)'),
    appId: z.string().regex(/^A[A-Z0-9_]+$/, 'a Slack app id (A…)'),
  }),
]);
export type RelayChannelInput = z.input<typeof RelayChannelInput>;

export interface RelayChannelView {
  id: string;
  kind: RelayChannelKind;
  name: string;
  /** Slack: `{ teamId, appId }`. Never the secret. */
  config: Record<string, string>;
  createdBy: string;
  createdAt: string;
  disabledAt: string | null;
}

/** Which requests a relay may decide: only the budget owner's step of these kinds; never Finance's or the CFO's. */
export const RELAYABLE_KINDS: readonly RequestKind[] = ['infra_change', 'ai_budget', 'tool_or_seat', 'other'];
export const RELAYABLE_STEP_KEYS: readonly string[] = ['budget_owner'];

/** The Slack actions Landledger reads: a button's `action_id`, and the reject modal's `callback_id`. */
export const SLACK_ACTIONS = {
  approve: 'landledger.approve',
  reject: 'landledger.reject',
  /** The reject modal's comment input: `view.state.values.comment.comment.value`. */
  commentBlock: 'comment',
} as const;

/**
 * A card's button `value` (and the reject modal's `private_metadata`): `ll1|<requestId>|<step>|<evidenceSha256>`, the
 * hash from `request.step_pending` (or a fresh `GET /api/requests/:id`). Signed by Slack with the press, so Landledger
 * trusts it only as far as it verifies the signature.
 */
export function slackButtonValue(v: { requestId: string; step: number; evidenceSha256: string }): string {
  return `ll1|${v.requestId}|${v.step}|${v.evidenceSha256}`;
}
export function parseSlackButtonValue(
  value: string,
): { requestId: string; step: number; evidenceSha256: string } | null {
  const m = /^ll1\|(req_[\w-]{1,80})\|(\d{1,2})\|([0-9a-f]{64})$/.exec(value);
  return m ? { requestId: m[1]!, step: Number(m[2]), evidenceSha256: m[3]! } : null;
}

/**
 * `POST /api/relays/slack` (a key with `decisions:relay`): the raw Slack interaction as Slack sent it. Landledger checks
 * `X-Slack-Signature` (`v0=` HMAC-SHA256 of `v0:<timestamp>:<body>` with the channel's signing secret), that the
 * timestamp is within 5 minutes, and the team and app; then reads the press (a `block_actions` button
 * `landledger.approve` or `landledger.reject` with a comment-less reject refused, or the reject modal's
 * `view_submission` with its comment), finds the person linked to the Slack user, and decides as them if they may.
 */
export const SlackRelayInput = z.object({
  /** The registered channel; default: the one whose team and app match the payload. */
  channelId: z.string().min(1).max(100).optional(),
  /** The request body exactly as Slack sent it (`payload=…`, form-encoded). */
  body: z.string().min(1).max(200_000),
  /** `X-Slack-Signature`. */
  signature: z.string().regex(/^v0=[0-9a-f]{64}$/, 'X-Slack-Signature, v0=<hex>'),
  /** `X-Slack-Request-Timestamp`, Unix seconds. */
  timestamp: z.string().regex(/^\d{1,12}$/),
});
export type SlackRelayInput = z.input<typeof SlackRelayInput>;

/**
 * `POST /api/me/links` (a person's own session only): links their account in a relay channel to them. They enter it
 * themselves on their profile page (Link Slack); a relay from an unlinked user is refused.
 */
export const PersonLinkInput = z.object({
  kind: z.literal('slack'),
  /** The Slack member id (`U…` or `W…`). */
  externalId: z.string().regex(/^[UW][A-Z0-9_]+$/, 'a Slack member id (U…)'),
});
export type PersonLinkInput = z.input<typeof PersonLinkInput>;

export interface PersonLinkView {
  id: string;
  kind: RelayChannelKind;
  externalId: string;
  createdAt: string;
}

// Cost center owners (review of wave 2) -------------------------------------------------------------------------------

/**
 * `PUT /api/cost-centers/:code/owners` (an admin person): the owner (a person) and optional deputies who decide the
 * budget owner's step for that cost center. Without one the step falls back to the `Budget Owners` group, and says so.
 */
export const CostCenterOwnersInput = z.object({
  owner: PersonRef,
  deputies: z.array(PersonRef).max(10).default([]),
  note: z.string().trim().max(1000).default(''),
});
export type CostCenterOwnersInput = z.input<typeof CostCenterOwnersInput>;

export interface CostCenterOwnersView {
  costCenter: string;
  owner: PersonView | null;
  deputies: PersonView[];
  setBy: string | null;
  setAt: string | null;
}

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
  /** The month's budget for the cost center (none is 0): uncovered = actual − budget − covered. */
  budget?: Amount | null;
  /**
   * The approved requests counted as cover: `amount` is what each covers, `covers` how (`match`: only the cost its
   * selector matches, up to what it adds; `cost_center`: no selector, so its cost center up to what it adds).
   */
  requests: { id: string; number: string; title: string; amount: Amount; covers?: 'match' | 'cost_center' }[];
}

export interface ExceptionsReport {
  from: string;
  to: string;
  currency: string;
  generatedAt: string;
  rows: ExceptionRow[];
  /** Shared pool and Unallocated have no owner to ask: reported apart, never exceptions. */
  unowned: { month: string; costCenter: string; actual: Amount }[];
  /**
   * Contracts entered by an import (under the second-person line) that no approved contract request covers (review of
   * wave 3, Decision 9). Dev fixtures are never listed.
   */
  contracts: {
    id: string;
    version: number;
    vendor: string;
    product: string;
    tcv: Amount;
    importedBy: string;
    importedAt: string;
  }[];
  /** Access Landbright granted under break-glass whose cost request is not approved yet (`origin.breakGlass`). */
  breakGlass: { id: string; number: string; title: string; status: string; costCenter: string; amount: Amount }[];
}

// Webhook payloads (Standard Webhooks; `data` of each event) ------------------------------------------------------------

/** `request.needs_confirmation`: a key named this person; they confirm or decline it in the console. */
export interface NeedsConfirmationData {
  request: RequestSummary;
  person: PersonView;
  /** The key that raised it. */
  createdBy: CreatedBy;
  url: string;
}

/** `decision.relayed`: a decision came through a relay channel; sent naming the person, so they hear of it. */
export interface DecisionRelayedData {
  request: RequestSummary;
  decision: DecisionView;
  person: PersonView;
  channel: { id: string; kind: RelayChannelKind; name: string };
  url: string;
}

/** `report.exceptions`: the weekly exceptions report, stored with its sha256. */
export interface ExceptionsReportData {
  id: string;
  sha256: string;
  from: string;
  to: string;
  generatedAt: string;
  rows: number;
  url: string;
}

/** A stored weekly report (`GET /api/exceptions/reports`). */
export interface StoredExceptionsReport {
  id: string;
  sha256: string;
  from: string;
  to: string;
  generatedAt: string;
  rows: number;
  report?: ExceptionsReport;
}

/**
 * `GET /api/requests/:id/evidence-pack` (JSON; `?format=html` for a printable page): everything that shows how a
 * request was decided, for an auditor: the request, every snapshot served (and to whom, when), the decisions, the
 * request's audit entries and the chain's proof from them to the last anchor.
 */
export interface EvidencePack {
  generatedAt: string;
  request: RequestView;
  snapshots: { sha256: string; createdAt: string; body: unknown; served: { to: string; kind: string; at: string }[] }[];
  decisions: DecisionView[];
  audit: {
    seq: number;
    at: string;
    actor: string;
    actorKind: string;
    action: string;
    data: Record<string, unknown>;
    prevHash: string;
    hash: string;
  }[];
  /** The chain checked from the request's first entry to the head, against the last anchor. */
  chain: {
    from: number;
    to: number;
    ok: boolean;
    brokenAt: number | null;
    anchor: { seq: number; hash: string; at: string } | null;
  };
}

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
  /** The snapshot to put on the card (a relay must cite it within 30 minutes, else 409: refresh the card). */
  evidenceSha256: string;
  /** Whether a relay channel may decide this step (only the budget owner's step of infra, AI budget, seat, other). */
  relayable: boolean;
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
