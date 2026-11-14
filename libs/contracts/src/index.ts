/**
 * The Landledger API's wire contracts. docs/development.md lists the routes; these schemas are what the API enforces
 * and what the console reads. Money travels as `{ amountMinor: "123456", currency: "USD" }` and decimals as strings,
 * so nothing on the way becomes a float.
 */
import { z } from 'zod';

// Errors ------------------------------------------------------------------------------------------------------------

export const ErrorCode = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
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
export const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'a decimal number as a string');
export const MinorUnits = z.string().regex(/^-?\d+$/, 'integer minor units as a string');
export const Day = z.iso.date();

export const MoneyJson = z.object({ amountMinor: MinorUnits, currency: CurrencyCode });
export type MoneyJson = z.infer<typeof MoneyJson>;

// Who ---------------------------------------------------------------------------------------------------------------

/** What an API key may do (docs/architecture.md, "Security and controls"). No scope decides a request. */
export const ApiScope = z.enum(['read', 'requests:write', 'reservations:write', 'decisions:relay', 'ingest', 'admin']);
export type ApiScope = z.infer<typeof ApiScope>;

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

export const ApiKeyInput = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(ApiScope).min(1),
});
export type ApiKeyInput = z.infer<typeof ApiKeyInput>;

export const ApiKey = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(ApiScope),
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

// Rate cards --------------------------------------------------------------------------------------------------------

export const RateLine = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.string(),
  price: DecimalString,
  currency: CurrencyCode,
});
export type RateLine = z.infer<typeof RateLine>;

export const RateCardVersion = z.object({
  id: z.string(),
  version: z.number().int(),
  effectiveFrom: Day,
  effectiveTo: Day.nullable(),
  note: z.string(),
  approvedBy: z.string().nullable(),
  createdAt: z.string(),
  rates: z.array(RateLine),
});
export type RateCardVersion = z.infer<typeof RateCardVersion>;

export const RateCard = z.object({
  id: z.string(),
  name: z.string(),
  currency: CurrencyCode,
  owner: z.string(),
  /** In effect today, if any. */
  current: RateCardVersion.nullable(),
  versions: z.array(RateCardVersion),
});
export type RateCard = z.infer<typeof RateCard>;

// Allocation rules --------------------------------------------------------------------------------------------------

export const PlClass = z.enum(['cost_of_revenue', 'rnd', 'sm', 'ga']);
export type PlClass = z.infer<typeof PlClass>;
export const PL_CLASS_LABEL: Readonly<Record<PlClass, string>> = {
  cost_of_revenue: 'Cost of revenue',
  rnd: 'R&D',
  sm: 'S&M',
  ga: 'G&A',
};

export const AllocationRule = z.object({
  id: z.string(),
  position: z.number().int(),
  version: z.number().int(),
  /** Every key must match: namespace, label, service, agent, workflow, provider (wave 1 settles the grammar). */
  selector: z.record(z.string(), z.string()),
  costCenterCode: z.string().nullable(),
  teamCode: z.string().nullable(),
  productCode: z.string().nullable(),
  plClass: PlClass,
  capitalisable: z.boolean(),
  effectiveFrom: Day,
  effectiveTo: Day.nullable(),
});
export type AllocationRule = z.infer<typeof AllocationRule>;

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
});
export type AuditVerify = z.infer<typeof AuditVerify>;

// Webhooks ----------------------------------------------------------------------------------------------------------

/** The events Landledger sends (docs/architecture.md). Wave 0 has the outbox; the events start in waves 1 and 2. */
export const WebhookEvent = z.enum([
  'ping',
  'request.step_pending',
  'request.decided',
  'budget.at_risk',
  'cost.anomaly',
  'period.closing',
]);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const WebhookInput = z.object({
  url: z.url({ protocol: /^https?$/ }),
  events: z.array(WebhookEvent).min(1),
  description: z.string().max(500).default(''),
});
export type WebhookInput = z.infer<typeof WebhookInput>;
