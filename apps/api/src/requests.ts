/**
 * Requests and decisions (spec 004, docs/approvals.md). **Agents request; people decide.** A request is raised by a
 * person, or by an agent with a sponsor (a person who answers for it); its policy gives it a path of steps, fixed at
 * submission; each step is decided by one person among its approvers (the cost center's owner, or members of its
 * Landbright groups), never the requester, the sponsor, someone who decided an earlier step, or a rate card's or rule
 * set's proposer or line author. A decision names the sha256 of the evidence snapshot the person was shown. The last
 * approval reserves the request's months, or applies a rate card, rule set or policy change at once. A pending step
 * escalates after its deadline (business hours) and expires the request when the escalated deadline passes too.
 *
 * The database holds the same rules again (migration 0010): status only forward, decisions append-only, one per step,
 * a person's, never the requester's or the sponsor's.
 *
 * Review of wave 2 (migration 0011): a key that names a person (requester, or the agent's sponsor) leaves the request
 * `awaiting_confirmation` until that person confirms it from their own session; every request is stamped with who
 * raised it and whether its origin is verified; the month's automatic approvals count toward the threshold, and nothing
 * is automatic while the cost center is at risk or over; owner steps are the cost center's owner and deputies; a
 * decision cites evidence served to that person within 30 minutes; a relay carries a Slack press Landledger verifies
 * itself, and only ever decides a budget owner's step.
 */
import type { z } from 'zod';
import type {
  ActorKind,
  AppliedInput,
  CreateRequestInput,
  DecisionInput,
  SlackRelayInput,
} from '@landledger/contracts';
import {
  type CreatedBy,
  type DecisionView,
  type EvidencePack,
  type LedgerEvidence,
  type PersonRef,
  type PersonView,
  type PolicyDef,
  REQUEST_KIND_LABEL,
  type RequestBox,
  type RequestChange,
  type RequestDetail,
  type RequestKind,
  type RequestOrigin,
  type RequestsList,
  type RequestsQuery,
  type RequestStatus,
  type RequestSummary,
  type RequestView,
  type Requester,
  RELAYABLE_KINDS,
  RELAYABLE_STEP_KEYS,
  SELF_APPLIED_KINDS,
  type StepView,
  type WebhookEvent,
} from '@landledger/contracts';
import { Decimal, Money } from '@landledger/money';
import type { AuditLog } from './audit.js';
import { addBusinessHours } from './business-hours.js';
import type { Config } from './config.js';
import { day, type Sql, type Tx } from './db.js';
import { ApiError, notFound } from './errors.js';
import { newId, sha256 } from './ids.js';
import type { Policies, PolicyInEffect } from './policies.js';
import { actorOf, type Principal } from './principal.js';
import type { Allocation } from './allocation.js';
import type { RateCards } from './ratecards.js';
import { isServiceLike, type CostCenterOwners } from './owners.js';
import type { PersonLinks, RelayChannels } from './relays.js';
import { addsInMonth, type Reservations } from './reservations.js';
import { addMonths, amount, type Spend } from './spend.js';
import type { Webhooks } from './webhooks.js';

// Rows -----------------------------------------------------------------------------------------------------------------

export interface RequestRow {
  id: string;
  number: number;
  kind: RequestKind;
  title: string;
  note: string;
  cost_center: string;
  amount_micros: string;
  currency: string;
  recurrence: 'monthly' | 'once';
  start_day: Date;
  end_day: Date | null;
  evidence: Record<string, unknown>;
  origin: RequestOrigin;
  related: RequestOrigin[];
  change: RequestChange | null;
  requester_kind: 'person' | 'agent';
  requester_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_system: string | null;
  sponsor_id: string | null;
  created_via: 'session' | 'key' | 'mcp';
  created_by_key: string | null;
  created_by_kind: 'key' | 'person';
  created_by_id: string;
  created_by_name: string;
  origin_verified: boolean;
  idempotency_body_sha256: string | null;
  confirm_person_id: string | null;
  confirm_status: 'waiting' | 'confirmed' | 'declined' | 'expired' | null;
  confirm_at: Date | null;
  confirm_deadline_at: Date | null;
  confirm_reason: string;
  status: RequestStatus;
  policy_id: string | null;
  policy_reason: string | null;
  automatic: boolean;
  created_at: Date;
  submitted_at: Date | null;
  decided_at: Date | null;
  applied_at: Date | null;
  closed_by: string | null;
  close_note: Record<string, unknown> | null;
}

interface StepRow {
  request_id: string;
  position: number;
  key: string;
  label: string;
  groups: string[];
  owner_id: string | null;
  deputy_ids: string[];
  note: string | null;
  status: StepView['status'];
  deadline_hours: number;
  escalate_to: string[];
  started_at: Date | null;
  deadline_at: Date | null;
  escalated_at: Date | null;
  escalated_to: string[];
  decided_at: Date | null;
}

interface DecisionRow {
  id: string;
  request_id: string;
  step: number;
  step_key: string;
  outcome: 'approve' | 'reject';
  comment: string;
  decided_by: string;
  evidence_sha256: string;
  via: 'console' | 'relay';
  relayed_by: string | null;
  channel: string | null;
  relay_channel_id: string | null;
  relay_external_id: string | null;
  decided_at: Date;
}

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  subject: string;
  kind: string;
  active: boolean;
}

/** A person who may decide a step, and why. */
interface Approver extends PersonView {
  via: 'group' | 'owner';
  group: string | null;
}

const PENDING_SUB = 'scim:';
const personOf = (u: UserRow): PersonView => ({
  id: u.id,
  name: u.name,
  email: u.email,
  sub: u.kind === 'person' && !u.subject.startsWith(PENDING_SUB) ? u.subject : null,
});

const usd = (micros: string, currency: string) => Money.ofMicros(micros, currency.trim());
/** `$1,840.00` for sentences. */
export const words = (m: Money) => {
  const [int, frac] = Decimal.parse(amount(m)).toFixed(2, 'halfEven').split('.') as [string, string];
  const neg = int.startsWith('-');
  const digits = neg ? int.slice(1) : int;
  return `${neg ? '−' : ''}${m.currency === 'USD' ? '$' : `${m.currency} `}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
};

/** Canonical JSON of a snapshot: sorted keys, no whitespace; finite numbers as JSON writes them. */
export function canonicalSnapshot(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('A snapshot holds finite numbers only');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalSnapshot).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalSnapshot(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`A snapshot can't hold a ${typeof value}`);
  }
}

type Via = 'session' | 'key' | 'mcp';

/** The groups a step escalates to when it has nowhere else to go: the people who administer Landledger. */
export const ADMIN_GROUPS = ['Finance Controllers', 'Finance CFO'];
/** A decision cites a snapshot served to its person (or, for a relay, the card's) within this long. */
export const FRESH_MS = 30 * 60_000;
/** A relay's person is current when SCIM manages them, or they signed in within this long. */
export const RELAY_CURRENT_MS = 7 * 24 * 3_600_000;
const STALE = 'The request changed or the evidence is stale; reopen it';

/** A step in the making: what pathFor gives, and what submission writes. */
interface PathStep {
  key: string;
  label: string;
  groups: string[];
  ownerId: string | null;
  deputyIds: string[];
  deadlineHours: number;
  escalateTo: string[];
  note: string | null;
}

/** Who a decision is from, and how it came. */
interface Decider {
  id: string;
  via: 'console' | 'relay';
  relay: { key: string; channelId: string; kind: 'slack'; externalId: string } | null;
}

/** What a self-applied change needs done after its transaction (re-pricing, rebuilding allocations). */
export type AfterApplied = (
  change: RequestChange,
  info: { effectiveFrom: string; version: number; by: string },
) => Promise<void>;

// The service ----------------------------------------------------------------------------------------------------------

export class Requests {
  /** Set by services: re-price or rebuild after a rate card or rule set is applied. */
  afterApplied: AfterApplied = async () => {};

  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly spend: Spend,
    private readonly reservations: Reservations,
    private readonly policies: Policies,
    private readonly rateCards: RateCards,
    private readonly allocation: Allocation,
    private readonly config: Pick<
      Config,
      'consoleUrl' | 'stepDeadlineHours' | 'businessDays' | 'timeZone' | 'holidays'
    >,
    private readonly now: () => Date = () => new Date(),
    private readonly owners: CostCenterOwners | null = null,
    private readonly links: PersonLinks | null = null,
    private readonly channels: RelayChannels | null = null,
  ) {}

  /** Business hours from now, in Landledger's calendar (days, time zone, holidays). */
  private deadline(from: Date, hours: number): Date {
    return addBusinessHours(from, hours, {
      days: this.config.businessDays,
      timeZone: this.config.timeZone,
      holidays: this.config.holidays,
    });
  }

  // People -----------------------------------------------------------------------------------------------------------

  /** A known, active person by Landbright `sub` or email; 400 otherwise (they sign in once, or SCIM pushes them). */
  async findPerson(ref: PersonRef, what: string, tx: Tx = this.sql): Promise<UserRow> {
    const [u] = await tx<UserRow[]>`
      SELECT id, name, email, subject, kind, active AND deleted_at IS NULL AS active FROM users
      WHERE kind = 'person' AND deleted_at IS NULL
        AND (${ref.sub ?? null}::text IS NOT NULL AND subject = ${ref.sub ?? null}
             OR ${ref.email ?? null}::text IS NOT NULL AND lower(email) = lower(${ref.email ?? null}))
      ORDER BY (subject = ${ref.sub ?? ''}) DESC LIMIT 1`;
    if (!u)
      throw new ApiError(
        'bad_request',
        `No person ${ref.email ?? ref.sub} is known to Landledger (${what}): they sign in once, or Landbright pushes them over SCIM`,
      );
    if (!u.active) throw new ApiError('forbidden', `${u.email ?? u.name} is deactivated in Landbright (${what})`);
    return u;
  }

  private async users(ids: readonly (string | null)[], tx: Tx = this.sql): Promise<Map<string, UserRow>> {
    const list = [...new Set(ids.filter((i): i is string => !!i))];
    if (!list.length) return new Map();
    const rows = await tx<UserRow[]>`
      SELECT id, name, email, subject, kind, active AND deleted_at IS NULL AS active FROM users WHERE id IN ${tx(list)}`;
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** People excluded from every step: the requester, the sponsor, a change's proposer and line authors. */
  private async excluded(tx: Tx, r: RequestRow): Promise<Set<string>> {
    const out = new Set<string>([r.requester_id, r.sponsor_id].filter((i): i is string => !!i));
    if (r.change?.type === 'rate_card_version') {
      const rows = await tx<{ id: string }[]>`
        SELECT proposed_by AS id FROM rate_card_versions WHERE id = ${r.change.versionId}
        UNION SELECT added_by FROM rate_lines WHERE version_id = ${r.change.versionId}`;
      for (const row of rows) out.add(row.id);
    } else if (r.change?.type === 'rule_set_version') {
      const rows = await tx<{ id: string }[]>`
        SELECT proposed_by AS id FROM allocation_rule_set_versions WHERE id = ${r.change.versionId}`;
      for (const row of rows) out.add(row.id);
    } else if (r.change?.type === 'policy') {
      const rows = await tx<{ id: string }[]>`SELECT proposed_by AS id FROM policies WHERE id = ${r.change.policyId}`;
      for (const row of rows) out.add(row.id);
    }
    return out;
  }

  /** Active people in any of these groups (case-insensitive), by the groups they have now. */
  private async members(tx: Tx, groups: readonly string[]): Promise<(UserRow & { group: string })[]> {
    if (!groups.length) return [];
    const lower = groups.map((g) => g.toLowerCase());
    return tx<(UserRow & { group: string })[]>`
      SELECT DISTINCT ON (u.id) u.id, u.name, u.email, u.subject, u.kind, true AS active, g AS group
      FROM users u, unnest(landledger_effective_groups(u)) g
      WHERE u.kind = 'person' AND u.active AND u.deleted_at IS NULL AND lower(g) = ANY(${lower})
      ORDER BY u.id, g`;
  }

  /**
   * Who may decide a step now: its cost center's owner and deputies if the step is the owner's, else its groups'
   * members; once escalated, the escalation groups' members too. Never the excluded people, anyone who decided another
   * step, or an account that looks like a service (`Administrator`, `admin@…`).
   */
  private async approversOf(
    tx: Tx,
    r: RequestRow,
    s: Pick<StepRow, 'position' | 'owner_id' | 'deputy_ids' | 'groups' | 'escalated_at' | 'escalated_to'>,
    decided: readonly DecisionRow[],
  ): Promise<Approver[]> {
    const out = new Map<string, Approver>();
    const skip = await this.excluded(tx, r);
    for (const d of decided) if (d.step !== s.position) skip.add(d.decided_by);
    const fit = (u: UserRow) => u.active && u.kind === 'person' && !skip.has(u.id) && !isServiceLike(u);
    if (s.owner_id) {
      const users = await this.users([s.owner_id, ...(s.deputy_ids ?? [])], tx);
      for (const id of [s.owner_id, ...(s.deputy_ids ?? [])]) {
        const u = users.get(id);
        if (u && fit(u)) out.set(u.id, { ...personOf(u), via: 'owner', group: null });
      }
    } else
      for (const m of await this.members(tx, s.groups))
        if (fit(m)) out.set(m.id, { ...personOf(m), via: 'group', group: m.group });
    if (s.escalated_at)
      for (const m of await this.members(tx, s.escalated_to))
        if (fit(m) && !out.has(m.id)) out.set(m.id, { ...personOf(m), via: 'group', group: m.group });
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Accounts in a step's groups that look like services: shown apart, never approvers. */
  private async serviceAccountsOf(tx: Tx, s: StepRow): Promise<PersonView[]> {
    const groups = s.escalated_at ? [...s.groups, ...s.escalated_to] : s.groups;
    return (await this.members(tx, groups)).filter((m) => isServiceLike(m)).map(personOf);
  }

  /**
   * A step that has just started with nobody to decide it goes straight to escalation: to the next step's groups, else
   * the admin groups. Its note says why (the owner raised it; its only approver decided an earlier step).
   */
  private async startStep(tx: Tx, r: RequestRow, s: StepRow, rest: readonly StepRow[]): Promise<StepRow> {
    const decided = await tx<DecisionRow[]>`SELECT * FROM decisions WHERE request_id = ${r.id}`;
    if ((await this.approversOf(tx, r, s, decided)).length) return s;
    const next = rest.find((x) => x.position > s.position);
    const to = next?.groups.length ? next.groups : ADMIN_GROUPS;
    const now = this.now();
    let why: string;
    const owner = s.owner_id ? (await this.users([s.owner_id], tx)).get(s.owner_id) : null;
    if (owner && (owner.id === r.requester_id || owner.id === r.sponsor_id))
      why = `${owner.name}, the cost center's owner, ${owner.id === r.requester_id ? 'raised' : 'sponsors'} this request, and no deputy can decide it`;
    else if (decided.length) why = 'Everyone who may decide this step decided an earlier one';
    else why = 'Nobody who may decide this step is active here';
    const note = `${s.note ? `${s.note} ` : ''}${why}: it went straight to ${to.join(' or ')}.`;
    const [esc] = await tx<StepRow[]>`
      UPDATE request_steps SET escalated_at = ${now}, escalated_to = ${to}, note = ${note},
        deadline_at = ${this.deadline(now, s.deadline_hours)}
      WHERE request_id = ${r.id} AND position = ${s.position} RETURNING *`;
    await this.audit.append(
      {
        actor: 'policy',
        actorKind: 'system',
        action: 'request.step_escalated',
        subjectType: 'request',
        subjectId: r.id,
        data: { step: s.position, to, at: 'start', why },
      },
      tx,
    );
    return esc!;
  }

  // Raising and submitting -------------------------------------------------------------------------------------------

  async create(input: z_CreateRequest, by: Principal, via: Via): Promise<{ request: RequestView; created: boolean }> {
    if (SELF_APPLIED_KINDS.includes(input.kind as RequestKind))
      throw new ApiError('bad_request', `A ${input.kind} request is raised by its own route (a proposal)`);
    if (input.amount.currency !== 'USD') throw new ApiError('unprocessable', 'Only USD until FX is set up');
    const evidenceSize = Buffer.byteLength(JSON.stringify(input.evidence ?? {}));
    if (evidenceSize > 64 * 1024) throw new ApiError('bad_request', 'evidence is at most 64 kB of JSON');
    const scope = by.id;
    // The same idempotency key replays the first request only for the same body; another body is a conflict.
    const { idempotencyKey: _k, ...body } = input;
    const bodySha = sha256(canonicalSnapshot({ ...body, via }));
    const replay = async (): Promise<{ request: RequestView; created: boolean } | null> => {
      if (!input.idempotencyKey) return null;
      const [seen] = await this.sql<{ id: string; idempotency_body_sha256: string | null }[]>`
        SELECT id, idempotency_body_sha256 FROM requests
        WHERE idempotency_scope = ${scope} AND idempotency_key = ${input.idempotencyKey}`;
      if (!seen) return null;
      if (seen.idempotency_body_sha256 && seen.idempotency_body_sha256 !== bodySha)
        throw new ApiError(
          'conflict',
          `idempotencyKey ${input.idempotencyKey} was used for another request body: use a new key for a new request`,
          { requestId: seen.id },
        );
      return { request: await this.view(seen.id, by), created: false };
    };
    const first = await replay();
    if (first) return first;
    const who = await this.requesterOf(input, by);
    // Where it came from: Landledger's own word for a session (console) and MCP (always mcp); a key's word otherwise,
    // verified only when the key is bound to that Landflow workflow.
    let origin: RequestOrigin;
    let verified: boolean;
    if (via === 'mcp') {
      origin = { type: 'mcp' };
      verified = true;
    } else if (via === 'session') {
      origin = input.origin ?? { type: 'console' };
      verified = origin.type === 'console';
    } else {
      if (!input.origin) throw new ApiError('bad_request', 'A key says where the request comes from (origin)');
      origin = input.origin;
      verified = origin.type === 'landflow_run' && (by.boundWorkflowIds ?? []).includes(origin.workflowId);
    }
    const createdBy: CreatedBy =
      by.kind === 'person'
        ? { kind: 'person', id: by.id, name: by.name }
        : { kind: 'key', id: by.id, name: by.kind === 'key' ? by.name : by.name };
    // A key (or MCP on a key) that names a person waits for that person's own confirmation.
    const confirmPerson = by.kind === 'person' ? null : (who.requesterId ?? who.sponsorId);
    const [cc] = await this.sql`SELECT 1 FROM cost_center_codes WHERE code = ${input.costCenter}`;
    if (!cc) throw new ApiError('bad_request', `No cost center ${input.costCenter}`);
    const money = Money.parse(input.amount.amount, input.amount.currency);
    if (money.isZero()) throw new ApiError('bad_request', 'A request is for an amount above zero');
    const start = input.start ?? this.now().toISOString().slice(0, 10);
    const end = input.end ?? (input.recurrence === 'once' ? start : null);
    if (end && end < start) throw new ApiError('bad_request', 'end is on or after start');
    const id = newId('req');
    const actor = actorOf(by);
    try {
      await this.sql.begin(async (tx) => {
        await tx`
          INSERT INTO requests (id, kind, title, note, cost_center, amount_micros, currency, recurrence, start_day, end_day,
                                evidence, origin, related, requester_kind, requester_id, agent_id, agent_name,
                                agent_system, sponsor_id, created_via, created_by_key, idempotency_scope, idempotency_key,
                                created_by_kind, created_by_id, created_by_name, origin_verified,
                                idempotency_body_sha256, confirm_person_id, confirm_status)
          VALUES (${id}, ${input.kind}, ${input.title}, ${input.note ?? ''}, ${input.costCenter},
                  ${money.micros.toString()}, ${money.currency}, ${input.recurrence}, ${start}, ${end},
                  ${tx.json((input.evidence ?? {}) as never)}, ${tx.json(origin as never)},
                  ${tx.json((input.related ?? []) as never)}, ${who.kind}, ${who.requesterId}, ${who.agent?.id ?? null},
                  ${who.agent?.name ?? null}, ${who.agent?.system ?? null}, ${who.sponsorId}, ${via},
                  ${by.kind === 'key' ? by.name : null}, ${input.idempotencyKey ? scope : null},
                  ${input.idempotencyKey ?? null}, ${createdBy.kind}, ${createdBy.id}, ${createdBy.name}, ${verified},
                  ${input.idempotencyKey ? bodySha : null}, ${confirmPerson}, ${confirmPerson ? 'waiting' : null})`;
        await this.audit.append(
          {
            ...actor,
            action: 'request.created',
            subjectType: 'request',
            subjectId: id,
            data: {
              kind: input.kind,
              title: input.title,
              costCenter: input.costCenter,
              amountMicros: money.micros.toString(),
              currency: money.currency,
              recurrence: input.recurrence,
              requester: who.label,
              ...(who.agent ? { agent: who.agent.name, sponsor: who.sponsorLabel } : {}),
              origin: origin.type,
              originVerified: verified,
              createdBy: `${createdBy.kind}:${createdBy.id}`,
              ...(confirmPerson ? { needsConfirmation: who.agent ? who.sponsorLabel : who.label } : {}),
              via,
            },
          },
          tx,
        );
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505' && input.idempotencyKey) {
        const again = await replay();
        if (again) return again;
      }
      throw e;
    }
    if (input.submit !== false) await this.submitById(id, actor);
    return { request: await this.view(id, by), created: true };
  }

  /** Who asks: a person's session is the requester; a key or MCP names a person, or an agent and its sponsor. */
  private async requesterOf(
    input: z_CreateRequest,
    by: Principal,
  ): Promise<{
    kind: 'person' | 'agent';
    requesterId: string | null;
    sponsorId: string | null;
    agent: { id: string; name: string; system: string } | null;
    label: string;
    sponsorLabel: string | null;
  }> {
    const r = input.requester;
    if (by.kind === 'person') {
      if (!r || (r.kind === 'person' && (await this.findPerson(r.person, 'requester')).id === by.id))
        return {
          kind: 'person',
          requesterId: by.id,
          sponsorId: null,
          agent: null,
          label: by.email ?? by.id,
          sponsorLabel: null,
        };
      if (r.kind === 'agent') {
        const sponsor = await this.findPerson(r.sponsor, 'sponsor');
        if (sponsor.id !== by.id)
          throw new ApiError('forbidden', 'A person raises a request for an agent as its sponsor: name yourself');
        return {
          kind: 'agent',
          requesterId: null,
          sponsorId: by.id,
          agent: { id: r.agent.id, name: r.agent.name, system: r.agent.system ?? 'landflow' },
          label: `agent ${r.agent.name}`,
          sponsorLabel: by.email ?? by.id,
        };
      }
      throw new ApiError('forbidden', 'A signed-in person raises requests as themselves');
    }
    if (!r)
      throw new ApiError(
        'bad_request',
        'Say who asks: requester { kind: "person", person } or { kind: "agent", agent, sponsor }',
      );
    if (r.kind === 'person') {
      const p = await this.findPerson(r.person, 'requester');
      return {
        kind: 'person',
        requesterId: p.id,
        sponsorId: null,
        agent: null,
        label: p.email ?? p.id,
        sponsorLabel: null,
      };
    }
    const sponsor = await this.findPerson(r.sponsor, 'sponsor');
    return {
      kind: 'agent',
      requesterId: null,
      sponsorId: sponsor.id,
      agent: { id: r.agent.id, name: r.agent.name, system: r.agent.system ?? 'landflow' },
      label: `agent ${r.agent.name}`,
      sponsorLabel: sponsor.email ?? sponsor.id,
    };
  }

  async submit(id: string, by: Principal): Promise<RequestView> {
    const r = await this.row(id);
    if (r.status !== 'draft') throw new ApiError('conflict', `Request is ${r.status}: only a draft is submitted`);
    if (!this.mayAct(r, by))
      throw new ApiError('forbidden', 'The requester, the sponsor or the creating key submits it');
    await this.submitById(id, actorOf(by));
    return this.view(id, by);
  }

  /**
   * draft → awaiting_confirmation when a key named a person who hasn't confirmed it yet; otherwise into the policy:
   * pending with its path, or approved at once by policy below its automatic threshold.
   */
  async submitById(id: string, actor: { actor: string; actorKind: ActorKind }) {
    const r0 = await this.row(id);
    if (r0.confirm_status === 'waiting') {
      await this.sql.begin(async (tx) => {
        const [r] = await tx<RequestRow[]>`SELECT * FROM requests WHERE id = ${id} FOR UPDATE`;
        if (!r || r.status !== 'draft') throw new ApiError('conflict', 'The request was submitted already');
        const now = this.now();
        const due = this.deadline(now, this.config.stepDeadlineHours);
        await tx`
          UPDATE requests SET status = 'awaiting_confirmation', submitted_at = ${now}, confirm_deadline_at = ${due}
          WHERE id = ${id}`;
        const person = (await this.users([r.confirm_person_id], tx)).get(r.confirm_person_id!)!;
        await this.audit.append(
          {
            ...actor,
            action: 'request.awaiting_confirmation',
            subjectType: 'request',
            subjectId: id,
            data: { person: person.email ?? person.id, until: due.toISOString() },
          },
          tx,
        );
        const fresh = await this.rowIn(tx, id);
        const [summary] = await this.summaries([fresh], null, tx);
        await this.event(tx, 'request.needs_confirmation', {
          request: summary,
          person: personOf(person),
          createdBy: this.createdByOf(fresh),
          url: `${this.config.consoleUrl}/requests/${id}`,
        });
      });
      return;
    }
    await this.enterPolicy(id, actor, 'draft');
  }

  /** The named person confirms, from their own session: the request enters the policy now. */
  async confirm(id: string, comment: string, by: Principal): Promise<RequestView> {
    const r = await this.row(id);
    this.confirmer(r, by);
    await this.enterPolicy(id, actorOf(by), 'awaiting_confirmation', { comment, personId: by.id });
    return this.view(id, by);
  }

  /** The named person declines: cancelled, with their reason. */
  async decline(id: string, reason: string, by: Principal): Promise<RequestView> {
    await this.sql.begin(async (tx) => {
      const [r] = await tx<RequestRow[]>`SELECT * FROM requests WHERE id = ${id} FOR UPDATE`;
      if (!r) throw notFound('Request');
      this.confirmer(r, by);
      const actor = actorOf(by);
      await tx`
        UPDATE requests SET status = 'cancelled', decided_at = ${this.now()}, closed_by = ${actor.actor},
          confirm_status = 'declined', confirm_at = ${this.now()}, confirm_reason = ${reason},
          close_note = ${tx.json({ reason, declinedBy: actor.actor } as never)}
        WHERE id = ${id}`;
      await this.audit.append(
        { ...actor, action: 'request.declined', subjectType: 'request', subjectId: id, data: { reason } },
        tx,
      );
      const [summary] = await this.summaries([await this.rowIn(tx, id)], null, tx);
      await this.event(tx, 'request.decided', {
        request: summary,
        outcome: 'cancelled',
        decision: null,
        reservations: [],
      });
    });
    return this.view(id, by);
  }

  /** Only the person the key named, signed in themselves, confirms or declines; only while it waits on them. */
  private confirmer(r: RequestRow, by: Principal) {
    if (by.kind !== 'person' || !by.sessionId)
      throw new ApiError(
        'forbidden',
        'The person named confirms it from their own signed-in session; a key never does',
      );
    if (by.id !== r.confirm_person_id)
      throw new ApiError('forbidden', 'Only the person this request names confirms or declines it');
    if (r.status !== 'awaiting_confirmation')
      throw new ApiError('conflict', `Request is ${r.status}: nothing waits on your confirmation`);
  }

  /** Into the policy: pending with its path, or approved by policy at once below the threshold. */
  private async enterPolicy(
    id: string,
    actor: { actor: string; actorKind: ActorKind },
    from: 'draft' | 'awaiting_confirmation',
    confirmation: { comment: string; personId: string } | null = null,
  ) {
    const r0 = await this.row(id);
    const policy = await this.policies.forRequest(r0.kind, r0.cost_center);
    const ledger = await this.ledgerEvidence(r0, null);
    let path = await this.pathFor(r0, policy, ledger);
    await this.sql.begin(async (tx) => {
      // Requests entering the policy at once on one cost center (or for one agent) take turns, so a split sent in
      // parallel still counts what the others approved by policy.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`automatic:cc:${r0.cost_center}`}))`;
      if (r0.kind === 'ai_budget' && r0.agent_id)
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`automatic:agent:${r0.agent_system ?? ''}:${r0.agent_id}`}))`;
      if (path.automatic) path = await this.pathFor(r0, policy, ledger);
      const [r] = await tx<RequestRow[]>`SELECT * FROM requests WHERE id = ${id} FOR UPDATE`;
      if (!r || r.status !== from)
        throw new ApiError(
          'conflict',
          from === 'draft' ? 'The request was submitted already' : `Request is ${r?.status}`,
        );
      const now = this.now();
      await tx`
        UPDATE requests SET status = 'pending', submitted_at = coalesce(submitted_at, ${now}), policy_id = ${policy.id},
          policy_reason = ${path.reason}, automatic = ${path.automatic},
          confirm_status = ${confirmation ? 'confirmed' : r.confirm_status},
          confirm_at = ${confirmation ? now : r.confirm_at},
          confirm_reason = ${confirmation ? confirmation.comment : r.confirm_reason}
        WHERE id = ${id}`;
      if (confirmation)
        await this.audit.append(
          {
            ...actor,
            action: 'request.confirmed',
            subjectType: 'request',
            subjectId: id,
            data: { comment: confirmation.comment },
          },
          tx,
        );
      await this.audit.append(
        {
          ...actor,
          action: 'request.submitted',
          subjectType: 'request',
          subjectId: id,
          data: {
            policy: policy.id,
            policyVersion: policy.version,
            automatic: path.automatic,
            steps: path.steps.map((s) => s.key),
            reason: path.reason,
          },
        },
        tx,
      );
      const summary = async () => (await this.summaries([await this.rowIn(tx, id)], null, tx))[0]!;
      if (path.automatic) {
        await tx`UPDATE requests SET status = 'approved', decided_at = ${now}, closed_by = 'policy' WHERE id = ${id}`;
        const held = await this.reservations.reserveApprovedIn(tx, { ...r, status: 'approved' }, 'policy');
        await this.audit.append(
          {
            actor: 'policy',
            actorKind: 'system',
            action: 'request.approved',
            subjectType: 'request',
            subjectId: id,
            data: { automatic: true, policy: policy.id, reason: path.reason, reservations: held.length },
          },
          tx,
        );
        const s = await summary();
        await this.event(tx, 'request.created', { request: s });
        await this.event(tx, 'request.decided', {
          request: s,
          outcome: 'approved',
          decision: null,
          reservations: held,
        });
        return;
      }
      const rows: StepRow[] = [];
      let position = 1;
      for (const s of path.steps) {
        const first = position === 1;
        const [row] = await tx<StepRow[]>`
          INSERT INTO request_steps (request_id, position, key, label, groups, owner_id, deputy_ids, note, status,
                                     deadline_hours, escalate_to, started_at, deadline_at)
          VALUES (${id}, ${position}, ${s.key}, ${s.label}, ${s.groups}, ${s.ownerId}, ${s.deputyIds}, ${s.note},
                  ${first ? 'pending' : 'waiting'}, ${s.deadlineHours}, ${s.escalateTo}, ${first ? now : null},
                  ${first ? this.deadline(now, s.deadlineHours) : null})
          RETURNING *`;
        rows.push(row!);
        position++;
      }
      const fresh = await this.rowIn(tx, id);
      const firstStep = await this.startStep(tx, fresh, rows[0]!, rows);
      await this.event(tx, 'request.created', { request: await summary() });
      await this.stepPending(tx, fresh, firstStep, !!firstStep.escalated_at);
    });
  }

  /**
   * What policy approved on a cost center this month (and, for an AI budget, for its agent), which counts toward the
   * automatic threshold so a split or a ratchet reaches a person.
   */
  async automaticThisMonth(r: RequestRow, tx: Tx = this.sql): Promise<{ costCenter: Money; agent: Money | null }> {
    const month = this.now().toISOString().slice(0, 7);
    const from = `${month}-01T00:00:00Z`;
    const to = `${addMonths(month, 1)}-01T00:00:00Z`;
    const [cc] = await tx<{ micros: string }[]>`
      SELECT coalesce(sum(amount_micros), 0)::text AS micros FROM requests
      WHERE automatic AND status IN ('approved', 'applied') AND id <> ${r.id} AND cost_center = ${r.cost_center}
        AND decided_at >= ${from}::timestamptz AND decided_at < ${to}::timestamptz`;
    let agent: Money | null = null;
    if (r.kind === 'ai_budget' && r.agent_id) {
      const [a] = await tx<{ micros: string }[]>`
        SELECT coalesce(sum(amount_micros), 0)::text AS micros FROM requests
        WHERE automatic AND status IN ('approved', 'applied') AND id <> ${r.id} AND kind = 'ai_budget'
          AND agent_id = ${r.agent_id} AND coalesce(agent_system, '') = ${r.agent_system ?? ''}
          AND decided_at >= ${from}::timestamptz AND decided_at < ${to}::timestamptz`;
      agent = Money.ofMicros(a!.micros, 'USD');
    }
    return { costCenter: Money.ofMicros(cc!.micros, 'USD'), agent };
  }

  /**
   * The path a request takes under a policy: automatic below the threshold (counting what policy approved this month
   * on the cost center, and for the agent of an AI budget; never while the cost center is at risk or over); else each
   * step whose condition holds (amount at least / above, the cost center at risk or over now or in the first full
   * month, or this request taking it over budget).
   */
  async pathFor(
    r: RequestRow,
    policy: PolicyInEffect,
    ledger: LedgerEvidence,
  ): Promise<{ automatic: boolean; reason: string; steps: PathStep[] }> {
    const amt = usd(r.amount_micros, r.currency);
    const per = r.recurrence === 'monthly' ? ' a month' : ' once';
    const atRisk =
      ['risk', 'over'].includes(ledger.stateNow) ||
      ledger.stateWith === 'over' ||
      ledger.firstFullMonth?.stateWith === 'over';
    const kindLabel = REQUEST_KIND_LABEL[r.kind];
    const why: string[] = [];
    if (policy.automaticBelow !== null) {
      const threshold = Money.parse(policy.automaticBelow, amt.currency);
      const so = await this.automaticThisMonth(r);
      const withCc = amt.plus(so.costCenter);
      const withAgent = so.agent ? amt.plus(so.agent) : null;
      const under = withCc.compare(threshold) < 0 && (!withAgent || withAgent.compare(threshold) < 0);
      if (under && !atRisk)
        return {
          automatic: true,
          reason: `${words(amt)}${per} is under the automatic threshold of ${words(threshold)} for ${kindLabel.toLowerCase()} (policy v${policy.version})${so.costCenter.isZero() ? '' : `, with ${words(so.costCenter)} approved by policy on ${r.cost_center} this month`}: approved by policy, and reserved.`,
          steps: [],
        };
      if (amt.compare(threshold) < 0) {
        if (atRisk)
          why.push(
            `Nothing is automatic while ${r.cost_center} is at risk or over budget, or this request takes it over`,
          );
        else if (withCc.compare(threshold) >= 0)
          why.push(
            `With ${words(so.costCenter)} approved by policy on ${r.cost_center} this month, ${words(withCc)} reaches the automatic threshold of ${words(threshold)}`,
          );
        else if (withAgent)
          why.push(
            `With ${words(so.agent!)} approved by policy for agent ${r.agent_name} this month, ${words(withAgent)} reaches the automatic threshold of ${words(threshold)}`,
          );
      }
    }
    const steps: PathStep[] = [];
    const owners = this.owners ? await this.owners.of(r.cost_center) : null;
    const owner = owners?.owner?.active && owners.owner.kind === 'person' ? owners.owner : null;
    const stepOf = (def: PolicyDef['steps'][number]): PathStep => {
      const byOwner = def.approvers.costCenterOwner && !!owner;
      const groups = def.approvers.groups.length ? def.approvers.groups : (def.escalateTo ?? ['Finance CFO']);
      return {
        key: def.key,
        label: def.label,
        groups,
        ownerId: byOwner ? owner!.id : null,
        deputyIds: byOwner ? (owners?.deputies ?? []).filter((d) => d.active).map((d) => d.id) : [],
        deadlineHours: def.deadlineHours ?? this.config.stepDeadlineHours,
        escalateTo: def.escalateTo ?? ['Finance CFO'],
        note:
          def.approvers.costCenterOwner && !owner
            ? `${r.cost_center} has no owner mapped in Landledger, so ${groups.join(' or ')} decide${groups.length > 1 ? '' : 's'} this step.`
            : null,
      };
    };
    for (const def of policy.steps) {
      const reasons = this.whenHolds(def, amt, atRisk, ledger);
      if (!reasons.length) continue;
      why.push(`${def.label}: ${reasons.join('; ')}`);
      steps.push(stepOf(def));
    }
    if (!steps.length) {
      // No condition held (a policy with only conditional steps, or an amount under the threshold that is not
      // automatic): its first step decides.
      const def = policy.steps[0]!;
      why.push(`${def.label}: no step's condition held, so the first step decides`);
      steps.push(stepOf(def));
    }
    return {
      automatic: false,
      reason: `${words(amt)}${per} for ${r.cost_center} (${kindLabel.toLowerCase()}, policy v${policy.version}). ${why.join('. ')}.`,
      steps,
    };
  }

  private whenHolds(def: PolicyDef['steps'][number], amt: Money, atRisk: boolean, ledger: LedgerEvidence): string[] {
    const out: string[] = [];
    const w = def.when;
    if (w.always) out.push('every request of this kind');
    if (w.amountAtLeast && amt.compare(Money.parse(w.amountAtLeast, amt.currency)) >= 0)
      out.push(`${words(amt)} is at least ${words(Money.parse(w.amountAtLeast, amt.currency))}`);
    if (w.amountAbove && amt.compare(Money.parse(w.amountAbove, amt.currency)) > 0)
      out.push(`${words(amt)} is above ${words(Money.parse(w.amountAbove, amt.currency))}`);
    if (w.costCenterAtRisk && atRisk)
      out.push(
        ledger.stateNow === 'over'
          ? `the cost center is over its ${ledger.month} budget`
          : ledger.stateNow === 'risk'
            ? `the cost center is at risk in ${ledger.month}`
            : ledger.stateWith === 'over'
              ? `this request takes the cost center over its ${ledger.month} budget`
              : `this request takes the cost center over its ${ledger.firstFullMonth!.month} budget, its first full month`,
      );
    return out;
  }

  // Webhooks -----------------------------------------------------------------------------------------------------------

  private async event(tx: Tx, type: WebhookEvent, data: unknown) {
    await this.webhooks.enqueue(tx, type, data as Record<string, unknown>);
  }

  /** `request.step_pending`: the step, its approvers (name, email, sub), the console link and the evidence hash. */
  private async stepPending(tx: Tx, r: RequestRow, s: StepRow, escalated: boolean) {
    const decided = await tx<DecisionRow[]>`SELECT * FROM decisions WHERE request_id = ${r.id}`;
    const approvers = await this.approversOf(tx, r, s, decided);
    const [summary] = await this.summaries([r], null, tx);
    // Served to the webhook: the card's hash, which a relay may cite within 30 minutes.
    const detail = await this.snapshot(tx, r, null);
    await this.event(tx, 'request.step_pending', {
      request: summary,
      step: {
        position: s.position,
        key: s.key,
        label: s.label,
        groups: escalated ? [...new Set([...s.groups, ...s.escalated_to])] : s.groups,
        deadlineAt: s.deadline_at?.toISOString() ?? null,
        escalated,
      },
      approvers: approvers.map((a) => ({ name: a.name, email: a.email, sub: a.sub, via: a.via, group: a.group })),
      url: `${this.config.consoleUrl}/requests/${r.id}`,
      evidenceSha256: detail.evidenceSha256,
      relayable: RELAYABLE_KINDS.includes(r.kind) && RELAYABLE_STEP_KEYS.includes(s.key),
    });
  }

  // Deciding -----------------------------------------------------------------------------------------------------------

  /**
   * A person's decision on the pending step, from their own signed-in session. A key never decides here (a relay sends
   * the channel's signed press to `relay`); the local developer, a system actor or an agent never decides.
   */
  async decide(
    id: string,
    input: z_Decision,
    by: Principal,
  ): Promise<{ request: RequestView; decision: DecisionView }> {
    if (by.kind === 'key')
      throw new ApiError(
        'forbidden',
        "A key never says who decided: a relay sends the channel's signed press to POST /api/relays/slack",
      );
    if (by.kind !== 'person')
      throw new ApiError(
        'forbidden',
        by.kind === 'dev'
          ? 'The local developer is not a person: sign in with Landbright to decide'
          : 'Only a person decides a request',
      );
    if (input.person) {
      const named = await this.findPerson(input.person, 'decision');
      if (named.id !== by.id) throw new ApiError('forbidden', 'A signed-in person decides as themselves');
    }
    return this.record(id, input, { id: by.id, via: 'console', relay: null }, by);
  }

  /**
   * A relayed press: the raw Slack interaction, verified by the channel (signature, 5 minutes, team, app), its user
   * mapped to the person who linked it. Only the budget owner's step of an infra change, AI budget, tool or seat, or
   * other request; the person must be current (SCIM-managed, or signed in within 7 days); the card's hash must have
   * been served within 30 minutes. Sends `decision.relayed` naming the person.
   */
  async relay(
    input: z.output<typeof SlackRelayInput>,
    by: Principal,
  ): Promise<{ request: RequestView; decision: DecisionView }> {
    if (by.kind !== 'key' || !by.scopes.includes('decisions:relay'))
      throw new ApiError('forbidden', 'A relay comes from a key with decisions:relay');
    if (!this.channels || !this.links) throw new ApiError('unavailable', 'Relay channels are not set up');
    const { channel, press } = await this.channels.verifySlack(input);
    const personId = await this.links.personFor('slack', press.userId);
    if (!personId)
      throw new ApiError(
        'forbidden',
        `Slack user ${press.userId} isn't linked to a Landledger person: they link it themselves on their profile page (Link Slack)`,
      );
    const [u] = await this.sql<{ scim_managed: boolean; last_seen_at: Date; name: string }[]>`
      SELECT scim_managed, last_seen_at, name FROM users WHERE id = ${personId}`;
    if (!u?.scim_managed && !(u && this.now().getTime() - u.last_seen_at.getTime() <= RELAY_CURRENT_MS))
      throw new ApiError(
        'forbidden',
        `${u?.name ?? 'This person'} isn't current: a relay needs someone Landbright manages over SCIM, or who signed in to Landledger within 7 days`,
      );
    const out = await this.record(
      press.requestId,
      { outcome: press.outcome, comment: press.comment, evidenceSha256: press.evidenceSha256, step: press.step },
      {
        id: personId,
        via: 'relay',
        relay: { key: by.name, channelId: channel.id, kind: 'slack', externalId: press.userId },
      },
      by,
      channel,
    );
    return out;
  }

  /** Records a decision for a person, from their session or a verified relay, in one transaction. */
  private async record(
    id: string,
    input: { outcome: 'approve' | 'reject'; comment?: string; evidenceSha256: string; step?: number },
    decider: Decider,
    by: Principal,
    channel: { id: string; kind: string; name: string } | null = null,
  ): Promise<{ request: RequestView; decision: DecisionView }> {
    const deciderId = decider.id;
    const via = decider.via;
    let after: { change: RequestChange; effectiveFrom: string; version: number; by: string } | null = null;
    const decisionId = newId('dec');
    await this.sql.begin(async (tx) => {
      const [r] = await tx<RequestRow[]>`SELECT * FROM requests WHERE id = ${id} FOR UPDATE`;
      if (!r) throw notFound('Request');
      if (r.status !== 'pending') throw new ApiError('conflict', `Request is ${r.status}: nothing waits on a decision`);
      const steps = await tx<StepRow[]>`SELECT * FROM request_steps WHERE request_id = ${id} ORDER BY position`;
      const step = steps.find((s) => s.status === 'pending');
      if (!step) throw new ApiError('conflict', 'No step is pending');
      if (input.step !== undefined && input.step !== step.position)
        throw new ApiError('conflict', `The request has moved on: step ${step.position} is pending now. Reload it.`, {
          step: step.position,
        });
      const now = this.now();
      // The expiry job can lag: a step past its deadline takes no decision (it escalates or expires next).
      if (step.deadline_at && step.deadline_at.getTime() <= now.getTime())
        throw new ApiError(
          'conflict',
          `Step ${step.position}'s deadline passed at ${step.deadline_at.toISOString()}: it escalates or expires now. Reopen the request.`,
        );
      if (via === 'relay' && (!RELAYABLE_KINDS.includes(r.kind) || !RELAYABLE_STEP_KEYS.includes(step.key)))
        throw new ApiError(
          'forbidden',
          `A relay never decides the ${step.label} step of a ${REQUEST_KIND_LABEL[r.kind].toLowerCase()} request: decide it in the Landledger console`,
        );
      const [snap] = await tx<{ step: string | null }[]>`
        SELECT body->'request'->>'currentStep' AS step FROM evidence_snapshots
        WHERE request_id = ${id} AND sha256 = ${input.evidenceSha256}`;
      if (!snap)
        throw new ApiError(
          'bad_request',
          'evidenceSha256 is not a snapshot Landledger served for this request: GET /api/requests/:id and send its evidenceSha256',
        );
      if (snap.step !== String(step.position)) throw new ApiError('conflict', STALE, { reason: 'step' });
      // What was shown, to whom, and how long ago: the decider's own serving (or, for a relay, the card's).
      const since = new Date(now.getTime() - FRESH_MS);
      const [served] =
        via === 'console'
          ? await tx`
              SELECT 1 FROM evidence_serves WHERE request_id = ${id} AND sha256 = ${input.evidenceSha256}
                AND to_kind = 'person' AND to_id = ${deciderId} AND served_at >= ${since} LIMIT 1`
          : await tx`
              SELECT 1 FROM evidence_serves WHERE request_id = ${id} AND sha256 = ${input.evidenceSha256}
                AND to_kind IN ('key', 'webhook') AND served_at >= ${since} LIMIT 1`;
      if (!served) throw new ApiError('conflict', STALE, { reason: 'stale' });
      const decided = await tx<DecisionRow[]>`SELECT * FROM decisions WHERE request_id = ${id}`;
      const reason = await this.whyNot(tx, r, step, decided, deciderId);
      if (reason) throw new ApiError('forbidden', reason);
      const users = await this.users([deciderId], tx);
      const decider_ = users.get(deciderId)!;
      await tx`
        INSERT INTO decisions (id, request_id, step, step_key, outcome, comment, decided_by, evidence_sha256, via,
                               relayed_by, channel, relay_channel_id, relay_external_id, decided_at)
        VALUES (${decisionId}, ${id}, ${step.position}, ${step.key}, ${input.outcome}, ${input.comment ?? ''},
                ${deciderId}, ${input.evidenceSha256}, ${via}, ${decider.relay?.key ?? null},
                ${decider.relay?.kind ?? null}, ${decider.relay?.channelId ?? null}, ${decider.relay?.externalId ?? null},
                ${now})`;
      await tx`
        UPDATE request_steps SET status = ${input.outcome === 'approve' ? 'approved' : 'rejected'}, decided_at = ${now}
        WHERE request_id = ${id} AND position = ${step.position}`;
      const actor = { actor: decider_.email ?? decider_.id, actorKind: 'person' as const };
      await this.audit.append(
        {
          ...actor,
          action: input.outcome === 'approve' ? 'request.step_approved' : 'request.step_rejected',
          subjectType: 'request',
          subjectId: id,
          data: {
            step: step.position,
            stepKey: step.key,
            comment: input.comment ?? '',
            evidenceSha256: input.evidenceSha256,
            via,
            ...(decider.relay
              ? {
                  relayed: true,
                  relayedBy: `key:${decider.relay.key}`,
                  channel: decider.relay.kind,
                  channelId: decider.relay.channelId,
                  externalUserId: decider.relay.externalId,
                }
              : {}),
          },
        },
        tx,
      );
      if (decider.relay && channel) {
        const [summary] = await this.summaries([await this.rowIn(tx, id)], null, tx);
        await this.event(tx, 'decision.relayed', {
          request: summary,
          decision: await this.decisionView(tx, decisionId),
          person: personOf(decider_),
          channel: { id: channel.id, kind: channel.kind, name: channel.name },
          url: `${this.config.consoleUrl}/requests/${id}`,
        });
      }
      const rest = steps.filter((s) => s.position > step.position);
      if (input.outcome === 'reject') {
        for (const s of rest)
          await tx`UPDATE request_steps SET status = 'skipped' WHERE request_id = ${id} AND position = ${s.position}`;
        await tx`UPDATE requests SET status = 'rejected', decided_at = ${now}, closed_by = ${actor.actor} WHERE id = ${id}`;
        if (r.change?.type === 'policy') await this.policies.rejectIn(tx, r.change.policyId);
        await this.audit.append(
          {
            ...actor,
            action: 'request.rejected',
            subjectType: 'request',
            subjectId: id,
            data: { step: step.position },
          },
          tx,
        );
        const [summary] = await this.summaries([await this.rowIn(tx, id)], null, tx);
        await this.event(tx, 'request.decided', {
          request: summary,
          outcome: 'rejected',
          decision: await this.decisionView(tx, decisionId),
          reservations: [],
        });
        return;
      }
      const next = rest[0];
      if (next) {
        const [started] = await tx<StepRow[]>`
          UPDATE request_steps SET status = 'pending', started_at = ${now},
            deadline_at = ${this.deadline(now, next.deadline_hours)}
          WHERE request_id = ${id} AND position = ${next.position} RETURNING *`;
        const s2 = await this.startStep(tx, r, started!, rest);
        await this.stepPending(tx, r, s2, !!s2.escalated_at);
        return;
      }
      // The last step: approved. Reserve its months, or apply its change now.
      await tx`UPDATE requests SET status = 'approved', decided_at = ${now}, closed_by = ${actor.actor} WHERE id = ${id}`;
      await this.audit.append(
        {
          ...actor,
          action: 'request.approved',
          subjectType: 'request',
          subjectId: id,
          data: { steps: steps.length, deciders: [...decided.map((d) => d.decided_by), deciderId] },
        },
        tx,
      );
      let held: Awaited<ReturnType<Reservations['reserveApprovedIn']>> = [];
      if (r.change) {
        after = await this.applyChange(tx, r, decider_);
        await tx`UPDATE requests SET status = 'applied', applied_at = ${now} WHERE id = ${id}`;
        await this.audit.append(
          {
            ...actor,
            action: 'request.applied',
            subjectType: 'request',
            subjectId: id,
            data: { change: r.change as unknown as Record<string, unknown>, by: 'Landledger' },
          },
          tx,
        );
      } else held = await this.reservations.reserveApprovedIn(tx, { ...r, status: 'approved' }, actor.actor);
      const [summary] = await this.summaries([await this.rowIn(tx, id)], null, tx);
      await this.event(tx, 'request.decided', {
        request: summary,
        outcome: 'approved',
        decision: await this.decisionView(tx, decisionId),
        reservations: held,
      });
      if (r.change)
        await this.event(tx, 'request.applied', {
          request: summary,
          note: 'Applied by Landledger at approval',
          links: [],
        });
    });
    if (after) {
      const a = after as { change: RequestChange; effectiveFrom: string; version: number; by: string };
      await this.afterApplied(a.change, a);
    }
    const request = await this.view(id, by);
    return { request, decision: request.decisions.find((d) => d.id === decisionId)! };
  }

  /** Why this person can't decide this step now, or null when they can. */
  private async whyNot(
    tx: Tx,
    r: RequestRow,
    s: StepRow,
    decided: readonly DecisionRow[],
    personId: string,
  ): Promise<string | null> {
    const [u] = await tx<UserRow[]>`
      SELECT id, name, email, subject, kind, active AND deleted_at IS NULL AS active FROM users WHERE id = ${personId}`;
    if (!u || u.kind !== 'person') return 'Only a person decides a request';
    if (!u.active) return 'Your access was turned off in Landbright';
    if (isServiceLike(u)) return `${u.name} looks like a service account, not a person: a person decides`;
    if (personId === r.requester_id) return 'You raised this request: someone else decides it';
    if (personId === r.sponsor_id) return 'You sponsor the agent that raised this request: someone else decides it';
    const earlier = decided.find((d) => d.decided_by === personId);
    if (earlier) return `You decided step ${earlier.step}: another person decides this one`;
    if ((await this.excluded(tx, r)).has(personId))
      return r.change?.type === 'rate_card_version'
        ? 'You proposed this rate card version or added a line to it: someone else decides it'
        : 'You proposed this change: someone else decides it';
    const approvers = await this.approversOf(tx, r, s, decided);
    if (!approvers.some((a) => a.id === personId)) {
      const owner = s.owner_id ? (await this.users([s.owner_id], tx)).get(s.owner_id) : null;
      const groups = s.escalated_at ? [...s.groups, ...s.escalated_to] : s.groups;
      return owner
        ? `This step is for ${owner.name}, the cost center's owner${s.deputy_ids.length ? ', or a deputy' : ''}${s.escalated_at ? `, or ${s.escalated_to.join(' or ')}` : ''}`
        : `This step is for ${groups.join(' or ')}; you aren't in ${groups.length > 1 ? 'any of them' : 'it'}`;
    }
    return null;
  }

  /** Applies a rate card, rule set or policy change in the approving transaction, as the last step's person. */
  private async applyChange(tx: Tx, r: RequestRow, decider: UserRow) {
    const change = r.change!;
    const by = {
      id: decider.id,
      label: decider.email ?? decider.id,
      roles: [] as string[],
      actor: decider.email ?? decider.id,
      actorKind: 'person' as const,
      requestId: r.id,
    };
    if (change.type === 'rate_card_version') {
      const v = await this.rateCards.approveIn(tx, change.versionId, by);
      return { change, effectiveFrom: v.effectiveFrom, version: v.version, by: by.actor };
    }
    if (change.type === 'rule_set_version') {
      const v = await this.allocation.approveIn(tx, change.versionId, by);
      return { change, effectiveFrom: v.effectiveFrom, version: v.version, by: by.actor };
    }
    await this.policies.approveIn(tx, change.policyId, decider.id);
    const p = await this.policies.byId(change.policyId, tx);
    await this.audit.append(
      {
        actor: by.actor,
        actorKind: 'person',
        action: 'policy.approved',
        subjectType: 'policy',
        subjectId: p.id,
        data: { kind: p.kind, costCenter: p.costCenter, version: p.version, requestId: r.id },
      },
      tx,
    );
    return { change, effectiveFrom: this.now().toISOString().slice(0, 10), version: p.version, by: by.actor };
  }

  // Cancel, applied ----------------------------------------------------------------------------------------------------

  /** The requester, the agent's sponsor, or the key that raised it. */
  private mayAct(r: RequestRow, by: Principal) {
    return (
      (by.kind === 'person' && (by.id === r.requester_id || by.id === r.sponsor_id)) ||
      (by.kind === 'key' && r.created_by_kind === 'key' && r.created_by_id === by.id)
    );
  }

  /** The creating key, the requester (or sponsor), or an admin person: who may release, mark applied, cancel. */
  mayManage(r: Pick<RequestRow, 'requester_id' | 'sponsor_id' | 'created_by_kind' | 'created_by_id'>, by: Principal) {
    return (
      (by.kind === 'person' && (by.id === r.requester_id || by.id === r.sponsor_id || by.scopes.includes('admin'))) ||
      (by.kind === 'key' && r.created_by_kind === 'key' && r.created_by_id === by.id)
    );
  }

  createdByOf(r: RequestRow): CreatedBy {
    return { kind: r.created_by_kind, id: r.created_by_id, name: r.created_by_name };
  }

  async cancel(id: string, reason: string, by: Principal): Promise<RequestView> {
    await this.sql.begin(async (tx) => {
      const [r] = await tx<RequestRow[]>`SELECT * FROM requests WHERE id = ${id} FOR UPDATE`;
      if (!r) throw notFound('Request');
      if (!this.mayManage(r, by))
        throw new ApiError(
          'forbidden',
          'The requester, the sponsor, the creating key or an admin person cancels a request',
        );
      if (r.status !== 'draft' && r.status !== 'pending' && r.status !== 'awaiting_confirmation')
        throw new ApiError('conflict', `Request is ${r.status}: only a draft or open request is cancelled`);
      await tx`
        UPDATE request_steps SET status = 'skipped' WHERE request_id = ${id} AND status IN ('waiting', 'pending')`;
      const actor = actorOf(by);
      await tx`
        UPDATE requests SET status = 'cancelled', decided_at = ${this.now()}, closed_by = ${actor.actor},
          close_note = ${tx.json({ reason } as never)}
        WHERE id = ${id}`;
      if (r.change?.type === 'policy') await this.policies.rejectIn(tx, r.change.policyId);
      await this.audit.append(
        { ...actor, action: 'request.cancelled', subjectType: 'request', subjectId: id, data: { reason } },
        tx,
      );
      if (r.status !== 'draft') {
        const [summary] = await this.summaries([await this.rowIn(tx, id)], null, tx);
        await this.event(tx, 'request.decided', {
          request: summary,
          outcome: 'cancelled',
          decision: null,
          reservations: [],
        });
      }
    });
    return this.view(id, by);
  }

  async applied(id: string, input: z_Applied, by: Principal): Promise<RequestView> {
    await this.sql.begin(async (tx) => {
      const [r] = await tx<RequestRow[]>`SELECT * FROM requests WHERE id = ${id} FOR UPDATE`;
      if (!r) throw notFound('Request');
      if (!this.mayManage(r, by))
        throw new ApiError('forbidden', 'The creating key, the requester or an admin person says a request is applied');
      if (r.change) throw new ApiError('conflict', 'Landledger applies this kind itself, at approval');
      if (r.status !== 'approved')
        throw new ApiError('conflict', `Request is ${r.status}: only an approved one is applied`);
      const actor = actorOf(by);
      await tx`
        UPDATE requests SET status = 'applied', applied_at = ${this.now()},
          close_note = ${tx.json({ note: input.note ?? '', links: input.links ?? [], by: actor.actor } as never)}
        WHERE id = ${id}`;
      await this.audit.append(
        {
          ...actor,
          action: 'request.applied',
          subjectType: 'request',
          subjectId: id,
          data: { note: input.note ?? '', links: (input.links ?? []).length },
        },
        tx,
      );
      const [summary] = await this.summaries([await this.rowIn(tx, id)], null, tx);
      await this.event(tx, 'request.applied', { request: summary, note: input.note ?? '', links: input.links ?? [] });
    });
    return this.view(id, by);
  }

  // Deadlines: escalate, then expire -------------------------------------------------------------------------------------

  /** The job: pending steps past their deadline escalate once, and expire the request the second time. */
  async expireDue(): Promise<number> {
    // Requests nobody confirmed in time expire.
    const unconfirmed = await this.sql<{ id: string }[]>`
      SELECT id FROM requests WHERE status = 'awaiting_confirmation' AND confirm_deadline_at <= ${this.now()} LIMIT 50`;
    for (const u of unconfirmed)
      await this.sql.begin(async (tx) => {
        const [r] = await tx<RequestRow[]>`SELECT * FROM requests WHERE id = ${u.id} FOR UPDATE`;
        if (!r || r.status !== 'awaiting_confirmation') return;
        await tx`
          UPDATE requests SET status = 'expired', decided_at = ${this.now()}, closed_by = 'deadlines',
            confirm_status = 'expired'
          WHERE id = ${r.id}`;
        await this.audit.append(
          {
            actor: 'deadlines',
            actorKind: 'system',
            action: 'request.expired',
            subjectType: 'request',
            subjectId: r.id,
            data: { unconfirmed: true },
          },
          tx,
        );
        const [summary] = await this.summaries([await this.rowIn(tx, r.id)], null, tx);
        await this.event(tx, 'request.decided', {
          request: summary,
          outcome: 'expired',
          decision: null,
          reservations: [],
        });
      });
    const due = await this.sql<StepRow[]>`
      SELECT s.* FROM request_steps s JOIN requests r ON r.id = s.request_id
      WHERE s.status = 'pending' AND r.status = 'pending' AND s.deadline_at <= ${this.now()} ORDER BY s.deadline_at LIMIT 50`;
    for (const s of due)
      await this.sql.begin(async (tx) => {
        const [r] = await tx<RequestRow[]>`SELECT * FROM requests WHERE id = ${s.request_id} FOR UPDATE`;
        const [cur] = await tx<StepRow[]>`
          SELECT * FROM request_steps WHERE request_id = ${s.request_id} AND position = ${s.position}`;
        if (!r || r.status !== 'pending' || cur?.status !== 'pending') return;
        const now = this.now();
        if (!cur.escalated_at) {
          const to = cur.escalate_to.length ? cur.escalate_to : ['Finance CFO'];
          const [esc] = await tx<StepRow[]>`
            UPDATE request_steps SET escalated_at = ${now}, escalated_to = ${to},
              deadline_at = ${this.deadline(now, cur.deadline_hours)}
            WHERE request_id = ${r.id} AND position = ${cur.position} RETURNING *`;
          await this.audit.append(
            {
              actor: 'deadlines',
              actorKind: 'system',
              action: 'request.step_escalated',
              subjectType: 'request',
              subjectId: r.id,
              data: { step: cur.position, to, deadlineAt: esc!.deadline_at!.toISOString() },
            },
            tx,
          );
          await this.stepPending(tx, r, esc!, true);
          return;
        }
        await tx`UPDATE request_steps SET status = 'expired' WHERE request_id = ${r.id} AND position = ${cur.position}`;
        await tx`UPDATE request_steps SET status = 'skipped' WHERE request_id = ${r.id} AND status = 'waiting'`;
        await tx`UPDATE requests SET status = 'expired', decided_at = ${now}, closed_by = 'deadlines' WHERE id = ${r.id}`;
        if (r.change?.type === 'policy') await this.policies.rejectIn(tx, r.change.policyId);
        await this.audit.append(
          {
            actor: 'deadlines',
            actorKind: 'system',
            action: 'request.expired',
            subjectType: 'request',
            subjectId: r.id,
            data: { step: cur.position },
          },
          tx,
        );
        const [summary] = await this.summaries([await this.rowIn(tx, r.id)], null, tx);
        await this.event(tx, 'request.decided', {
          request: summary,
          outcome: 'expired',
          decision: null,
          reservations: [],
        });
      });
    return due.length + unconfirmed.length;
  }

  // Reading ------------------------------------------------------------------------------------------------------------

  private async row(id: string): Promise<RequestRow> {
    return this.rowIn(this.sql, id);
  }

  private async rowIn(tx: Tx, id: string): Promise<RequestRow> {
    const [r] = await tx<RequestRow[]>`SELECT * FROM requests WHERE id = ${id}`;
    if (!r) throw notFound('Request');
    return r;
  }

  private async decisionView(tx: Tx, id: string): Promise<DecisionView> {
    const [d] = await tx<DecisionRow[]>`SELECT * FROM decisions WHERE id = ${id}`;
    const users = await this.users([d!.decided_by], tx);
    const [s] = await tx<StepRow[]>`
      SELECT * FROM request_steps WHERE request_id = ${d!.request_id} AND position = ${d!.step}`;
    return decisionOf(d!, users, s ?? null);
  }

  /** A request as the API shows it, with what the caller may do. */
  async view(id: string, by: Principal | null, tx: Tx = this.sql): Promise<RequestView> {
    const r = await this.rowIn(tx, id);
    return this.viewOf(tx, r, by);
  }

  private async viewOf(tx: Tx, r: RequestRow, by: Principal | null): Promise<RequestView> {
    const steps = await tx<StepRow[]>`SELECT * FROM request_steps WHERE request_id = ${r.id} ORDER BY position`;
    const decisions = await tx<DecisionRow[]>`SELECT * FROM decisions WHERE request_id = ${r.id} ORDER BY decided_at`;
    const users = await this.users(
      [
        r.requester_id,
        r.sponsor_id,
        r.confirm_person_id,
        ...steps.flatMap((s) => [s.owner_id, ...s.deputy_ids]),
        ...decisions.map((d) => d.decided_by),
      ],
      tx,
    );
    const stepViews: StepView[] = [];
    for (const s of steps) {
      const open = s.status === 'pending' || s.status === 'waiting';
      const people = open ? await this.approversOf(tx, r, s, decisions) : [];
      const owner = s.owner_id ? users.get(s.owner_id) : null;
      const d = decisions.find((x) => x.step === s.position);
      stepViews.push({
        position: s.position,
        key: s.key,
        label: s.label,
        status: s.status,
        approvers: {
          groups: s.groups,
          costCenterOwner: owner ? personOf(owner) : null,
          deputies: s.deputy_ids
            .map((id) => users.get(id))
            .filter((u): u is UserRow => !!u)
            .map(personOf),
          fallback: s.owner_id ? null : (s.note?.match(/\S+ has no owner mapped[^.]*\./)?.[0] ?? null),
          people: people.map(({ via: _v, group: _g, ...p }) => p),
          serviceAccounts: open && !s.owner_id ? await this.serviceAccountsOf(tx, s) : [],
        },
        note: s.note,
        deadlineAt: s.deadline_at?.toISOString() ?? null,
        escalatedAt: s.escalated_at?.toISOString() ?? null,
        escalatedTo: s.escalated_to,
        decision: d ? decisionOf(d, users, s) : null,
      });
    }
    const pending = stepViews.find((s) => s.status === 'pending') ?? null;
    const base = await this.baseOf(tx, r, users);
    const you = await this.youOf(tx, r, steps, decisions, by, pending);
    return {
      ...base,
      steps: stepViews,
      currentStep: pending?.position ?? null,
      decisions: decisions.map((d) => decisionOf(d, users, steps.find((s) => s.position === d.step) ?? null)),
      reservations: await this.reservations.forRequest(r.id, tx),
      you,
    };
  }

  private async baseOf(tx: Tx, r: RequestRow, users: Map<string, UserRow>) {
    const [cc] = await tx<{ name: string; owner_name: string | null }[]>`
      SELECT name, owner_name FROM cost_centers WHERE code = ${r.cost_center} ORDER BY version DESC LIMIT 1`;
    const [p] = r.policy_id
      ? await tx<{ version: number }[]>`SELECT version FROM policies WHERE id = ${r.policy_id}`
      : [];
    const amt = usd(r.amount_micros, r.currency);
    const requester: Requester =
      r.requester_kind === 'person'
        ? { kind: 'person', person: personOf(users.get(r.requester_id!)!) }
        : {
            kind: 'agent',
            agent: { id: r.agent_id!, name: r.agent_name!, system: r.agent_system ?? 'landflow' },
            sponsor: personOf(users.get(r.sponsor_id!)!),
          };
    return {
      id: r.id,
      number: `R-${r.number}`,
      kind: r.kind,
      title: r.title,
      note: r.note,
      status: r.status,
      costCenter: { code: r.cost_center, name: cc?.name ?? r.cost_center, owner: cc?.owner_name ?? null },
      amount: { amount: amount(amt), currency: amt.currency },
      recurrence: r.recurrence,
      start: day(r.start_day),
      end: r.end_day ? day(r.end_day) : null,
      thresholdAmount: amount(amt),
      evidence: r.evidence,
      origin: { ...r.origin, verified: r.origin_verified },
      related: r.related,
      requester,
      createdVia: r.created_via,
      createdByKey: r.created_by_key,
      createdBy: this.createdByOf(r),
      confirmation:
        r.confirm_person_id && users.get(r.confirm_person_id)
          ? {
              person: personOf(users.get(r.confirm_person_id)!),
              status: r.confirm_status ?? 'waiting',
              at: r.confirm_at?.toISOString() ?? null,
              reason: r.confirm_reason ?? '',
            }
          : null,
      change: r.change,
      automatic: r.automatic,
      policy: r.policy_id ? { id: r.policy_id, version: p?.version ?? 0, reason: r.policy_reason ?? '' } : null,
      createdAt: r.created_at.toISOString(),
      submittedAt: r.submitted_at?.toISOString() ?? null,
      decidedAt: r.decided_at?.toISOString() ?? null,
      appliedAt: r.applied_at?.toISOString() ?? null,
    };
  }

  private async youOf(
    tx: Tx,
    r: RequestRow,
    steps: readonly StepRow[],
    decisions: readonly DecisionRow[],
    by: Principal | null,
    pending: StepView | null,
  ): Promise<RequestView['you']> {
    const isRequester = by?.kind === 'person' && by.id === r.requester_id;
    const isSponsor = by?.kind === 'person' && by.id === r.sponsor_id;
    const canManage = !!by && this.mayManage(r, by);
    const canCancel =
      canManage && (r.status === 'draft' || r.status === 'pending' || r.status === 'awaiting_confirmation');
    const canConfirm = by?.kind === 'person' && r.status === 'awaiting_confirmation' && r.confirm_person_id === by.id;
    let reason: string | null = null;
    if (!by || by.kind !== 'person')
      reason = by?.kind === 'key' ? 'A key relays a person’s signed press; it never decides' : 'Only a person decides';
    else if (r.status === 'awaiting_confirmation')
      reason = 'It waits on the named person’s confirmation before anyone decides it';
    else if (r.status !== 'pending' || !pending) reason = `The request is ${r.status.replace('_', ' ')}`;
    else
      reason = await this.whyNot(
        tx,
        r,
        steps.find((s) => s.position === pending.position)!,
        decisions,
        by.id,
      );
    return { isRequester, isSponsor, canDecide: reason === null, reason, canCancel, canConfirm, canManage };
  }

  /** Rows of the inbox, with each request's step label and the cost center's budget left after it. */
  private async summaries(
    rows: readonly RequestRow[],
    by: Principal | null,
    tx: Tx = this.sql,
  ): Promise<RequestSummary[]> {
    const out: RequestSummary[] = [];
    const months = new Map<string, Awaited<ReturnType<Spend['overview']>>>();
    for (const r of rows) {
      const steps = await tx<StepRow[]>`SELECT * FROM request_steps WHERE request_id = ${r.id} ORDER BY position`;
      const decisions = await tx<DecisionRow[]>`SELECT * FROM decisions WHERE request_id = ${r.id}`;
      const users = await this.users([r.requester_id, r.sponsor_id, r.confirm_person_id], tx);
      const base = await this.baseOf(tx, r, users);
      const pendingRow = steps.find((s) => s.status === 'pending') ?? null;
      const pendingView = pendingRow ? ({ position: pendingRow.position } as StepView) : null;
      const you = await this.youOf(tx, r, steps, decisions, by, pendingView);
      const month = this.monthFor(r);
      if (!months.has(month)) months.set(month, await this.spend.overview(month));
      const cc = months.get(month)!.costCenters.find((c) => c.code === r.cost_center);
      let left: string | null = null;
      if (cc?.budget) {
        const now = Money.parse(cc.budget, 'USD')
          .minus(Money.parse(cc.monthToDate, 'USD'))
          .minus(Money.parse(cc.reserved, 'USD'));
        left = amount(
          r.status === 'draft' || r.status === 'pending' || r.status === 'awaiting_confirmation'
            ? now.minus(addsInMonth(r, month))
            : now,
        );
      }
      out.push({
        ...base,
        currentStep: pendingRow?.position ?? null,
        you,
        stepLabel: pendingRow
          ? `Step ${pendingRow.position} of ${steps.length} · ${pendingRow.label}${pendingRow.escalated_at ? ' (escalated)' : ''}`
          : r.automatic
            ? 'Approved by policy'
            : r.status === 'awaiting_confirmation'
              ? 'Awaiting confirmation'
              : r.status[0]!.toUpperCase() + r.status.slice(1),
        stepCount: steps.length,
        budgetLeftAfter: left,
      });
    }
    return out;
  }

  /** The month a request's evidence looks at: its start month, or this month if it started before. */
  private monthFor(r: RequestRow): string {
    const start = day(r.start_day).slice(0, 7);
    const current = this.now().toISOString().slice(0, 7);
    return start > current ? start : current;
  }

  async list(q: RequestsQuery, by: Principal): Promise<RequestsList> {
    const s = this.sql;
    const rows = await s<RequestRow[]>`
      SELECT * FROM requests
      WHERE ${q.status ? s`status = ${q.status}` : s`true`}
        AND ${q.kind ? s`kind = ${q.kind}` : s`true`}
        AND ${q.costCenter ? s`cost_center = ${q.costCenter}` : s`true`}
      ORDER BY created_at DESC LIMIT 500`;
    const me = by.kind === 'person' ? by.id : null;
    const mine = (r: RequestRow) =>
      (!!me && (r.requester_id === me || r.sponsor_id === me)) ||
      (by.kind === 'key' && r.created_by_kind === 'key' && r.created_by_id === by.id);
    const toConfirm = (r: RequestRow) => !!me && r.status === 'awaiting_confirmation' && r.confirm_person_id === me;
    const decided = (r: RequestRow) =>
      r.status !== 'draft' && r.status !== 'pending' && r.status !== 'awaiting_confirmation';
    const waitingIds = new Set<string>();
    if (me)
      for (const r of rows.filter((x) => x.status === 'pending')) {
        const steps = await s<StepRow[]>`SELECT * FROM request_steps WHERE request_id = ${r.id} AND status = 'pending'`;
        if (!steps[0]) continue;
        const ds = await s<DecisionRow[]>`SELECT * FROM decisions WHERE request_id = ${r.id}`;
        if (!(await this.whyNot(s, r, steps[0], ds, me))) waitingIds.add(r.id);
      }
    const inBox = (r: RequestRow, box: RequestBox) =>
      box === 'waiting'
        ? waitingIds.has(r.id)
        : box === 'mine'
          ? mine(r)
          : box === 'decided'
            ? decided(r)
            : box === 'open'
              ? r.status === 'pending'
              : box === 'confirm'
                ? toConfirm(r)
                : true;
    const picked = rows.filter((r) => inBox(r, q.box ?? 'all')).slice(0, q.limit ?? 50);
    return {
      requests: await this.summaries(picked, by),
      counts: {
        waiting: waitingIds.size,
        mine: rows.filter(mine).length,
        decided: rows.filter(decided).length,
        open: rows.filter((r) => r.status === 'pending').length,
        confirm: rows.filter(toConfirm).length,
      },
    };
  }

  async decisions(id: string): Promise<DecisionView[]> {
    await this.row(id);
    const rows = await this.sql<DecisionRow[]>`SELECT * FROM decisions WHERE request_id = ${id} ORDER BY decided_at`;
    const steps = await this.sql<StepRow[]>`SELECT * FROM request_steps WHERE request_id = ${id}`;
    const users = await this.users(rows.map((d) => d.decided_by));
    return rows.map((d) => decisionOf(d, users, steps.find((s) => s.position === d.step) ?? null));
  }

  // Evidence and snapshots ---------------------------------------------------------------------------------------------

  /** Landledger's evidence for a request: the cost center's month now and with it, the rate card, similar requests. */
  async ledgerEvidence(r: RequestRow, tx: Tx | null): Promise<LedgerEvidence> {
    const q = tx ?? this.sql;
    const month = this.monthFor(r);
    const ov = await this.spend.overview(month);
    const cc = ov.costCenters.find((c) => c.code === r.cost_center);
    const U = 'USD';
    const counted = r.status === 'approved' || r.status === 'applied';
    const adds = addsInMonth(r, month);
    const budget = cc?.budget ? Money.parse(cc.budget, U) : null;
    const actual = cc ? Money.parse(cc.monthToDate, U) : Money.zero(U);
    const allReserved = cc ? Money.parse(cc.reserved, U) : Money.zero(U);
    // Once approved, the request's own reservation is in the cost center's reserved: "now" means without it, so the
    // figures read as they did when it was decided.
    const [own] = counted
      ? await q<{ micros: string }[]>`
          SELECT coalesce(sum(greatest(amount_micros - consumed_micros, 0)), 0)::text AS micros FROM reservations
          WHERE request_id = ${r.id} AND month = ${`${month}-01`}::date AND status = 'reserved'`
      : [{ micros: '0' }];
    const ownReserved = Money.ofMicros(own!.micros, U);
    const reserved = allReserved.minus(ownReserved);
    const forecast = cc?.forecast ? Money.parse(cc.forecast, U) : null;
    const extra = counted ? ownReserved : adds;
    const leftNow = budget ? budget.minus(actual).minus(reserved) : null;
    const leftAfter = leftNow ? leftNow.minus(extra) : null;
    const forecastWith = forecast ? forecast.plus(reserved).plus(extra) : null;
    const state = (withIt: boolean): LedgerEvidence['stateNow'] => {
      if (!budget) return 'none';
      const held = actual.plus(reserved).plus(withIt ? extra : Money.zero(U));
      if (held.compare(budget) > 0 || actual.compare(budget) > 0) return 'over';
      const f = forecast ? forecast.plus(reserved).plus(withIt ? extra : Money.zero(U)) : null;
      if (!f) return 'early';
      return f.compare(budget) > 0 ? 'risk' : 'ok';
    };
    const [rc] = await q<{ version: number; effective_from: Date; approver: string | null }[]>`
      SELECT v.version, v.effective_from, u.email AS approver FROM rate_card_versions v
      LEFT JOIN users u ON u.id = v.approved_by
      WHERE v.rate_card_id = 'rc_internal' AND v.approved_at IS NOT NULL ORDER BY v.effective_from DESC LIMIT 1`;
    const similar = await q<RequestRow[]>`
      SELECT * FROM requests WHERE cost_center = ${r.cost_center} AND kind = ${r.kind} AND id <> ${r.id}
        AND status <> 'draft' ORDER BY created_at DESC LIMIT 5`;
    const firstFullMonth = await this.firstFullMonthOf(r, month, counted, q);
    const so = await this.automaticThisMonth(r, q);
    const commitment = this.commitmentOf(r);
    const rateCardChange = await this.rateCardChangeOf(r, q);
    let why = r.policy_reason;
    if (!why) {
      const policy = await this.policies.forRequest(r.kind, r.cost_center, q);
      const partial: LedgerEvidence = {
        month,
        currency: U,
        adds: amount(adds),
        budget: null,
        actual: amount(actual),
        reserved: amount(reserved),
        leftNow: null,
        leftAfter: null,
        forecastNow: null,
        forecastWith: null,
        stateNow: state(false),
        stateWith: state(true),
        rateCard: null,
        similar: [],
        why: '',
        firstFullMonth,
        commitment,
        automaticThisMonth: { costCenter: amount(so.costCenter), agent: so.agent ? amount(so.agent) : null },
        rateCardChange,
      };
      why = (await this.pathFor(r, policy, partial)).reason;
    }
    return {
      month,
      currency: U,
      adds: amount(adds),
      budget: budget ? amount(budget) : null,
      actual: amount(actual),
      reserved: amount(reserved),
      leftNow: leftNow ? amount(leftNow) : null,
      leftAfter: leftAfter ? amount(leftAfter) : null,
      forecastNow: forecast ? amount(forecast.plus(reserved)) : null,
      forecastWith: forecastWith ? amount(forecastWith) : null,
      stateNow: state(false),
      stateWith: state(true),
      rateCard: rc
        ? { version: rc.version, effectiveFrom: day(rc.effective_from), approvedBy: rc.approver ?? null }
        : null,
      similar: similar.map((s) => ({
        id: s.id,
        number: `R-${s.number}`,
        title: s.title,
        amount: amount(usd(s.amount_micros, s.currency)),
        recurrence: s.recurrence,
        status: s.status,
        decidedAt: s.decided_at?.toISOString() ?? null,
      })),
      why,
      firstFullMonth,
      commitment,
      automaticThisMonth: { costCenter: amount(so.costCenter), agent: so.agent ? amount(so.agent) : null },
      rateCardChange,
    };
  }

  /**
   * A monthly request that starts part-way through `month` adds only part of a month there: the month after is its
   * first full month, with that month's budget, what is reserved in it, and the state with the request.
   */
  private async firstFullMonthOf(
    r: RequestRow,
    month: string,
    counted: boolean,
    q: Tx,
  ): Promise<LedgerEvidence['firstFullMonth']> {
    if (r.recurrence !== 'monthly') return null;
    const full = usd(r.amount_micros, r.currency);
    if (addsInMonth(r, month).compare(full) >= 0) return null;
    const next = addMonths(month, 1);
    const adds = addsInMonth(r, next);
    if (adds.compare(full) < 0) return null;
    const ov = await this.spend.overview(next);
    const cc = ov.costCenters.find((c) => c.code === r.cost_center);
    const U = 'USD';
    const budget = cc?.budget ? Money.parse(cc.budget, U) : null;
    const actual = cc ? Money.parse(cc.monthToDate, U) : Money.zero(U);
    let reserved = cc ? Money.parse(cc.reserved, U) : Money.zero(U);
    if (counted) {
      const [own] = await q<{ micros: string }[]>`
        SELECT coalesce(sum(greatest(amount_micros - consumed_micros, 0)), 0)::text AS micros FROM reservations
        WHERE request_id = ${r.id} AND month = ${`${next}-01`}::date AND status = 'reserved'`;
      reserved = reserved.minus(Money.ofMicros(own!.micros, U));
    }
    const leftAfter = budget ? budget.minus(actual).minus(reserved).minus(adds) : null;
    return {
      month: next,
      adds: amount(adds),
      budget: budget ? amount(budget) : null,
      reserved: amount(reserved),
      leftAfter: leftAfter ? amount(leftAfter) : null,
      stateWith: !budget ? 'none' : leftAfter!.sign() < 0 ? 'over' : 'ok',
    };
  }

  /** Per month, a year of it (open-ended too), and the whole window when it ends. */
  private commitmentOf(r: RequestRow): LedgerEvidence['commitment'] {
    const amt = usd(r.amount_micros, r.currency);
    if (r.recurrence === 'once') return { monthly: null, annualised: amount(amt), window: amount(amt) };
    let window: Money | null = null;
    if (r.end_day) {
      window = Money.zero(amt.currency);
      const last = day(r.end_day).slice(0, 7);
      for (let m = day(r.start_day).slice(0, 7), n = 0; m <= last && n < 600; m = addMonths(m, 1), n++)
        window = window.plus(addsInMonth(r, m));
    }
    return {
      monthly: amount(amt),
      annualised: amount(Money.fromDecimal(amt.toDecimal().times('12'), amt.currency)),
      window: window ? amount(window) : null,
    };
  }

  /** A rate card change: its version's lines (frozen once the request exists) and their sha256. */
  private async rateCardChangeOf(r: RequestRow, q: Tx): Promise<LedgerEvidence['rateCardChange']> {
    if (r.change?.type !== 'rate_card_version') return null;
    const versionId = r.change.versionId;
    const lines = await q<
      {
        sku_price_id: string;
        label: string;
        pricing_unit: string;
        unit_price: string;
        currency: string;
        added_by: string;
      }[]
    >`
      SELECT sku_price_id, label, pricing_unit, unit_price::text AS unit_price, currency, added_by FROM rate_lines
      WHERE version_id = ${versionId} ORDER BY sku_price_id`;
    const text = canonicalSnapshot(
      lines.map((l) => ({
        skuPriceId: l.sku_price_id,
        label: l.label,
        pricingUnit: l.pricing_unit,
        unitPrice: l.unit_price,
        currency: l.currency.trim(),
        addedBy: l.added_by,
      })),
    );
    return { versionId, lines: lines.length, linesSha256: sha256(text) };
  }

  /**
   * The request and its evidence as shown, hashed and kept, with who it was served to and when: a decision names this
   * hash, served to its person (or, for a relay, to a key or webhook) within 30 minutes. `by` null: a webhook's card.
   */
  private async snapshot(tx: Tx, r: RequestRow, by: Principal | null): Promise<RequestDetail> {
    const request = await this.viewOf(tx, r, by);
    const evidence = await this.ledgerEvidence(r, tx);
    const { you: _you, ...shown } = request;
    const body = { request: shown, evidence };
    const text = canonicalSnapshot(body);
    const hash = sha256(text);
    const at = this.now();
    await tx`
      INSERT INTO evidence_snapshots (request_id, sha256, body)
      VALUES (${r.id}, ${hash}, ${tx.json(JSON.parse(text) as never)}) ON CONFLICT DO NOTHING`;
    const [kind, to] =
      by === null
        ? ['webhook', 'outbox']
        : by.kind === 'person'
          ? ['person', by.id]
          : by.kind === 'dev'
            ? ['dev', 'dev']
            : ['key', by.id];
    await tx`
      INSERT INTO evidence_serves (request_id, sha256, to_kind, to_id, served_at)
      VALUES (${r.id}, ${hash}, ${kind}, ${to}, ${at})`;
    return { request, evidence, evidenceSha256: hash, servedAt: at.toISOString() };
  }

  async detail(id: string, by: Principal): Promise<RequestDetail> {
    return this.sql.begin(async (tx) => this.snapshot(tx, await this.rowIn(tx, id), by)) as Promise<RequestDetail>;
  }

  async storedSnapshot(id: string, hash: string): Promise<{ sha256: string; body: unknown; createdAt: string }> {
    const [row] = await this.sql<{ sha256: string; body: unknown; created_at: Date }[]>`
      SELECT sha256, body, created_at FROM evidence_snapshots WHERE request_id = ${id} AND sha256 = ${hash}`;
    if (!row) throw notFound('Evidence snapshot');
    return { sha256: row.sha256, body: row.body, createdAt: row.created_at.toISOString() };
  }

  /**
   * The evidence pack (review of wave 2): the request, every snapshot served (to whom, when), its decisions, every audit
   * entry about it, and the chain checked from the first of them to the head against the last anchor.
   */
  async evidencePack(id: string, by: Principal): Promise<EvidencePack> {
    const request = await this.view(id, by);
    const snaps = await this.sql<{ sha256: string; body: unknown; created_at: Date }[]>`
      SELECT sha256, body, created_at FROM evidence_snapshots WHERE request_id = ${id} ORDER BY created_at, sha256`;
    const serves = await this.sql<{ sha256: string; to_kind: string; to_id: string; served_at: Date }[]>`
      SELECT sha256, to_kind, to_id, served_at FROM evidence_serves WHERE request_id = ${id} ORDER BY served_at`;
    const names = await this.users(serves.filter((s) => s.to_kind === 'person').map((s) => s.to_id));
    const keyNames = new Map(
      (
        await this.sql<{ id: string; name: string }[]>`
          SELECT id, name FROM api_keys WHERE id IN ${this.sql(
            serves
              .filter((s) => s.to_kind === 'key')
              .map((s) => s.to_id)
              .concat(['-']),
          )}`
      ).map((k) => [k.id, k.name]),
    );
    const toOf = (s: { to_kind: string; to_id: string }) =>
      s.to_kind === 'person'
        ? (names.get(s.to_id)?.email ?? names.get(s.to_id)?.name ?? s.to_id)
        : s.to_kind === 'key'
          ? `key ${keyNames.get(s.to_id) ?? s.to_id}`
          : s.to_kind === 'webhook'
            ? `webhook ${s.to_id}`
            : s.to_id;
    const rows = await this.sql<
      {
        seq: string;
        at: Date;
        actor: string;
        actor_kind: string;
        action: string;
        data: Record<string, unknown>;
        prev_hash: string;
        hash: string;
      }[]
    >`
      SELECT seq, at, actor, actor_kind, action, data, prev_hash, hash FROM audit_log
      WHERE subject_id = ${id} OR (subject_type = 'reservation' AND subject_id IN (
        SELECT id FROM reservations WHERE request_id = ${id}))
      ORDER BY seq`;
    const verify = await this.audit.verify();
    const from = rows.length ? Number(rows[0]!.seq) : 0;
    return {
      generatedAt: this.now().toISOString(),
      request,
      snapshots: snaps.map((s) => ({
        sha256: s.sha256,
        createdAt: s.created_at.toISOString(),
        body: s.body,
        served: serves
          .filter((v) => v.sha256 === s.sha256)
          .map((v) => ({ to: toOf(v), kind: v.to_kind, at: v.served_at.toISOString() })),
      })),
      decisions: await this.decisions(id),
      audit: rows.map((r) => ({
        seq: Number(r.seq),
        at: r.at.toISOString(),
        actor: r.actor,
        actorKind: r.actor_kind,
        action: r.action,
        data: r.data,
        prevHash: r.prev_hash,
        hash: r.hash,
      })),
      chain: {
        from,
        to: verify.checked,
        ok: verify.ok,
        brokenAt: verify.brokenAt,
        anchor: verify.anchor,
      },
    };
  }

  /** A proposal's request (rate card, rule set, policy): raised and submitted with its change. */
  async raiseChange(
    tx: Tx,
    input: {
      kind: Extract<RequestKind, 'rate_card_change' | 'rule_set_change' | 'policy_change'>;
      title: string;
      note: string;
      change: RequestChange;
      evidence: Record<string, unknown>;
      start: string;
    },
    by: Principal,
    /** Who raised it, when not the proposer (a legacy approve route raises the proposer's request). */
    raisedBy: Principal = by,
  ): Promise<string> {
    if (by.kind !== 'person' || raisedBy.kind !== 'person')
      throw new ApiError('forbidden', 'A person proposes a change; an API key never does');
    const id = newId('req');
    await tx`
      INSERT INTO requests (id, kind, title, note, cost_center, amount_micros, currency, recurrence, start_day, end_day,
                            evidence, origin, related, change, requester_kind, requester_id, created_via,
                            created_by_kind, created_by_id, created_by_name, origin_verified)
      VALUES (${id}, ${input.kind}, ${input.title}, ${input.note}, 'SHARED-POOL', 0, 'USD', 'once', ${input.start},
              ${input.start}, ${tx.json(input.evidence as never)}, ${tx.json({ type: 'console' } as never)},
              ${tx.json([] as never)}, ${tx.json(input.change as never)}, 'person', ${by.id}, 'session',
              'person', ${raisedBy.id}, ${raisedBy.name}, true)`;
    await this.audit.append(
      {
        ...actorOf(raisedBy),
        action: 'request.created',
        subjectType: 'request',
        subjectId: id,
        data: {
          kind: input.kind,
          title: input.title,
          change: input.change as unknown as Record<string, unknown>,
          ...(raisedBy.id !== by.id ? { requester: by.email ?? by.id } : {}),
        },
      },
      tx,
    );
    return id;
  }

  /** The request for a version, if one was raised. */
  async forChange(type: 'rate_card_version' | 'rule_set_version', versionId: string): Promise<string | null> {
    const [r] = await this.sql<{ id: string }[]>`
      SELECT id FROM requests WHERE change->>'type' = ${type} AND change->>'versionId' = ${versionId}
      ORDER BY created_at DESC LIMIT 1`;
    return r?.id ?? null;
  }
}

const decisionOf = (d: DecisionRow, users: Map<string, UserRow>, s: StepRow | null): DecisionView => {
  const u = users.get(d.decided_by);
  return {
    id: d.id,
    step: d.step,
    stepKey: d.step_key,
    outcome: d.outcome,
    comment: d.comment,
    person: u ? personOf(u) : { id: d.decided_by, name: d.decided_by, email: null, sub: null },
    at: d.decided_at.toISOString(),
    evidenceSha256: d.evidence_sha256,
    via: d.via,
    relayedBy: d.relayed_by,
    channel: d.channel,
    relay:
      d.via === 'relay' && d.relay_channel_id
        ? { channelId: d.relay_channel_id, kind: 'slack', externalUserId: d.relay_external_id ?? '' }
        : null,
    ownerRole: s?.owner_id === d.decided_by ? 'owner' : s?.deputy_ids.includes(d.decided_by) ? 'deputy' : 'not_owner',
  };
};

// Parsed inputs (zod outputs) ------------------------------------------------------------------------------------------
export type z_CreateRequest = z.output<typeof CreateRequestInput>;
export type z_Decision = z.output<typeof DecisionInput>;
export type z_Applied = z.output<typeof AppliedInput>;
