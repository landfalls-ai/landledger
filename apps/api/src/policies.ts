/**
 * Approval policies (spec 004, docs/approvals.md): per request kind and cost center, the automatic threshold and the
 * ordered steps with their approvers. A version is proposed by a person and put in effect by a `policy_change` request
 * (Finance, then the CFO); the decided defaults are written by migration 0010. The newest approved version for a kind
 * and cost center is in effect; a cost center's own policy wins over the one for every cost center.
 */
import {
  type PolicyDef,
  PolicyDef as PolicyDefSchema,
  type PolicyView,
  type RequestKind,
  SELF_APPLIED_KINDS,
} from '@landledger/contracts';
import type { Sql, Tx } from './db.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';

interface PolicyRow {
  id: string;
  kind: RequestKind;
  cost_center: string | null;
  version: number;
  definition: { automaticBelow: string | null; steps: PolicyDef['steps'] };
  note: string;
  origin: string;
  status: 'proposed' | 'approved' | 'rejected';
  proposed_by: string;
  proposed_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  proposer?: string | null;
  approver?: string | null;
  request_id?: string | null;
}

export interface PolicyInEffect {
  id: string;
  version: number;
  kind: RequestKind;
  costCenter: string | null;
  automaticBelow: string | null;
  steps: PolicyDef['steps'];
}

const inEffect = (r: PolicyRow): PolicyInEffect => ({
  id: r.id,
  version: r.version,
  kind: r.kind,
  costCenter: r.cost_center,
  automaticBelow: r.definition.automaticBelow ?? null,
  steps: r.definition.steps,
});

export class Policies {
  constructor(private readonly sql: Sql) {}

  async list(): Promise<PolicyView[]> {
    const rows = await this.sql<PolicyRow[]>`
      SELECT p.*, pu.email AS proposer, au.email AS approver,
             (SELECT r.id FROM requests r WHERE r.change->>'policyId' = p.id LIMIT 1) AS request_id
      FROM policies p LEFT JOIN users pu ON pu.id = p.proposed_by LEFT JOIN users au ON au.id = p.approved_by
      ORDER BY p.kind, p.cost_center NULLS FIRST, p.version DESC`;
    const current = new Set<string>();
    const seen = new Set<string>();
    for (const r of rows)
      if (r.status === 'approved' && !seen.has(`${r.kind}|${r.cost_center ?? ''}`)) {
        seen.add(`${r.kind}|${r.cost_center ?? ''}`);
        current.add(r.id);
      }
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      costCenter: r.cost_center,
      version: r.version,
      automaticBelow: r.definition.automaticBelow ?? null,
      steps: r.definition.steps,
      status: r.status,
      current: current.has(r.id),
      note: r.note,
      proposedBy: r.proposer ?? r.proposed_by,
      proposedAt: r.proposed_at.toISOString(),
      approvedBy: r.approver ?? r.approved_by,
      approvedAt: r.approved_at?.toISOString() ?? null,
      requestId: r.request_id ?? null,
    }));
  }

  /** The policy a request of this kind and cost center follows now. */
  async forRequest(kind: RequestKind, costCenter: string, tx: Tx = this.sql): Promise<PolicyInEffect> {
    const [row] = await tx<PolicyRow[]>`
      SELECT * FROM policies WHERE kind = ${kind} AND status = 'approved'
        AND (cost_center = ${costCenter} OR cost_center IS NULL)
      ORDER BY (cost_center IS NULL), version DESC LIMIT 1`;
    if (!row) throw new ApiError('conflict', `No policy is in effect for ${kind}`);
    return inEffect(row);
  }

  async byId(id: string, tx: Tx = this.sql): Promise<PolicyInEffect & { status: string }> {
    const [row] = await tx<PolicyRow[]>`SELECT * FROM policies WHERE id = ${id}`;
    if (!row) throw new ApiError('not_found', `Policy ${id} not found`);
    return { ...inEffect(row), status: row.status };
  }

  /** Checks a definition beyond its schema: self-applied kinds are never automatic, and every step has approvers. */
  validate(def: PolicyDef): PolicyDef {
    const d = PolicyDefSchema.parse(def);
    if (SELF_APPLIED_KINDS.includes(d.kind) && d.automaticBelow !== null)
      throw new ApiError('bad_request', `A ${d.kind} request is never automatic: a person approves every change`);
    const keys = new Set<string>();
    for (const s of d.steps) {
      if (keys.has(s.key)) throw new ApiError('bad_request', `Step ${s.key} appears twice`);
      keys.add(s.key);
      if (!s.approvers.groups.length && !s.approvers.costCenterOwner)
        throw new ApiError('bad_request', `Step ${s.key} names no approvers (groups or the cost center owner)`);
      if (!s.when.always && !s.when.amountAtLeast && !s.when.amountAbove && !s.when.costCenterAtRisk)
        throw new ApiError('bad_request', `Step ${s.key} says nothing about when it applies`);
    }
    return d;
  }

  /** A new version, proposed: in effect once its request is approved. */
  async proposeIn(tx: Tx, def: PolicyDef, note: string, proposerId: string): Promise<{ id: string; version: number }> {
    if (def.costCenter) {
      const [cc] = await tx`SELECT 1 FROM cost_center_codes WHERE code = ${def.costCenter}`;
      if (!cc) throw new ApiError('bad_request', `No cost center ${def.costCenter}`);
    }
    const [{ next }] = (await tx`
      SELECT coalesce(max(version), 0) + 1 AS next FROM policies
      WHERE kind = ${def.kind} AND coalesce(cost_center, '') = ${def.costCenter ?? ''}`) as unknown as [
      { next: number },
    ];
    const id = newId('pol');
    await tx`
      INSERT INTO policies (id, kind, cost_center, version, definition, note, proposed_by)
      VALUES (${id}, ${def.kind}, ${def.costCenter}, ${next},
              ${tx.json({ automaticBelow: def.automaticBelow, steps: def.steps } as never)}, ${note}, ${proposerId})`;
    return { id, version: Number(next) };
  }

  async approveIn(tx: Tx, id: string, approverId: string) {
    await tx`UPDATE policies SET status = 'approved', approved_by = ${approverId}, approved_at = now() WHERE id = ${id}`;
  }

  async rejectIn(tx: Tx, id: string) {
    await tx`UPDATE policies SET status = 'rejected' WHERE id = ${id} AND status = 'proposed'`;
  }
}
