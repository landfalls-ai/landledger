/**
 * The access review (spec 011, review of wave 2). Once a quarter an admin person opens the quarter's review: a snapshot
 * of who holds what (people with roles, keys and their scopes, Slack links, relay channels, cost center owners and
 * deputies). The controller or the CFO attests each item, keep or revoke, never one about themselves; attestations
 * append only and are audited; the last one completes the review. `access_review.due` goes out once a quarter, from
 * its first day, while the quarter has no completed review.
 */
import type { AccessItemKind, AccessItemView, AccessReviewView, AttestInput } from '@landledger/contracts';
import type { z } from 'zod';
import type { AuditLog } from './audit.js';
import type { Sql, Tx } from './db.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';
import type { CostCenterOwners } from './owners.js';
import { actorOf, type Principal } from './principal.js';
import type { Webhooks } from './webhooks.js';

/** `2026-Q4` for a day in October to December. */
export function quarterOf(d: Date): string {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** An item as it is snapshotted: who it is about (they never attest it), and what it grants, in words. */
export interface ItemDraft {
  kind: AccessItemKind;
  subjectId: string;
  label: string;
  detail: string;
  about: string[];
  snapshot: Record<string, unknown>;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Who may attest: a signed-in person who is the controller or the CFO (an auditor reads, never attests). */
export function canAttest(p: Principal): boolean {
  return p.kind === 'person' && p.roles.some((r) => r === 'controller' || r === 'cfo');
}

interface ItemRow {
  id: string;
  kind: AccessItemKind;
  subject_id: string;
  label: string;
  detail: string;
  about: string[];
  snapshot: Record<string, unknown>;
  decision: 'keep' | 'revoke' | null;
  comment: string | null;
  by_name: string | null;
  at: Date | null;
}

export class AccessReviews {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly owners: CostCenterOwners,
    private readonly options: { consoleUrl: string },
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Every item the review covers, as it stands now. */
  async snapshot(tx: Tx = this.sql): Promise<ItemDraft[]> {
    const out: ItemDraft[] = [];
    const people = await tx<
      {
        id: string;
        name: string;
        email: string | null;
        roles: string[];
        groups: string[];
        last_seen_at: Date;
        scim_managed: boolean;
      }[]
    >`
      SELECT id, name, email, roles, groups, last_seen_at, scim_managed FROM users
      WHERE kind = 'person' AND active AND cardinality(roles) > 0 ORDER BY name`;
    for (const p of people)
      out.push({
        kind: 'person',
        subjectId: p.id,
        label: p.name,
        detail: `${p.roles.join(', ')} · from ${p.groups.length ? p.groups.join(', ') : 'no group'}`,
        about: [p.id],
        snapshot: {
          email: p.email,
          roles: p.roles,
          groups: p.groups,
          lastSeen: day(p.last_seen_at),
          scimManaged: p.scim_managed,
        },
      });
    const keys = await tx<
      {
        id: string;
        name: string;
        prefix: string;
        scopes: string[];
        bound_workflow_ids: string[];
        created_by: string;
        created_by_user: string | null;
        created_at: Date;
        last_used_at: Date | null;
      }[]
    >`
      SELECT id, name, prefix, scopes, bound_workflow_ids, created_by, created_by_user, created_at, last_used_at
      FROM api_keys WHERE revoked_at IS NULL ORDER BY name`;
    for (const k of keys)
      out.push({
        kind: 'key',
        subjectId: k.id,
        label: k.name,
        detail: `${k.scopes.join(', ')}${k.bound_workflow_ids.length ? ` · bound to ${k.bound_workflow_ids.length} workflow(s)` : ''} · last used ${day(k.last_used_at) ?? 'never'}`,
        about: k.created_by_user ? [k.created_by_user] : [],
        snapshot: {
          prefix: k.prefix,
          scopes: k.scopes,
          boundWorkflowIds: k.bound_workflow_ids,
          createdBy: k.created_by,
          createdAt: day(k.created_at),
          lastUsed: day(k.last_used_at),
        },
      });
    const links = await tx<
      { id: string; kind: string; external_id: string; user_id: string; name: string; created_at: Date }[]
    >`
      SELECT l.id, l.kind, l.external_id, l.user_id, u.name, l.created_at
      FROM person_links l JOIN users u ON u.id = l.user_id
      WHERE l.removed_at IS NULL ORDER BY u.name, l.kind`;
    for (const l of links)
      out.push({
        kind: 'link',
        subjectId: l.id,
        label: `${l.name} · ${l.kind}`,
        detail: `${l.kind} ${l.external_id}: decisions relayed from it count as ${l.name}'s`,
        about: [l.user_id],
        snapshot: { kind: l.kind, externalId: l.external_id, person: l.name, linkedAt: day(l.created_at) },
      });
    const channels = await tx<
      {
        id: string;
        kind: string;
        name: string;
        config: Record<string, unknown>;
        created_by: string;
        creator: string | null;
        created_at: Date;
      }[]
    >`
      SELECT c.id, c.kind, c.name, c.config, c.created_by, u.id AS creator, c.created_at
      FROM relay_channels c LEFT JOIN users u ON u.email = c.created_by AND u.kind = 'person'
      WHERE c.disabled_at IS NULL ORDER BY c.name`;
    for (const c of channels)
      out.push({
        kind: 'relay_channel',
        subjectId: c.id,
        label: c.name,
        detail: `${c.kind}${c.config.teamId ? ` team ${String(c.config.teamId)}` : ''}${c.config.appId ? `, app ${String(c.config.appId)}` : ''}: relays decisions into Landledger`,
        about: c.creator ? [c.creator] : [],
        snapshot: { kind: c.kind, config: c.config, createdBy: c.created_by, createdAt: day(c.created_at) },
      });
    // Cost center owners and deputies: the owners map (wave 2), or the cost center's own owner when it names a person.
    const codes = await tx<{ code: string }[]>`SELECT code FROM cost_center_codes ORDER BY code`;
    for (const { code } of codes) {
      const o = await this.owners.of(code, tx);
      if (!o.owner) continue;
      out.push({
        kind: 'owner',
        subjectId: code,
        label: code,
        detail: `owner ${o.owner.name}${o.deputies.length ? `, deputies ${o.deputies.map((d) => d.name).join(', ')}` : ''}${o.source === 'dimension' ? ' (from the cost center)' : ''}: decides its requests`,
        about: [o.owner.id, ...o.deputies.map((d) => d.id)],
        snapshot: {
          owner: o.owner.name,
          deputies: o.deputies.map((d) => d.name),
          source: o.source,
          setBy: o.setBy,
          setAt: day(o.setAt),
        },
      });
    }
    return out;
  }

  // Reading -----------------------------------------------------------------------------------------------------------

  private async viewIn(tx: Tx, id: string): Promise<AccessReviewView> {
    const [r] = await tx<
      { id: string; quarter: string; opened_by: string; opened_at: Date; completed_at: Date | null }[]
    >`
      SELECT a.id, a.quarter, coalesce(u.name, a.opened_by) AS opened_by, a.opened_at, a.completed_at
      FROM access_reviews a LEFT JOIN users u ON u.id = a.opened_by WHERE a.id = ${id}`;
    if (!r) throw new ApiError('not_found', `Access review ${id} not found`);
    const rows = await tx<ItemRow[]>`
      SELECT i.id, i.kind, i.subject_id, i.label, i.detail, i.about, i.snapshot,
             t.decision, t.comment, coalesce(u.name, t.by_user) AS by_name, t.at
      FROM access_review_items i
      LEFT JOIN access_review_attestations t ON t.item_id = i.id
      LEFT JOIN users u ON u.id = t.by_user
      WHERE i.review_id = ${id}
      ORDER BY array_position(ARRAY['person','key','link','relay_channel','owner'], i.kind), i.label`;
    const items: AccessItemView[] = rows.map((i) => ({
      id: i.id,
      kind: i.kind,
      subjectId: i.subject_id,
      label: i.label,
      detail: i.detail,
      snapshot: i.snapshot,
      about: i.about,
      attestation:
        i.decision && i.at
          ? { decision: i.decision, comment: i.comment ?? '', by: i.by_name ?? '', at: i.at.toISOString() }
          : null,
    }));
    return {
      id: r.id,
      quarter: r.quarter,
      status: r.completed_at ? 'completed' : 'open',
      openedBy: r.opened_by,
      openedAt: r.opened_at.toISOString(),
      completedAt: r.completed_at?.toISOString() ?? null,
      items,
      counts: {
        total: items.length,
        attested: items.filter((i) => i.attestation).length,
        revoke: items.filter((i) => i.attestation?.decision === 'revoke').length,
      },
    };
  }

  view(id: string): Promise<AccessReviewView> {
    return this.viewIn(this.sql, id);
  }

  /** Every review, newest quarter first, and what is due now. */
  async list(): Promise<{ quarter: string; due: boolean; reviews: Omit<AccessReviewView, 'items'>[] }> {
    const ids = await this.sql<{ id: string }[]>`SELECT id FROM access_reviews ORDER BY quarter DESC`;
    const reviews = await Promise.all(ids.map(async ({ id }) => this.viewIn(this.sql, id)));
    const quarter = quarterOf(this.now());
    return {
      quarter,
      due: !reviews.some((r) => r.quarter === quarter && r.status === 'completed'),
      reviews: reviews.map(({ items: _items, ...rest }) => rest),
    };
  }

  // Opening and attesting ---------------------------------------------------------------------------------------------

  /** Opens this quarter's review with every item's snapshot (an admin person; one per quarter, 409 after). */
  async open(by: Principal): Promise<AccessReviewView> {
    if (by.kind !== 'person') throw new ApiError('forbidden', 'An access review is opened by a person, never a key');
    if (!canAttest(by)) throw new ApiError('forbidden', 'The access review is for the controller or the CFO');
    const quarter = quarterOf(this.now());
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('landledger:access_review'))`;
      const [existing] = await tx<{ id: string }[]>`SELECT id FROM access_reviews WHERE quarter = ${quarter}`;
      if (existing)
        throw new ApiError('conflict', `The ${quarter} access review is open already`, { reviewId: existing.id });
      const id = newId('arv');
      await tx`INSERT INTO access_reviews (id, quarter, opened_by, opened_at) VALUES (${id}, ${quarter}, ${by.id}, ${this.now()})`;
      const items = await this.snapshot(tx);
      for (const i of items)
        await tx`
          INSERT INTO access_review_items (id, review_id, kind, subject_id, label, detail, about, snapshot)
          VALUES (${newId('ari')}, ${id}, ${i.kind}, ${i.subjectId}, ${i.label}, ${i.detail}, ${i.about},
                  ${tx.json(i.snapshot as never)})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'access_review.opened',
          subjectType: 'access_review',
          subjectId: id,
          data: {
            quarter,
            items: items.length,
            byKind: Object.fromEntries(
              ['person', 'key', 'link', 'relay_channel', 'owner'].map((k) => [
                k,
                items.filter((i) => i.kind === k).length,
              ]),
            ),
          },
        },
        tx,
      );
      if (!items.length) await this.completeIn(tx, id, by);
      return this.viewIn(tx, id);
    });
  }

  /** Keep or revoke one item (the controller or the CFO, never an item about themselves); the last completes it. */
  async attest(
    reviewId: string,
    itemId: string,
    input: z.output<typeof AttestInput>,
    by: Principal,
  ): Promise<AccessReviewView> {
    if (by.kind !== 'person') throw new ApiError('forbidden', 'An attestation is a person’s, never a key’s');
    if (!canAttest(by)) throw new ApiError('forbidden', 'Attesting is for the controller or the CFO');
    return this.sql.begin(async (tx) => {
      const [item] = await tx<
        { id: string; kind: string; label: string; about: string[]; completed_at: Date | null }[]
      >`
        SELECT i.id, i.kind, i.label, i.about, a.completed_at
        FROM access_review_items i JOIN access_reviews a ON a.id = i.review_id
        WHERE i.id = ${itemId} AND i.review_id = ${reviewId}
        FOR UPDATE OF a`;
      if (!item) throw new ApiError('not_found', `Item ${itemId} is not in access review ${reviewId}`);
      if (item.completed_at) throw new ApiError('conflict', 'This access review is complete');
      if (item.about.includes(by.id))
        throw new ApiError('forbidden', 'Nobody attests their own access: another controller or the CFO does');
      const rows = await tx`
        INSERT INTO access_review_attestations (item_id, decision, comment, by_user, at)
        VALUES (${itemId}, ${input.decision}, ${input.comment}, ${by.id}, ${this.now()})
        ON CONFLICT (item_id) DO NOTHING RETURNING 1`;
      if (!rows.length) throw new ApiError('conflict', 'This item is attested already');
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'access_review.attested',
          subjectType: 'access_review',
          subjectId: reviewId,
          data: { itemId, kind: item.kind, label: item.label, decision: input.decision, comment: input.comment },
        },
        tx,
      );
      const [left] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM access_review_items i
        WHERE i.review_id = ${reviewId}
          AND NOT EXISTS (SELECT 1 FROM access_review_attestations t WHERE t.item_id = i.id)`;
      if (left!.n === 0) await this.completeIn(tx, reviewId, by);
      return this.viewIn(tx, reviewId);
    });
  }

  private async completeIn(tx: Tx, id: string, by: Principal) {
    await tx`UPDATE access_reviews SET completed_at = ${this.now()} WHERE id = ${id}`;
    const [c] = await tx<{ total: number; revoke: number }[]>`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE t.decision = 'revoke')::int AS revoke
      FROM access_review_items i LEFT JOIN access_review_attestations t ON t.item_id = i.id
      WHERE i.review_id = ${id}`;
    await this.audit.append(
      {
        ...actorOf(by),
        action: 'access_review.completed',
        subjectType: 'access_review',
        subjectId: id,
        data: { items: c!.total, revoke: c!.revoke },
      },
      tx,
    );
  }

  // The quarterly notice ----------------------------------------------------------------------------------------------

  /** The job: `access_review.due` once a quarter while its review is not complete. Returns whether it sent one. */
  async dueNotice(): Promise<boolean> {
    const quarter = quarterOf(this.now());
    return this.sql.begin(async (tx) => {
      const [r] = await tx<{ id: string; completed_at: Date | null }[]>`
        SELECT id, completed_at FROM access_reviews WHERE quarter = ${quarter}`;
      if (r?.completed_at) return false;
      const rows = await tx`
        INSERT INTO access_review_notices (quarter, sent_at) VALUES (${quarter}, ${this.now()})
        ON CONFLICT DO NOTHING RETURNING 1`;
      if (!rows.length) return false;
      const url = `${this.options.consoleUrl}/access-review${r ? `?id=${r.id}` : ''}`;
      await this.webhooks.enqueue(tx, 'access_review.due', { quarter, reviewId: r?.id ?? null, url });
      await this.audit.append(
        {
          actor: 'access review',
          actorKind: 'system',
          action: 'access_review.due',
          subjectType: 'access_review',
          subjectId: r?.id ?? quarter,
          data: { quarter },
        },
        tx,
      );
      return true;
    });
  }
}
