/**
 * Cost center owners and deputies (review of wave 2): who decides a cost center's budget owner step. An admin person
 * maps an owner (a person here) and optional deputies; the newest mapping is in effect (append-only). Without one, the
 * cost center's own `owner_subject` (from its dimension row) names the owner when that is a person here; otherwise the
 * step falls back to the `Budget Owners` group, and the step says so.
 */
import type { CostCenterOwnersInput, CostCenterOwnersView, PersonRef, PersonView } from '@landledger/contracts';
import type { AuditLog } from './audit.js';
import type { Sql, Tx } from './db.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';
import { actorOf, type Principal } from './principal.js';

export interface OwnerUser {
  id: string;
  name: string;
  email: string | null;
  subject: string;
  kind: string;
  active: boolean;
}

export const personViewOf = (u: OwnerUser): PersonView => ({
  id: u.id,
  name: u.name,
  email: u.email,
  sub: u.kind === 'person' && !u.subject.startsWith('scim:') ? u.subject : null,
});

/**
 * Looks like a service account, not a person (review of wave 2): a generic `Administrator`, `admin@…`, `root`, a bot
 * or a no-reply address. Such accounts are never listed as approvers, and never decide.
 */
export function isServiceLike(u: { name: string; email: string | null }): boolean {
  const local = (u.email ?? '').split('@')[0]!.toLowerCase();
  if (/^(admin|administrator|root|system|service|svc|bot|noreply|no-reply)$/.test(local)) return true;
  if (/(^|[._-])(bot|svc|service)([._-]|$)/.test(local)) return true;
  return /^(administrator|admin|root|system|service account)$/i.test(u.name.trim());
}

export class CostCenterOwners {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
  ) {}

  /** The owner and deputies in effect for a cost center, with where the owner came from. */
  async of(
    code: string,
    tx: Tx = this.sql,
  ): Promise<{
    owner: OwnerUser | null;
    deputies: OwnerUser[];
    source: 'map' | 'dimension' | null;
    setBy: string | null;
    setAt: Date | null;
  }> {
    const [map] = await tx<{ id: string; owner_id: string; set_by: string; set_at: Date }[]>`
      SELECT id, owner_id, set_by, set_at FROM cost_center_owners WHERE cost_center = ${code}
      ORDER BY set_at DESC, id DESC LIMIT 1`;
    if (map) {
      const users = await tx<OwnerUser[]>`
        SELECT id, name, email, subject, kind, active AND deleted_at IS NULL AS active FROM users
        WHERE id = ${map.owner_id} OR id IN (SELECT user_id FROM cost_center_deputies WHERE owners_id = ${map.id})`;
      const owner = users.find((u) => u.id === map.owner_id) ?? null;
      return {
        owner,
        deputies: users.filter((u) => u.id !== map.owner_id).sort((a, b) => a.name.localeCompare(b.name)),
        source: 'map',
        setBy: map.set_by,
        setAt: map.set_at,
      };
    }
    const [u] = await tx<OwnerUser[]>`
      SELECT u.id, u.name, u.email, u.subject, u.kind, u.active AND u.deleted_at IS NULL AS active
      FROM (SELECT DISTINCT ON (code) owner_subject FROM cost_centers WHERE code = ${code} ORDER BY code, version DESC) c
      JOIN users u ON u.subject = c.owner_subject
      WHERE u.kind = 'person' LIMIT 1`;
    return { owner: u ?? null, deputies: [], source: u ? 'dimension' : null, setBy: null, setAt: null };
  }

  async view(code: string): Promise<CostCenterOwnersView> {
    const [cc] = await this.sql`SELECT 1 FROM cost_center_codes WHERE code = ${code}`;
    if (!cc) throw new ApiError('not_found', `No cost center ${code}`);
    const o = await this.of(code);
    return {
      costCenter: code,
      owner: o.owner ? personViewOf(o.owner) : null,
      deputies: o.deputies.map(personViewOf),
      setBy: o.setBy,
      setAt: o.setAt?.toISOString() ?? null,
    };
  }

  private async person(tx: Tx, ref: PersonRef, what: string): Promise<OwnerUser> {
    const [u] = await tx<OwnerUser[]>`
      SELECT id, name, email, subject, kind, active AND deleted_at IS NULL AS active FROM users
      WHERE kind = 'person' AND deleted_at IS NULL
        AND (${ref.sub ?? null}::text IS NOT NULL AND subject = ${ref.sub ?? null}
             OR ${ref.email ?? null}::text IS NOT NULL AND lower(email) = lower(${ref.email ?? null}))
      LIMIT 1`;
    if (!u) throw new ApiError('bad_request', `No person ${ref.email ?? ref.sub} is known to Landledger (${what})`);
    if (isServiceLike(u))
      throw new ApiError('bad_request', `${u.email ?? u.name} looks like a service account, not a person`);
    return u;
  }

  async set(code: string, input: CostCenterOwnersInput, by: Principal): Promise<CostCenterOwnersView> {
    if (by.kind !== 'person') throw new ApiError('forbidden', 'A signed-in admin person maps cost center owners');
    await this.sql.begin(async (tx) => {
      const [cc] = await tx`SELECT 1 FROM cost_center_codes WHERE code = ${code}`;
      if (!cc) throw new ApiError('not_found', `No cost center ${code}`);
      const owner = await this.person(tx, input.owner, 'owner');
      const deputies: OwnerUser[] = [];
      for (const d of input.deputies ?? []) {
        const u = await this.person(tx, d, 'deputy');
        if (u.id !== owner.id && !deputies.some((x) => x.id === u.id)) deputies.push(u);
      }
      const id = newId('cco');
      const actor = actorOf(by);
      await tx`
        INSERT INTO cost_center_owners (id, cost_center, owner_id, note, set_by)
        VALUES (${id}, ${code}, ${owner.id}, ${input.note ?? ''}, ${actor.actor})`;
      for (const d of deputies) await tx`INSERT INTO cost_center_deputies (owners_id, user_id) VALUES (${id}, ${d.id})`;
      await this.audit.append(
        {
          ...actor,
          action: 'cost_center.owners_set',
          subjectType: 'cost_center',
          subjectId: code,
          data: {
            owner: owner.email ?? owner.id,
            deputies: deputies.map((d) => d.email ?? d.id),
            note: input.note ?? '',
          },
        },
        tx,
      );
    });
    return this.view(code);
  }
}
