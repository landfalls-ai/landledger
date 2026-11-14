/**
 * Allocation (spec 003): approved rule set versions send each cost record, whole, to a cost center (with team,
 * product, P&L class and the capitalisable flag), to the shared pool, or to Unallocated. A month's allocations are
 * stored as generations: a generation is the month under one set of rules; records entered later join the newest
 * generation; a rule change (or an explicit rebuild) starts a new one, for open months only. The spread layer (the
 * shared pool shared out by the share rules) is computed when read, from the stored direct layer.
 */
import type { RuleSetVersionView } from '@landledger/contracts';
import {
  type AllocInput,
  allocateDirect,
  type Attrs,
  type DirectRow,
  type Resource,
  type Rule,
  type RuleSetVersion,
  type ShareRule,
  validateRuleSet,
} from '@landledger/allocation';
import type { ActorKind } from '@landledger/contracts';
import { Money } from '@landledger/money';
import type { AuditLog } from './audit.js';
import { day as dayOf, type Sql, type Tx } from './db.js';
import { ApiError, notFound } from './errors.js';
import { newId } from './ids.js';
import { actorOf, type Principal } from './principal.js';

/** Who builds a generation, as the audit log names them (`actorOf` for a principal). */
export type Actor = { actor: string; actorKind: ActorKind };
export const SYSTEM_INGEST: Actor = { actor: 'ingest', actorKind: 'system' };

export const RULE_SET_ID = 'rs_main';
export const RULE_SET_V1 = 'rsv_main_1';

const RESOURCES = new Set(['cpu', 'memory', 'storage', 'network', 'ai']);

/** What a rule matches on, from a record's columns and tags (a cost_records or provisional_usage row). */
export function attrsOf(row: {
  source: string;
  tags: Record<string, unknown> | null;
  sku_meter: string | null;
  actor_id: string | null;
  service_name: string;
}): Attrs {
  const t = (row.tags ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof t[k] === 'string' ? (t[k] as string) : '');
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(t)) if (k.startsWith('label:') && typeof v === 'string') labels[k.slice(6)] = v;
  const resource = s('resource');
  return {
    source: row.source,
    resource: (RESOURCES.has(resource) ? resource : 'cpu') as Resource,
    idle: s('idle') === 'true',
    cluster: s('cluster'),
    service: s('service') || row.service_name,
    provider: s('provider'),
    model: s('model'),
    namespace: s('namespace'),
    workload: s('workload'),
    container: s('container'),
    composeProject: s('composeProject'),
    composeService: s('composeService'),
    workflow: s('workflow'),
    workflowName: s('workflowName'),
    agent: s('agent'),
    agentName: s('agentName'),
    actor: row.actor_id ?? '',
    meter: row.sku_meter ?? '',
    labels,
  };
}

const R = (costCenter: string, plClass: 'rnd' | 'cost_of_revenue' | 'ga' | 'sm' = 'rnd', capitalisable = false) => ({
  costCenter,
  plClass,
  capitalisable,
});

/**
 * DEVELOPMENT SEED DATA: rule set v1 maps this machine's real namespaces, workloads, Docker compose projects and
 * Landflow's AI usage to the six dev cost centers. First match wins; idle is never matched here, so it stays in the
 * shared pool; what nothing matches is Unallocated. Real rules come from finance.
 */
export const DEV_RULES: Rule[] = [
  // Landflow's AI usage: the agents and their models.
  {
    id: 'ai-agents',
    name: 'Landflow AI calls → AI Agents',
    selector: { source: 'landflow' },
    target: R('ENG-AGENTS', 'rnd', true),
  },
  // The cluster (landflow-dev): agents' and teams' workloads, then the host and the rest of the platform.
  {
    id: 'lf-agent-cache',
    name: 'Agent caches (landflow-cache-*) → AI Agents',
    selector: { namespace: 'landflow-dev', workload: 'landflow-cache*' },
    target: R('ENG-AGENTS'),
  },
  {
    id: 'lf-agent-cache-pvc',
    name: 'Agent cache volumes → AI Agents',
    selector: { namespace: 'landflow-dev', resource: 'storage', service: 'landflow-cache*' },
    target: R('ENG-AGENTS'),
  },
  {
    id: 'lf-agent-mcp',
    name: 'Agent tool servers (*-mcp) → AI Agents',
    selector: { namespace: 'landflow-dev', workload: '*-mcp' },
    target: R('ENG-AGENTS'),
  },
  {
    id: 'lf-agent-harness',
    name: 'Agent harness (*harness*, *agent*) → AI Agents',
    selector: { namespace: 'landflow-dev', workload: '*agent*' },
    target: R('ENG-AGENTS'),
  },
  {
    id: 'lf-platform',
    name: 'landflow-dev (host, broker, runner) → Platform',
    selector: { namespace: 'landflow-dev' },
    target: R('ENG-PLATFORM', 'rnd', true),
  },
  {
    id: 'ck-platform',
    name: 'clickland-dev → Platform',
    selector: { namespace: 'clickland-dev' },
    target: R('ENG-PLATFORM'),
  },
  {
    id: 'kagent',
    name: 'kagent kind cluster (landflow-kagent-*) → AI Agents',
    selector: { container: 'landflow-kagent-*' },
    target: R('ENG-AGENTS'),
  },
  {
    id: 'k8s-system',
    name: 'kube-system → shared pool',
    selector: { namespace: 'kube-system' },
    shared: true,
    plClass: 'rnd',
  },
  // Docker compose projects on this machine, by name.
  {
    id: 'dc-clickland',
    name: 'clickland-* compose → Data & ML',
    selector: { composeProject: 'clickland-*' },
    target: R('RND-DATA'),
  },
  {
    id: 'dc-landbright',
    name: 'landbright-* compose → Internal IT',
    selector: { composeProject: 'landbright-*' },
    target: R('GA-IT', 'ga'),
  },
  {
    id: 'dc-landfall',
    name: 'landfall-* compose → Customer Support',
    selector: { composeProject: 'landfall-*' },
    target: R('CS-SUPPORT', 'cost_of_revenue'),
  },
  {
    id: 'dc-landflow',
    name: 'landflow-* compose → Platform',
    selector: { composeProject: 'landflow-*' },
    target: R('ENG-PLATFORM'),
  },
  {
    id: 'dc-lab',
    name: 'lab-observability compose → Platform',
    selector: { composeProject: 'lab-*' },
    target: R('ENG-PLATFORM'),
  },
  {
    id: 'dc-landledger',
    name: 'landledger-* compose → Internal IT',
    selector: { composeProject: 'landledger-*' },
    target: R('GA-IT', 'ga'),
  },
];

/** Opt-in spreading: the shared pool by each cost center's direct cost of the same resource that day (OpenCost). */
export const DEV_SHARES: ShareRule[] = [{ id: 'weighted', method: 'weighted' }];

type VersionRow = {
  id: string;
  rule_set_id: string;
  version: number;
  effective_from: Date;
  effective_to: Date | null;
  rules: Rule[];
  shares: ShareRule[];
  note: string;
  origin: string;
  proposed_by: string;
  proposed_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  approver?: string | null;
};

export const ruleSetVersionOf = (v: VersionRow): RuleSetVersionView => ({
  id: v.id,
  ruleSetId: v.rule_set_id,
  version: v.version,
  status: v.approved_at ? 'approved' : 'proposed',
  effectiveFrom: dayOf(v.effective_from),
  effectiveTo: v.effective_to ? dayOf(v.effective_to) : null,
  rules: v.rules,
  shares: v.shares,
  note: v.note,
  origin: v.origin,
  proposedBy: v.proposed_by,
  proposedAt: v.proposed_at.toISOString(),
  approvedBy: v.approver ?? v.approved_by,
  approvedAt: v.approved_at?.toISOString() ?? null,
});

/** Approved rule set versions, by day. */
export class RuleBook {
  constructor(readonly versions: readonly (RuleSetVersion & { effectiveFrom: string; effectiveTo: string | null })[]) {}
  versionOn(day: string) {
    return this.versions.find((v) => v.effectiveFrom <= day && (v.effectiveTo === null || day < v.effectiveTo)) ?? null;
  }
  sharesOn(day: string): ShareRule[] {
    return this.versionOn(day)?.shares ?? [];
  }
}

const RECORD_COLUMNS =
  'record_id, billing_period_start, charge_period_start, basis, source, tags, sku_meter, actor_id, service_name, effective_cost_micros, billing_currency';
type AllocRow = {
  record_id: string;
  billing_period_start: Date;
  charge_period_start: Date;
  basis: 'estimated' | 'invoiced';
  source: string;
  tags: Record<string, unknown> | null;
  sku_meter: string | null;
  actor_id: string | null;
  service_name: string;
  effective_cost_micros: string;
  billing_currency: string;
};

export const allocInputOf = (r: AllocRow): AllocInput => ({
  recordId: r.record_id,
  day: dayOf(r.charge_period_start),
  amount: Money.ofMicros(r.effective_cost_micros, r.billing_currency.trim()),
  attrs: attrsOf(r),
});

export class Allocation {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
  ) {}

  async book(tx: Tx = this.sql): Promise<RuleBook> {
    const rows = await tx<VersionRow[]>`
      SELECT * FROM allocation_rule_set_versions WHERE rule_set_id = ${RULE_SET_ID} AND approved_at IS NOT NULL
      ORDER BY effective_from`;
    return new RuleBook(
      rows.map((v) => ({
        id: v.id,
        rules: v.rules,
        shares: v.shares,
        effectiveFrom: dayOf(v.effective_from),
        effectiveTo: v.effective_to ? dayOf(v.effective_to) : null,
      })),
    );
  }

  async versions(): Promise<RuleSetVersionView[]> {
    const rows = await this.sql<VersionRow[]>`
      SELECT v.*, u.email AS approver FROM allocation_rule_set_versions v LEFT JOIN users u ON u.id = v.approved_by
      ORDER BY v.version DESC`;
    return rows.map(ruleSetVersionOf);
  }

  /** The dev seed: rule set v1 as a proposal (by `seed`), effective from October 2026 (Landflow's first AI calls). */
  async seedDevRules(tx: Tx = this.sql): Promise<number> {
    const costCenters = new Set(
      (await tx<{ code: string }[]>`SELECT DISTINCT code FROM cost_centers`).map((r) => r.code),
    );
    const problems = validateRuleSet({ rules: DEV_RULES, shares: DEV_SHARES }, costCenters);
    if (problems.length) throw new Error(`The dev rule set doesn't hold: ${problems.join('; ')}`);
    let added = 0;
    const set = await tx`
      INSERT INTO allocation_rule_sets (id, name) VALUES (${RULE_SET_ID}, 'Allocation rules') ON CONFLICT DO NOTHING RETURNING id`;
    added += set.length;
    const v = await tx`
      INSERT INTO allocation_rule_set_versions (id, rule_set_id, version, effective_from, rules, shares, note, origin, proposed_by)
      VALUES (${RULE_SET_V1}, ${RULE_SET_ID}, 1, '2026-10-01', ${tx.json(DEV_RULES as never)}, ${tx.json(DEV_SHARES as never)},
              'DEVELOPMENT SEED DATA: this machine''s namespaces, workloads, compose projects and Landflow AI usage mapped to the six dev cost centers; idle stays in the shared pool; unmatched is Unallocated.',
              'dev-seed', 'seed')
      ON CONFLICT DO NOTHING RETURNING id`;
    if (v.length) {
      added++;
      await this.audit.append(
        {
          actor: 'seed',
          actorKind: 'system',
          action: 'allocation.rule_set_proposed',
          subjectType: 'allocation_rule_set_version',
          subjectId: RULE_SET_V1,
          data: {
            version: 1,
            effectiveFrom: '2026-10-01',
            rules: DEV_RULES.length,
            shares: DEV_SHARES.length,
            origin: 'dev-seed',
          },
        },
        tx,
      );
    }
    return added;
  }

  /** Approves a proposed rule set version (a person, controller or CFO, not the proposer), then rebuilds open months. */
  async approve(versionId: string, by: Principal) {
    if (by.kind !== 'person')
      throw new ApiError(
        'forbidden',
        'Only a person signed in with Landbright approves allocation rules; an API key never does',
      );
    if (!by.roles.some((r) => r === 'controller' || r === 'cfo'))
      throw new ApiError('forbidden', 'Approving allocation rules is for the controller or the CFO');
    const approved = await this.sql.begin(async (tx) => {
      const [v] = await tx<VersionRow[]>`SELECT * FROM allocation_rule_set_versions WHERE id = ${versionId} FOR UPDATE`;
      if (!v) throw notFound('Rule set version');
      if (v.approved_at) throw new ApiError('conflict', `Version ${v.version} is already approved`);
      if (v.proposed_by === by.id)
        throw new ApiError('forbidden', 'The person who proposed a rule set version cannot approve it');
      const from = dayOf(v.effective_from);
      await tx`
        UPDATE allocation_rule_set_versions SET effective_to = ${from}
        WHERE rule_set_id = ${v.rule_set_id} AND approved_at IS NOT NULL AND effective_to IS NULL AND effective_from < ${from}`;
      const [row] = await tx<VersionRow[]>`
        UPDATE allocation_rule_set_versions SET approved_by = ${by.id}, approved_at = now() WHERE id = ${versionId} RETURNING *`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'allocation.rule_set_approved',
          subjectType: 'allocation_rule_set_version',
          subjectId: versionId,
          data: {
            version: v.version,
            effectiveFrom: from,
            proposedBy: v.proposed_by,
            approvedBy: by.email ?? by.id,
            rules: v.rules.length,
          },
        },
        tx,
      );
      return { ...ruleSetVersionOf(row!), approvedBy: by.email ?? by.id };
    });
    const rebuilt = await this.rebuildOpen(
      approved.effectiveFrom.slice(0, 7),
      `rule set v${approved.version} approved`,
      actorOf(by),
    );
    return { version: approved, rebuilt };
  }

  /** Open months from `fromMonth` that have records: a new generation each. */
  async rebuildOpen(fromMonth: string, reason: string, by: Actor) {
    const months = await this.sql<{ month: Date }[]>`
      SELECT DISTINCT date_trunc('month', billing_period_start AT TIME ZONE 'UTC')::date AS month FROM cost_records
      WHERE billing_period_start >= ${`${fromMonth}-01T00:00:00Z`}::timestamptz ORDER BY 1`;
    const out = [];
    for (const m of months) {
      const month = dayOf(m.month).slice(0, 7);
      const [p] = await this.sql<{ status: string }[]>`SELECT status FROM periods WHERE month = ${`${month}-01`}`;
      if (p && p.status !== 'open') continue;
      out.push(await this.rebuild(month, reason, by));
    }
    return out;
  }

  /** A new generation for an open month: every entry of the month allocated under the rules in effect. */
  async rebuild(month: string, reason: string, by: Actor) {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`allocation:${month}`}))`;
      const [p] = await tx<{ status: string }[]>`SELECT status FROM periods WHERE month = ${`${month}-01`}`;
      if (p && p.status !== 'open')
        throw new ApiError('conflict', `${month} is ${p.status}: its allocations are final`);
      const book = await this.book(tx);
      const [{ next }] =
        (await tx`SELECT coalesce(max(number), 0) + 1 AS next FROM allocation_generations WHERE month = ${`${month}-01`}`) as unknown as [
          { next: number },
        ];
      const records = await tx<AllocRow[]>`
        SELECT ${tx.unsafe(RECORD_COLUMNS)} FROM cost_records WHERE billing_period_start = ${`${month}-01T00:00:00Z`}::timestamptz`;
      const id = newId('gen');
      const versionIds = book.versions.map((v) => v.id);
      await tx`
        INSERT INTO allocation_generations (id, month, number, reason, rule_set_version_ids, created_by)
        VALUES (${id}, ${`${month}-01`}, ${next}, ${reason}, ${versionIds}, ${by.actor})`;
      const rows = this.direct(book, records);
      await this.insert(tx, id, month, records, rows);
      await this.audit.append(
        {
          ...by,
          action: 'allocation.generation_built',
          subjectType: 'allocation_generation',
          subjectId: id,
          data: { month, number: next, reason, records: records.length, ruleSetVersions: versionIds },
        },
        tx,
      );
      return { id, month, number: Number(next), records: records.length };
    }) as Promise<{ id: string; month: string; number: number; records: number }>;
  }

  /**
   * Records entered since the month's newest generation join it, under its rules. A month with no generation, or whose
   * newest generation predates the rules now in effect, is rebuilt instead. Called after every ingest run.
   */
  async allocatePending(month: string, by: Actor = SYSTEM_INGEST) {
    const [p] = await this.sql<{ status: string }[]>`SELECT status FROM periods WHERE month = ${`${month}-01`}`;
    if (p && p.status !== 'open') return null;
    const book = await this.book();
    const [gen] = await this.sql<{ id: string; rule_set_version_ids: string[] }[]>`
      SELECT id, rule_set_version_ids FROM allocation_generations WHERE month = ${`${month}-01`} ORDER BY number DESC LIMIT 1`;
    const current = book.versions.map((v) => v.id).join(',');
    if (!gen || gen.rule_set_version_ids.join(',') !== current)
      return this.rebuild(month, gen ? 'rules changed' : 'first allocation', by);
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`allocation:${month}`}))`;
      const records = await tx<AllocRow[]>`
        SELECT ${tx.unsafe(RECORD_COLUMNS)} FROM cost_records r
        WHERE billing_period_start = ${`${month}-01T00:00:00Z`}::timestamptz
          AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.month = ${`${month}-01`} AND a.generation_id = ${gen.id} AND a.record_id = r.record_id)`;
      if (records.length) await this.insert(tx, gen.id, month, records, this.direct(book, records));
      return { id: gen.id, month, number: 0, records: records.length };
    }) as Promise<{ id: string; month: string; number: number; records: number }>;
  }

  direct(book: RuleBook, records: readonly AllocRow[]): DirectRow[] {
    return allocateDirect(records.map(allocInputOf), (d) => book.versionOn(d));
  }

  private async insert(
    tx: Tx,
    generationId: string,
    month: string,
    records: readonly AllocRow[],
    rows: readonly DirectRow[],
  ) {
    const byId = new Map(records.map((r) => [r.record_id, r]));
    const values = rows.map((d) => {
      const r = byId.get(d.recordId)!;
      return {
        month: `${month}-01`,
        generation_id: generationId,
        record_id: d.recordId,
        billing_period_start: r.billing_period_start,
        charge_day: d.day,
        basis: r.basis,
        cost_center: d.costCenter,
        team: d.team,
        product: d.product,
        pl_class: d.plClass,
        capitalisable: d.capitalisable,
        rule_id: d.ruleId,
        rule_set_version_id: d.ruleSetVersionId,
        amount_micros: d.amount.micros.toString(),
        currency: d.amount.currency,
      };
    });
    for (let i = 0; i < values.length; i += 1000) await tx`INSERT INTO allocations ${tx(values.slice(i, i + 1000))}`;
  }
}

export type { AllocRow };
export { RECORD_COLUMNS };
