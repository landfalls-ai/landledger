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
 */
import type { z } from 'zod';
import type { ActorKind, AppliedInput, CreateRequestInput, DecisionInput } from '@landledger/contracts';
import {
  type DecisionView,
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
import { addsInMonth, type Reservations } from './reservations.js';
import { amount, type Spend } from './spend.js';
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
    private readonly config: Pick<Config, 'consoleUrl' | 'stepDeadlineHours' | 'businessDays'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
   * Who may decide a step now: its cost center's owner if the step is the owner's, else its groups' members; once
   * escalated, the escalation groups' members too. Never the excluded people or anyone who decided another step.
   */
  private async approversOf(tx: Tx, r: RequestRow, s: StepRow, decided: readonly DecisionRow[]): Promise<Approver[]> {
    const out = new Map<string, Approver>();
    const skip = await this.excluded(tx, r);
    for (const d of decided) if (d.step !== s.position) skip.add(d.decided_by);
    if (s.owner_id) {
      const owner = (await this.users([s.owner_id], tx)).get(s.owner_id);
      if (owner?.active && !skip.has(owner.id)) out.set(owner.id, { ...personOf(owner), via: 'owner', group: null });
    } else
      for (const m of await this.members(tx, s.groups))
        if (!skip.has(m.id)) out.set(m.id, { ...personOf(m), via: 'group', group: m.group });
    if (s.escalated_at)
      for (const m of await this.members(tx, s.escalated_to))
        if (!skip.has(m.id) && !out.has(m.id)) out.set(m.id, { ...personOf(m), via: 'group', group: m.group });
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // Raising and submitting -------------------------------------------------------------------------------------------

  async create(input: z_CreateRequest, by: Principal, via: Via): Promise<{ request: RequestView; created: boolean }> {
    if (SELF_APPLIED_KINDS.includes(input.kind as RequestKind))
      throw new ApiError('bad_request', `A ${input.kind} request is raised by its own route (a proposal)`);
    const evidenceSize = Buffer.byteLength(JSON.stringify(input.evidence ?? {}));
    if (evidenceSize > 64 * 1024) throw new ApiError('bad_request', 'evidence is at most 64 kB of JSON');
    const scope = by.id;
    if (input.idempotencyKey) {
      const [seen] = await this.sql<{ id: string }[]>`
        SELECT id FROM requests WHERE idempotency_scope = ${scope} AND idempotency_key = ${input.idempotencyKey}`;
      if (seen) return { request: await this.view(seen.id, by), created: false };
    }
    const who = await this.requesterOf(input, by);
    const origin: RequestOrigin | undefined =
      input.origin ?? (via === 'session' ? { type: 'console' } : via === 'mcp' ? { type: 'mcp' } : undefined);
    if (!origin) throw new ApiError('bad_request', 'A key says where the request comes from (origin)');
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
                                agent_system, sponsor_id, created_via, created_by_key, idempotency_scope, idempotency_key)
          VALUES (${id}, ${input.kind}, ${input.title}, ${input.note ?? ''}, ${input.costCenter},
                  ${money.micros.toString()}, ${money.currency}, ${input.recurrence}, ${start}, ${end},
                  ${tx.json((input.evidence ?? {}) as never)}, ${tx.json(origin as never)},
                  ${tx.json((input.related ?? []) as never)}, ${who.kind}, ${who.requesterId}, ${who.agent?.id ?? null},
                  ${who.agent?.name ?? null}, ${who.agent?.system ?? null}, ${who.sponsorId}, ${via},
                  ${by.kind === 'key' ? by.name : null}, ${input.idempotencyKey ? scope : null},
                  ${input.idempotencyKey ?? null})`;
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
              via,
            },
          },
          tx,
        );
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505' && input.idempotencyKey) {
        const [seen] = await this.sql<{ id: string }[]>`
          SELECT id FROM requests WHERE idempotency_scope = ${scope} AND idempotency_key = ${input.idempotencyKey}`;
        if (seen) return { request: await this.view(seen.id, by), created: false };
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
    if (!this.mayAct(r, by)) throw new ApiError('forbidden', 'The requester or the sponsor submits a request');
    await this.submitById(id, actorOf(by));
    return this.view(id, by);
  }

  /** draft → pending with its path; approved at once by policy below its automatic threshold. */
  async submitById(id: string, actor: { actor: string; actorKind: ActorKind }) {
    const r0 = await this.row(id);
    const policy = await this.policies.forRequest(r0.kind, r0.cost_center);
    const ledger = await this.ledgerEvidence(r0, null);
    const path = await this.pathFor(r0, policy, ledger);
    let firstStep: StepRow | null = null;
    await this.sql.begin(async (tx) => {
      const [r] = await tx<RequestRow[]>`SELECT * FROM requests WHERE id = ${id} FOR UPDATE`;
      if (!r || r.status !== 'draft') throw new ApiError('conflict', 'The request was submitted already');
      await tx`
        UPDATE requests SET status = 'pending', submitted_at = now(), policy_id = ${policy.id},
          policy_reason = ${path.reason}, automatic = ${path.automatic}
        WHERE id = ${id}`;
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
        await tx`UPDATE requests SET status = 'approved', decided_at = now(), closed_by = 'policy' WHERE id = ${id}`;
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
      const now = this.now();
      let position = 1;
      for (const s of path.steps) {
        const first = position === 1;
        const [row] = await tx<StepRow[]>`
          INSERT INTO request_steps (request_id, position, key, label, groups, owner_id, status, deadline_hours,
                                     escalate_to, started_at, deadline_at)
          VALUES (${id}, ${position}, ${s.key}, ${s.label}, ${s.groups}, ${s.ownerId}, ${first ? 'pending' : 'waiting'},
                  ${s.deadlineHours}, ${s.escalateTo}, ${first ? now : null},
                  ${first ? addBusinessHours(now, s.deadlineHours, this.config.businessDays) : null})
          RETURNING *`;
        if (first) firstStep = row!;
        position++;
      }
      await this.event(tx, 'request.created', { request: await summary() });
      await this.stepPending(tx, await this.rowIn(tx, id), firstStep!, false);
    });
  }

  /**
   * The path a request takes under a policy: automatic below the threshold; else each step whose condition holds
   * (amount at least / above, the cost center at risk or over, or this request taking it over budget).
   */
  async pathFor(
    r: RequestRow,
    policy: PolicyInEffect,
    ledger: LedgerEvidence,
  ): Promise<{
    automatic: boolean;
    reason: string;
    steps: {
      key: string;
      label: string;
      groups: string[];
      ownerId: string | null;
      deadlineHours: number;
      escalateTo: string[];
    }[];
  }> {
    const amt = usd(r.amount_micros, r.currency);
    const per = r.recurrence === 'monthly' ? ' a month' : ' once';
    const atRisk = ['risk', 'over'].includes(ledger.stateNow) || ledger.stateWith === 'over';
    const kindLabel = REQUEST_KIND_LABEL[r.kind];
    if (policy.automaticBelow !== null && amt.compare(Money.parse(policy.automaticBelow, amt.currency)) < 0)
      return {
        automatic: true,
        reason: `${words(amt)}${per} is under the automatic threshold of ${words(Money.parse(policy.automaticBelow, amt.currency))} for ${kindLabel.toLowerCase()} (policy v${policy.version}): approved by policy, and reserved.`,
        steps: [],
      };
    const why: string[] = [];
    const steps = [];
    const owner = await this.costCenterOwner(r.cost_center);
    for (const def of policy.steps) {
      const reasons = this.whenHolds(def, amt, atRisk, ledger);
      if (!reasons.length) continue;
      why.push(`${def.label}: ${reasons.join('; ')}`);
      steps.push({
        key: def.key,
        label: def.label,
        groups: def.approvers.groups.length ? def.approvers.groups : (def.escalateTo ?? ['Finance CFO']),
        ownerId: def.approvers.costCenterOwner ? (owner?.id ?? null) : null,
        deadlineHours: def.deadlineHours ?? this.config.stepDeadlineHours,
        escalateTo: def.escalateTo ?? ['Finance CFO'],
      });
    }
    if (!steps.length) {
      // No condition held (a policy with only conditional steps): its first step decides.
      const def = policy.steps[0]!;
      why.push(`${def.label}: no step's condition held, so the first step decides`);
      steps.push({
        key: def.key,
        label: def.label,
        groups: def.approvers.groups.length ? def.approvers.groups : ['Finance CFO'],
        ownerId: def.approvers.costCenterOwner ? (owner?.id ?? null) : null,
        deadlineHours: def.deadlineHours ?? this.config.stepDeadlineHours,
        escalateTo: def.escalateTo ?? ['Finance CFO'],
      });
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
            : `this request takes the cost center over its ${ledger.month} budget`,
      );
    return out;
  }

  /** The cost center's owner, when it names a Landbright subject that is an active person here. */
  private async costCenterOwner(code: string): Promise<UserRow | null> {
    const [u] = await this.sql<UserRow[]>`
      SELECT u.id, u.name, u.email, u.subject, u.kind, true AS active
      FROM (SELECT DISTINCT ON (code) owner_subject FROM cost_centers WHERE code = ${code} ORDER BY code, version DESC) c
      JOIN users u ON u.subject = c.owner_subject
      WHERE u.kind = 'person' AND u.active AND u.deleted_at IS NULL LIMIT 1`;
    return u ?? null;
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
    });
  }

  // Deciding -----------------------------------------------------------------------------------------------------------

  /**
   * A person's decision on the pending step: from their session, or relayed by a `decisions:relay` key that names them.
   * The relay's person is found and checked like a signed-in one; an agent, the local developer, a system actor or a
   * key on its own never decides.
   */
  async decide(
    id: string,
    input: z_Decision,
    by: Principal,
  ): Promise<{ request: RequestView; decision: DecisionView }> {
    let deciderId: string;
    let via: 'console' | 'relay';
    let relayedBy: string | null = null;
    if (by.kind === 'person') {
      if (input.person) {
        const named = await this.findPerson(input.person, 'decision');
        if (named.id !== by.id) throw new ApiError('forbidden', 'A signed-in person decides as themselves');
      }
      deciderId = by.id;
      via = 'console';
    } else if (by.kind === 'key') {
      if (!by.scopes.includes('decisions:relay'))
        throw new ApiError('forbidden', 'A key decides nothing: a person does (a relay key needs decisions:relay)');
      if (!input.person)
        throw new ApiError('bad_request', 'A relayed decision names the person who decided: person { sub | email }');
      deciderId = (await this.findPerson(input.person, 'decision')).id;
      via = 'relay';
      relayedBy = by.name;
    } else
      throw new ApiError(
        'forbidden',
        by.kind === 'dev'
          ? 'The local developer is not a person: sign in with Landbright to decide'
          : 'Only a person decides a request',
      );

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
      const [snap] = await tx<{ step: string | null }[]>`
        SELECT body->'request'->>'currentStep' AS step FROM evidence_snapshots
        WHERE request_id = ${id} AND sha256 = ${input.evidenceSha256}`;
      if (!snap)
        throw new ApiError(
          'bad_request',
          'evidenceSha256 is not a snapshot Landledger served for this request: GET /api/requests/:id and send its evidenceSha256',
        );
      if (snap.step !== String(step.position))
        throw new ApiError('conflict', 'The evidence you were shown is from an earlier step: reload the request');
      const decided = await tx<DecisionRow[]>`SELECT * FROM decisions WHERE request_id = ${id}`;
      const reason = await this.whyNot(tx, r, step, decided, deciderId);
      if (reason) throw new ApiError('forbidden', reason);
      const users = await this.users([deciderId], tx);
      const decider = users.get(deciderId)!;
      await tx`
        INSERT INTO decisions (id, request_id, step, step_key, outcome, comment, decided_by, evidence_sha256, via,
                               relayed_by, channel)
        VALUES (${decisionId}, ${id}, ${step.position}, ${step.key}, ${input.outcome}, ${input.comment ?? ''},
                ${deciderId}, ${input.evidenceSha256}, ${via}, ${relayedBy}, ${input.channel ?? null})`;
      await tx`
        UPDATE request_steps SET status = ${input.outcome === 'approve' ? 'approved' : 'rejected'}, decided_at = now()
        WHERE request_id = ${id} AND position = ${step.position}`;
      const actor = { actor: decider.email ?? decider.id, actorKind: 'person' as const };
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
            ...(relayedBy ? { relayedBy: `key:${relayedBy}`, channel: input.channel ?? null } : {}),
          },
        },
        tx,
      );
      const rest = steps.filter((s) => s.position > step.position);
      if (input.outcome === 'reject') {
        for (const s of rest)
          await tx`UPDATE request_steps SET status = 'skipped' WHERE request_id = ${id} AND position = ${s.position}`;
        await tx`UPDATE requests SET status = 'rejected', decided_at = now(), closed_by = ${actor.actor} WHERE id = ${id}`;
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
        const now = this.now();
        const [started] = await tx<StepRow[]>`
          UPDATE request_steps SET status = 'pending', started_at = ${now},
            deadline_at = ${addBusinessHours(now, next.deadline_hours, this.config.businessDays)}
          WHERE request_id = ${id} AND position = ${next.position} RETURNING *`;
        await this.stepPending(tx, r, started!, false);
        return;
      }
      // The last step: approved. Reserve its months, or apply its change now.
      await tx`UPDATE requests SET status = 'approved', decided_at = now(), closed_by = ${actor.actor} WHERE id = ${id}`;
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
        after = await this.applyChange(tx, r, decider);
        await tx`UPDATE requests SET status = 'applied', applied_at = now() WHERE id = ${id}`;
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
        ? `This step is for ${owner.name}, the cost center's owner${s.escalated_at ? `, or ${s.escalated_to.join(' or ')}` : ''}`
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

  private mayAct(r: RequestRow, by: Principal) {
    return (
      (by.kind === 'person' && (by.id === r.requester_id || by.id === r.sponsor_id)) ||
      (by.kind === 'key' && r.created_by_key === by.name)
    );
  }

  async cancel(id: string, reason: string, by: Principal): Promise<RequestView> {
    await this.sql.begin(async (tx) => {
      const [r] = await tx<RequestRow[]>`SELECT * FROM requests WHERE id = ${id} FOR UPDATE`;
      if (!r) throw notFound('Request');
      const admin = by.scopes.includes('admin') && by.kind === 'person';
      if (!this.mayAct(r, by) && !admin)
        throw new ApiError('forbidden', 'The requester, the sponsor or an admin cancels a request');
      if (r.status !== 'draft' && r.status !== 'pending')
        throw new ApiError('conflict', `Request is ${r.status}: only a draft or pending request is cancelled`);
      await tx`
        UPDATE request_steps SET status = 'skipped' WHERE request_id = ${id} AND status IN ('waiting', 'pending')`;
      const actor = actorOf(by);
      await tx`
        UPDATE requests SET status = 'cancelled', decided_at = now(), closed_by = ${actor.actor},
          close_note = ${tx.json({ reason } as never)}
        WHERE id = ${id}`;
      if (r.change?.type === 'policy') await this.policies.rejectIn(tx, r.change.policyId);
      await this.audit.append(
        { ...actor, action: 'request.cancelled', subjectType: 'request', subjectId: id, data: { reason } },
        tx,
      );
      if (r.status === 'pending') {
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
      if (r.change) throw new ApiError('conflict', 'Landledger applies this kind itself, at approval');
      if (r.status !== 'approved')
        throw new ApiError('conflict', `Request is ${r.status}: only an approved one is applied`);
      const actor = actorOf(by);
      await tx`
        UPDATE requests SET status = 'applied', applied_at = now(),
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
              deadline_at = ${addBusinessHours(now, cur.deadline_hours, this.config.businessDays)}
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
        await tx`UPDATE requests SET status = 'expired', decided_at = now(), closed_by = 'deadlines' WHERE id = ${r.id}`;
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
    return due.length;
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
    return decisionOf(d!, users);
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
      [r.requester_id, r.sponsor_id, ...steps.map((s) => s.owner_id), ...decisions.map((d) => d.decided_by)],
      tx,
    );
    const stepViews: StepView[] = [];
    for (const s of steps) {
      const people =
        s.status === 'pending' || s.status === 'waiting' ? await this.approversOf(tx, r, s, decisions) : [];
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
          people: people.map(({ via: _v, group: _g, ...p }) => p),
        },
        deadlineAt: s.deadline_at?.toISOString() ?? null,
        escalatedAt: s.escalated_at?.toISOString() ?? null,
        escalatedTo: s.escalated_to,
        decision: d ? decisionOf(d, users) : null,
      });
    }
    const pending = stepViews.find((s) => s.status === 'pending') ?? null;
    const base = await this.baseOf(tx, r, users);
    const you = await this.youOf(tx, r, steps, decisions, by, pending);
    return {
      ...base,
      steps: stepViews,
      currentStep: pending?.position ?? null,
      decisions: decisions.map((d) => decisionOf(d, users)),
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
      origin: r.origin,
      related: r.related,
      requester,
      createdVia: r.created_via,
      createdByKey: r.created_by_key,
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
    const canCancel =
      !!by &&
      (r.status === 'draft' || r.status === 'pending') &&
      (this.mayAct(r, by) || (by.kind === 'person' && by.scopes.includes('admin')));
    let reason: string | null = null;
    if (!by || by.kind !== 'person')
      reason = by?.kind === 'key' ? 'A key relays a person’s decision; it never decides' : 'Only a person decides';
    else if (r.status !== 'pending' || !pending) reason = `The request is ${r.status}`;
    else
      reason = await this.whyNot(
        tx,
        r,
        steps.find((s) => s.position === pending.position)!,
        decisions,
        by.id,
      );
    return { isRequester, isSponsor, canDecide: reason === null, reason, canCancel };
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
      const users = await this.users([r.requester_id, r.sponsor_id], tx);
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
        left = amount(r.status === 'draft' || r.status === 'pending' ? now.minus(addsInMonth(r, month)) : now);
      }
      out.push({
        ...base,
        currentStep: pendingRow?.position ?? null,
        you,
        stepLabel: pendingRow
          ? `Step ${pendingRow.position} of ${steps.length} · ${pendingRow.label}${pendingRow.escalated_at ? ' (escalated)' : ''}`
          : r.automatic
            ? 'Approved by policy'
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
      (!!me && (r.requester_id === me || r.sponsor_id === me)) || (by.kind === 'key' && r.created_by_key === by.name);
    const decided = (r: RequestRow) => r.status !== 'draft' && r.status !== 'pending';
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
              : true;
    const picked = rows.filter((r) => inBox(r, q.box ?? 'all')).slice(0, q.limit ?? 50);
    return {
      requests: await this.summaries(picked, by),
      counts: {
        waiting: waitingIds.size,
        mine: rows.filter(mine).length,
        decided: rows.filter(decided).length,
        open: rows.filter((r) => r.status === 'pending').length,
      },
    };
  }

  async decisions(id: string): Promise<DecisionView[]> {
    await this.row(id);
    const rows = await this.sql<DecisionRow[]>`SELECT * FROM decisions WHERE request_id = ${id} ORDER BY decided_at`;
    const users = await this.users(rows.map((d) => d.decided_by));
    return rows.map((d) => decisionOf(d, users));
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
    };
  }

  /** The request and its evidence as shown, hashed and kept: a decision names this hash. */
  private async snapshot(tx: Tx, r: RequestRow, by: Principal | null): Promise<RequestDetail> {
    const request = await this.viewOf(tx, r, by);
    const evidence = await this.ledgerEvidence(r, tx);
    const { you: _you, ...shown } = request;
    const body = { request: shown, evidence };
    const text = canonicalSnapshot(body);
    const hash = sha256(text);
    await tx`
      INSERT INTO evidence_snapshots (request_id, sha256, body)
      VALUES (${r.id}, ${hash}, ${tx.json(JSON.parse(text) as never)}) ON CONFLICT DO NOTHING`;
    return { request, evidence, evidenceSha256: hash };
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
  ): Promise<string> {
    if (by.kind !== 'person') throw new ApiError('forbidden', 'A person proposes a change; an API key never does');
    const id = newId('req');
    await tx`
      INSERT INTO requests (id, kind, title, note, cost_center, amount_micros, currency, recurrence, start_day, end_day,
                            evidence, origin, related, change, requester_kind, requester_id, created_via)
      VALUES (${id}, ${input.kind}, ${input.title}, ${input.note}, 'SHARED-POOL', 0, 'USD', 'once', ${input.start},
              ${input.start}, ${tx.json(input.evidence as never)}, ${tx.json({ type: 'console' } as never)},
              ${tx.json([] as never)}, ${tx.json(input.change as never)}, 'person', ${by.id}, 'session')`;
    await this.audit.append(
      {
        ...actorOf(by),
        action: 'request.created',
        subjectType: 'request',
        subjectId: id,
        data: { kind: input.kind, title: input.title, change: input.change as unknown as Record<string, unknown> },
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

const decisionOf = (d: DecisionRow, users: Map<string, UserRow>): DecisionView => {
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
  };
};

// Parsed inputs (zod outputs) ------------------------------------------------------------------------------------------
export type z_CreateRequest = z.output<typeof CreateRequestInput>;
export type z_Decision = z.output<typeof DecisionInput>;
export type z_Applied = z.output<typeof AppliedInput>;
