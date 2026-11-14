/**
 * The Landledger API's wire contracts. docs/development.md lists the routes; these schemas are what the API enforces
 * and what the console reads. Money travels as `{ amountMinor: "123456", currency: "USD" }` and decimals as strings,
 * so nothing on the way becomes a float.
 */
import { COLUMNS, type FocusColumn } from '@landledger/focus';
import { z } from 'zod';

// Errors ------------------------------------------------------------------------------------------------------------

export const ErrorCode = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  /** 422: well formed, but Landledger can't take it yet (a request in another currency before FX is set up). */
  'unprocessable',
  'unavailable',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiErrorBody = z.object({
  error: z.object({ code: ErrorCode, message: z.string(), details: z.unknown().optional() }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

// Values ------------------------------------------------------------------------------------------------------------

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'an ISO 4217 code');
/** FOCUS numeric format: plain decimal, `-` only, never a JSON number (spec 001). */
export const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'a decimal number as a string');
/** An amount in major units, exact to the micro-unit: at most six decimals (`"-0.003100"`). */
export const AmountString = z.string().regex(/^-?\d+(\.\d{1,6})?$/, 'an amount as a decimal string, ≤ 6 decimals');
export const Day = z.iso.date();
export const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month, YYYY-MM');

/** Money on the wire (libs/money `Money.toJSON`): the amount as a decimal string and its ISO 4217 code. */
export const MoneyJson = z.object({ amount: AmountString, currency: CurrencyCode });
export type MoneyJson = z.infer<typeof MoneyJson>;

// Who ---------------------------------------------------------------------------------------------------------------

/**
 * What an API key may do (docs/architecture.md, "Security and controls"). No scope decides a request.
 * `webhooks:write` (review of wave 2) creates, lists and deletes only the subscriptions that key created.
 * `decisions:relay` carries a person's signed press from a relay channel (Slack); a key holding it may not also hold
 * `requests:write` or `admin`, so the key that raises a request never also carries its approval.
 */
export const ApiScope = z.enum([
  'read',
  'requests:write',
  'reservations:write',
  'decisions:relay',
  'webhooks:write',
  'ingest',
  'admin',
]);
export type ApiScope = z.infer<typeof ApiScope>;

/** Scopes a `decisions:relay` key may not hold beside it. */
export const RELAY_EXCLUDES: readonly ApiScope[] = ['requests:write', 'admin'];

export const Role = z.enum(['cfo', 'controller', 'fpa', 'budget_owner', 'auditor', 'engineer']);
export type Role = z.infer<typeof Role>;

/** Landbright group names (the `roles` claim) → Landledger roles. Other groups (Everyone, …) are ignored. */
export const ROLE_BY_GROUP: Readonly<Record<string, Role>> = {
  'Finance CFO': 'cfo',
  'Finance Controllers': 'controller',
  'Finance FP&A': 'fpa',
  'Budget Owners': 'budget_owner',
  'Landledger Auditors': 'auditor',
  Engineering: 'engineer',
};

export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  cfo: 'CFO',
  controller: 'Controller',
  fpa: 'FP&A',
  budget_owner: 'Budget owner',
  auditor: 'Auditor',
  engineer: 'Engineer',
};

/**
 * What a signed-in person may call, by role. Deciding a request is never a scope: it is checked per step against the
 * person's groups (wave 2). Auditors read; controllers and the CFO administer keys and webhooks.
 */
export const SCOPES_BY_ROLE: Readonly<Record<Role, readonly ApiScope[]>> = {
  cfo: ['read', 'requests:write', 'admin'],
  controller: ['read', 'requests:write', 'admin'],
  fpa: ['read', 'requests:write'],
  budget_owner: ['read', 'requests:write'],
  auditor: ['read'],
  engineer: ['read', 'requests:write'],
};

export const PrincipalKind = z.enum(['person', 'key', 'bootstrap', 'dev']);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

export const Me = z.object({
  kind: PrincipalKind,
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    roles: z.array(Role),
    groups: z.array(z.string()),
  }),
  scopes: z.array(ApiScope),
  /** `oidc`: sign in with Landbright; `dev`: the local developer bypass is on. */
  authMode: z.enum(['oidc', 'dev']),
});
export type Me = z.infer<typeof Me>;

export const Health = z.object({
  status: z.enum(['ok', 'degraded']),
  postgres: z.string(),
  migrations: z.number().int(),
  version: z.string(),
});
export type Health = z.infer<typeof Health>;

// API keys ----------------------------------------------------------------------------------------------------------

/**
 * `POST /api/keys`: only a signed-in person with `admin` mints a key (the bootstrap key only until the first admin
 * person has signed in). `boundWorkflowIds`: the Landflow workflows whose runs this key raises requests for; an
 * origin `landflow_run` naming one of them is stored `verified: true`, any other origin from a key `verified: false`.
 */
export const ApiKeyInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(ApiScope).min(1),
    boundWorkflowIds: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  })
  .refine((k) => !k.scopes.includes('decisions:relay') || !k.scopes.some((s) => RELAY_EXCLUDES.includes(s)), {
    message: 'A decisions:relay key holds neither requests:write nor admin',
    path: ['scopes'],
  });
export type ApiKeyInput = z.input<typeof ApiKeyInput>;

export const ApiKey = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(ApiScope),
  /** The Landflow workflow ids whose `landflow_run` origins this key may vouch for (empty: none). */
  boundWorkflowIds: z.array(z.string()),
  createdBy: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof ApiKey>;

// Dimensions --------------------------------------------------------------------------------------------------------

/** Where a dimension row came from. `dev-seed` marks development sample data (the prototype's cost centers). */
export const Origin = z.enum(['entered', 'scim', 'datarails', 'csv', 'dev-seed']);
export type Origin = z.infer<typeof Origin>;

const versioned = {
  code: z.string(),
  version: z.number().int(),
  name: z.string(),
  ownerName: z.string().nullable(),
  ownerSubject: z.string().nullable(),
  validFrom: Day,
  validTo: Day.nullable(),
  origin: Origin,
};

export const CostCenter = z.object({ ...versioned, description: z.string() });
export type CostCenter = z.infer<typeof CostCenter>;

export const Team = z.object({ ...versioned, costCenterCode: z.string().nullable() });
export type Team = z.infer<typeof Team>;

export const Product = z.object({ ...versioned });
export type Product = z.infer<typeof Product>;

// Rate cards (spec 002's shape) --------------------------------------------------------------------------------------

export const RateLine = z.object({
  id: z.string(),
  skuId: z.string(),
  skuPriceId: z.string(),
  skuMeter: z.string(),
  label: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** FOCUS Unit Format: `Core-Hours`, `GiB-Hours`, `GB-Months`, `GB`, `1000000 Tokens`. */
  pricingUnit: z.string(),
  unitPrice: DecimalString,
  currency: CurrencyCode,
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type RateLine = z.infer<typeof RateLine>;

export const RateCardVersion = z.object({
  id: z.string(),
  version: z.number().int(),
  /** A proposal until a person approves it. */
  status: z.enum(['proposed', 'approved']),
  effectiveFrom: Day,
  effectiveTo: Day.nullable(),
  hoursPerMonth: DecimalString,
  note: z.string(),
  proposedBy: z.string(),
  proposedAt: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  lines: z.array(RateLine),
});
export type RateCardVersion = z.infer<typeof RateCardVersion>;

export const RateCard = z.object({
  id: z.string(),
  name: z.string(),
  currency: CurrencyCode,
  owner: z.string(),
  /** The approved version in effect today, if any. */
  current: RateCardVersion.nullable(),
  versions: z.array(RateCardVersion),
});
export type RateCard = z.infer<typeof RateCard>;

// P&L classes (allocation itself is spec 003) ------------------------------------------------------------------------

export const PlClass = z.enum(['cost_of_revenue', 'rnd', 'sm', 'ga']);
export type PlClass = z.infer<typeof PlClass>;
export const PL_CLASS_LABEL: Readonly<Record<PlClass, string>> = {
  cost_of_revenue: 'Cost of revenue',
  rnd: 'R&D',
  sm: 'S&M',
  ga: 'G&A',
};

// Periods, FX and cost records (spec 001) ---------------------------------------------------------------------------

export const PeriodStatus = z.enum(['open', 'closing', 'locked']);
export type PeriodStatus = z.infer<typeof PeriodStatus>;

/** A month of the ledger: open → closing → locked, by a person; locked is final. */
export const Period = z.object({
  month: Month,
  status: PeriodStatus,
  openedAt: z.string(),
  closingBy: z.string().nullable(),
  closingAt: z.string().nullable(),
  lockedBy: z.string().nullable(),
  lockedAt: z.string().nullable(),
});
export type Period = z.infer<typeof Period>;

export const FxRate = z.object({
  id: z.string(),
  base: CurrencyCode,
  quote: CurrencyCode,
  date: Day,
  rate: DecimalString,
  source: z.string(),
  recordedBy: z.string(),
  recordedAt: z.string(),
});
export type FxRate = z.infer<typeof FxRate>;

const wireColumn = (c: FocusColumn): z.ZodType => {
  const base =
    c.storage === 'micros'
      ? AmountString
      : c.type === 'Decimal'
        ? DecimalString
        : c.type === 'JSON'
          ? z.record(z.string(), z.unknown())
          : c.type === 'DateTime'
            ? z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'a UTC date/time')
            : z.string();
  return c.nullable ? base.nullable() : base;
};

/**
 * A cost record on the wire (libs/focus `toWire`): FOCUS names, amounts and decimals as strings, never JSON numbers.
 * Built from libs/focus's catalogue, so the two never drift.
 */
export const CostRecord = z.strictObject(Object.fromEntries(COLUMNS.map((c) => [c.name, wireColumn(c)])));
export type CostRecord = Record<string, string | Record<string, unknown> | null>;

export const RecordsQuery = z.object({
  month: Month.optional(),
  basis: z.enum(['estimated', 'invoiced']).optional(),
  source: z.enum(['landflow', 'clickland', 'invoice', 'manual']).optional(),
  sourceKey: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  /** The `next` of the page before. */
  after: z.string().regex(/^\d+$/).optional(),
});
export type RecordsQuery = z.infer<typeof RecordsQuery>;

export const RecordsPage = z.object({ records: z.array(CostRecord), next: z.string().nullable() });
export type RecordsPage = { records: CostRecord[]; next: string | null };

// Audit -------------------------------------------------------------------------------------------------------------

export const ActorKind = z.enum(['person', 'agent', 'key', 'system']);
export type ActorKind = z.infer<typeof ActorKind>;

export const AuditEntry = z.object({
  seq: z.number().int(),
  at: z.string(),
  actor: z.string(),
  actorKind: ActorKind,
  action: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  data: z.record(z.string(), z.unknown()),
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditVerify = z.object({
  ok: z.boolean(),
  checked: z.number().int(),
  head: z.string().nullable(),
  /** The first entry whose hash doesn't match, and why. */
  brokenAt: z.number().int().nullable(),
  reason: z.string().nullable(),
  /** The newest head sent outside the database (to Clickland and webhooks), if any. */
  anchor: z.object({ seq: z.number().int(), hash: z.string(), at: z.string() }).nullable(),
  /** Entries up to the anchor are missing: the end of the log was cut off. */
  truncated: z.boolean(),
});
export type AuditVerify = z.infer<typeof AuditVerify>;

// Webhooks ----------------------------------------------------------------------------------------------------------

/**
 * The events Landledger sends (docs/architecture.md; payloads in requests.ts). `request.created`: a request was
 * submitted; `request.step_pending`: a step waits on its approvers (named, with emails and Landbright subs), also when
 * it escalates; `request.decided`: the request ended (approved, rejected, cancelled, expired); `request.applied`: the
 * change is in place; `budget.at_risk`: a cost center crossed into at risk or over (once per month and state).
 * Review of wave 2: `request.needs_confirmation`: a key named a person as requester or sponsor, and that person
 * confirms it from their own session before it enters the policy; `decision.relayed`: a decision came through a relay
 * channel, sent naming the person so they hear of it; `report.exceptions`: the weekly exceptions report was stored,
 * with its sha256. `cost.anomaly` is planned (wave 3) and never sent yet.
 */
export const WebhookEvent = z.enum([
  'ping',
  'request.created',
  'request.step_pending',
  'request.decided',
  'request.applied',
  'budget.at_risk',
  'cost.anomaly',
  'period.closing',
  /** The audit chain's head (seq and hash), on a schedule: keep it to detect a cut-off log. */
  'audit.anchor',
  'request.needs_confirmation',
  'decision.relayed',
  'report.exceptions',
]);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const WebhookInput = z.object({
  url: z.url({ protocol: /^https?$/ }),
  events: z.array(WebhookEvent).min(1),
  description: z.string().max(500).default(''),
});
export type WebhookInput = z.infer<typeof WebhookInput>;

/**
 * A subscription as listed. An admin person sees every one; a `webhooks:write` key sees only those it created. The
 * signing secret is shown once, at creation, to its creator, and never listed.
 */
export interface WebhookView {
  id: string;
  url: string;
  events: WebhookEvent[];
  description: string;
  createdBy: string;
  /** The key that created it, if a key did (`webhooks:write`). */
  createdByKey: string | null;
  createdAt: string;
}

export * from './requests.js';
export * from './sources.js';
export * from './spend.js';
