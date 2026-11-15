/**
 * The access review (spec 011, reviews of waves 2 and 3). Once a quarter the controller or the CFO opens the quarter's
 * review: a snapshot of who holds what (people with roles, keys and their scopes, Slack links, relay channels, cost
 * center owners and deputies, webhook subscriptions, and each person's signed-in sessions). Anything granted after it
 * opened joins it (`addedAt`), so nothing goes unreviewed. The controller or the CFO attests each item, keep or revoke,
 * never one about themselves (as snapshotted, and as it stands now: a deputy named since never attests that cost
 * center); a key nobody in Landledger stands behind (a system minted it) is the CFO's alone. A revoke of a key, a Slack
 * link or a person's sessions takes effect at once when the attester confirms; every other revoke is tracked until the
 * access is gone, and the review completes only when every item is attested and no revoke is outstanding.
 * `access_review.due` goes out from the quarter's first day, again each week as a reminder while the review is not
 * complete, and `access_review.missed` once when a quarter ends without one (recorded in `access_review_events`).
 */
import type { AccessItemKind, AccessItemView, AccessReviewView, AttestInput } from '@landledger/contracts';
import { localParts } from './business-hours.js';
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
  /** Only the CFO attests it: nobody in Landledger stands behind it. */
  cfoOnly?: boolean;
}

const KINDS: AccessItemKind[] = ['person', 'key', 'link', 'relay_channel', 'owner', 'webhook', 'session'];
/** What Landledger revokes itself when the attester confirms. */
const REVOKED_AT_ONCE: readonly AccessItemKind[] = ['key', 'link', 'session'];

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
  added_at: Date | null;
  cfo_only: boolean;
  decision: 'keep' | 'revoke' | null;
  comment: string | null;
  by_name: string | null;
  at: Date | null;
  how: string | null;
  revoked_by: string | null;
  revoked_at: Date | null;
}

export class AccessReviews {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly owners: CostCenterOwners,
    private readonly options: { consoleUrl: string; timeZone?: string },
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
        cfoOnly: !k.created_by_user,
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
      SELECT c.id, c.kind, c.name, c.config, c.created_by, c.created_by_user AS creator, c.created_at
      FROM relay_channels c WHERE c.disabled_at IS NULL ORDER BY c.name`;
    for (const c of channels)
      out.push({
        kind: 'relay_channel',
        subjectId: c.id,
        label: c.name,
        detail: `${c.kind}${c.config.teamId ? ` team ${String(c.config.teamId)}` : ''}${c.config.appId ? `, app ${String(c.config.appId)}` : ''}: relays decisions into Landledger`,
        about: c.creator ? [c.creator] : [],
        cfoOnly: !c.creator,
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
    // Webhook subscriptions: where Landledger sends its events (and the evidence links in them).
    const hooks = await tx<
      { id: string; url: string; events: string[]; created_by: string; creator: string | null; created_at: Date }[]
    >`
      SELECT w.id, w.url, w.events, w.created_by, u.id AS creator, w.created_at
      FROM webhooks w LEFT JOIN users u ON (u.email = w.created_by OR u.id = w.created_by) AND u.kind = 'person'
      WHERE w.disabled_at IS NULL ORDER BY w.url`;
    for (const w of hooks)
      out.push({
        kind: 'webhook',
        subjectId: w.id,
        label: new URL(w.url).host,
        detail: `${w.url} · ${w.events.length} event(s): ${w.events.slice(0, 4).join(', ')}${w.events.length > 4 ? ', …' : ''}`,
        about: w.creator ? [w.creator] : [],
        cfoOnly: !w.creator,
        snapshot: { url: w.url, events: w.events, createdBy: w.created_by, createdAt: day(w.created_at) },
      });
    // Sessions: one item per person signed in now (their sessions end together when revoked).
    const sessions = await tx<{ user_id: string; name: string; n: number; first: Date; last: Date }[]>`
      SELECT s.user_id, u.name, count(*)::int AS n, min(s.created_at) AS first, max(s.last_seen_at) AS last
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.revoked_at IS NULL AND s.expires_at > ${this.now()}
      GROUP BY s.user_id, u.name ORDER BY u.name`;
    for (const x of sessions)
      out.push({
        kind: 'session',
        subjectId: x.user_id,
        label: `${x.name} · signed in`,
        detail: `${x.n} session(s) in the console, since ${day(x.first)}, last seen ${day(x.last)}`,
        about: [x.user_id],
        snapshot: { sessions: x.n, since: day(x.first), lastSeen: day(x.last) },
      });
    return out;
  }

  /** Who an item is about now (beyond its snapshot): a cost center's owner and deputies today, a key's minter. */
  private async aboutNow(tx: Tx, kind: string, subjectId: string): Promise<string[]> {
    if (kind === 'owner') {
      // An owner item joined after a change is `CODE@time`: the cost center is the part before the @.
      const o = await this.owners.of(subjectId.split('@')[0]!, tx);
      return o.owner ? [o.owner.id, ...o.deputies.map((d) => d.id)] : [];
    }
    if (kind === 'key') {
      const [k] = await tx<{ created_by_user: string | null }[]>`
        SELECT created_by_user FROM api_keys WHERE id = ${subjectId}`;
      return k?.created_by_user ? [k.created_by_user] : [];
    }
    if (kind === 'relay_channel') {
      const [c] = await tx<{ created_by_user: string | null }[]>`
        SELECT created_by_user FROM relay_channels WHERE id = ${subjectId}`;
      return c?.created_by_user ? [c.created_by_user] : [];
    }
    if (kind === 'link') {
      const [l] = await tx<{ user_id: string }[]>`SELECT user_id FROM person_links WHERE id = ${subjectId}`;
      return l ? [l.user_id] : [];
    }
    if (kind === 'person' || kind === 'session') return [subjectId];
    return [];
  }

  /** Whether the access a revoke named is still there. */
  private async stillThere(tx: Tx, i: Pick<ItemRow, 'kind' | 'subject_id' | 'about' | 'snapshot'>, since: Date) {
    const one = async (q: PromiseLike<{ length: number }>) => (await q).length > 0;
    switch (i.kind) {
      case 'person':
        return one(tx`SELECT 1 FROM users WHERE id = ${i.subject_id} AND active AND cardinality(roles) > 0`);
      case 'key':
        return one(tx`SELECT 1 FROM api_keys WHERE id = ${i.subject_id} AND revoked_at IS NULL`);
      case 'link':
        return one(tx`SELECT 1 FROM person_links WHERE id = ${i.subject_id} AND removed_at IS NULL`);
      case 'relay_channel':
        return one(tx`SELECT 1 FROM relay_channels WHERE id = ${i.subject_id} AND disabled_at IS NULL`);
      case 'webhook':
        return one(tx`SELECT 1 FROM webhooks WHERE id = ${i.subject_id} AND disabled_at IS NULL`);
      case 'session':
        return one(tx`
          SELECT 1 FROM sessions WHERE user_id = ${i.subject_id} AND revoked_at IS NULL AND expires_at > ${this.now()}
            AND created_at <= ${since}`);
      case 'owner': {
        // Acted on once anyone the item named no longer owns or deputises the cost center.
        const now = await this.aboutNow(tx, 'owner', i.subject_id);
        return i.about.every((p) => now.includes(p));
      }
      default:
        return false;
    }
  }

  /**
   * Items granted since the review opened join it (`added_at`): a key minted, a link made, a deputy named, a webhook,
   * a person who signed in. Never on a completed review. Returns how many joined.
   */
  async sync(tx: Tx, reviewId: string): Promise<number> {
    const [r] = await tx<{ completed_at: Date | null }[]>`
      SELECT completed_at FROM access_reviews WHERE id = ${reviewId} FOR UPDATE`;
    if (!r || r.completed_at) return 0;
    // Oldest first, so a cost center's latest owners (`CODE@time`, below) are the ones compared.
    const have = await tx<{ kind: string; subject_id: string; about: string[] }[]>`
      SELECT kind, subject_id, about FROM access_review_items WHERE review_id = ${reviewId}
      ORDER BY added_at NULLS FIRST, id`;
    const seen = new Map(
      have.map((h) => [`${h.kind}|${h.kind === 'owner' ? h.subject_id.split('@')[0] : h.subject_id}`, h.about]),
    );
    const added: ItemDraft[] = [];
    for (const i of await this.snapshot(tx)) {
      const before = seen.get(`${i.kind}|${i.subjectId}`);
      // A cost center whose owners changed is a new grant: it joins again under its new owners.
      const changedOwners = i.kind === 'owner' && before && i.about.some((p) => !before.includes(p));
      if (before && !changedOwners) continue;
      added.push(changedOwners ? { ...i, subjectId: `${i.subjectId}@${this.now().toISOString()}` } : i);
    }
    for (const i of added)
      await tx`
        INSERT INTO access_review_items (id, review_id, kind, subject_id, label, detail, about, snapshot, added_at, cfo_only)
        VALUES (${newId('ari')}, ${reviewId}, ${i.kind}, ${i.subjectId}, ${i.label}, ${i.detail}, ${i.about},
                ${tx.json(i.snapshot as never)}, ${this.now()}, ${!!i.cfoOnly})`;
    if (added.length)
      await this.audit.append(
        {
          actor: 'access review',
          actorKind: 'system',
          action: 'access_review.items_added',
          subjectType: 'access_review',
          subjectId: reviewId,
          data: {
            items: added.length,
            byKind: Object.fromEntries(KINDS.map((k) => [k, added.filter((i) => i.kind === k).length])),
          },
        },
        tx,
      );
    return added.length;
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
      SELECT i.id, i.kind, i.subject_id, i.label, i.detail, i.about, i.snapshot, i.added_at, i.cfo_only,
             t.decision, t.comment, coalesce(u.name, t.by_user) AS by_name, t.at,
             v.how, coalesce(w.name, v.by_user) AS revoked_by, v.at AS revoked_at
      FROM access_review_items i
      LEFT JOIN access_review_attestations t ON t.item_id = i.id
      LEFT JOIN users u ON u.id = t.by_user
      LEFT JOIN access_review_revocations v ON v.item_id = i.id
      LEFT JOIN users w ON w.id = v.by_user
      WHERE i.review_id = ${id}
      ORDER BY array_position(${KINDS}::text[], i.kind), i.label, i.added_at NULLS FIRST`;
    const items: AccessItemView[] = [];
    for (const i of rows) {
      const live = await this.aboutNow(tx, i.kind, i.subject_id.split('@')[0]!);
      const about = [...new Set([...i.about, ...live])];
      const outstanding =
        i.decision === 'revoke' && i.at
          ? await this.stillThere(tx, { ...i, subject_id: i.subject_id.split('@')[0]! }, i.at)
          : false;
      items.push({
        id: i.id,
        kind: i.kind,
        subjectId: i.subject_id,
        label: i.label,
        detail: i.detail,
        snapshot: i.snapshot,
        about,
        addedAt: i.added_at?.toISOString() ?? null,
        cfoOnly:
          i.cfo_only ||
          ((i.kind === 'key' || i.kind === 'relay_channel' || i.kind === 'webhook') && about.length === 0),
        attestation:
          i.decision && i.at
            ? { decision: i.decision, comment: i.comment ?? '', by: i.by_name ?? '', at: i.at.toISOString() }
            : null,
        revocation:
          i.how && i.revoked_at ? { how: i.how, by: i.revoked_by ?? '', at: i.revoked_at.toISOString() } : null,
        outstanding,
      });
    }
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
        outstanding: items.filter((i) => i.outstanding).length,
        added: items.filter((i) => i.addedAt).length,
      },
    };
  }

  /** A review as it stands: an open one first takes in anything granted since, and completes if it can. */
  async view(id: string): Promise<AccessReviewView> {
    return this.sql.begin(async (tx) => {
      await this.sync(tx, id);
      await this.completeIfDone(tx, id, null);
      return this.viewIn(tx, id);
    }) as Promise<AccessReviewView>;
  }

  /** Every review, newest quarter first, and what is due now. */
  async list(): Promise<{
    quarter: string;
    due: boolean;
    missed: string[];
    reviews: Omit<AccessReviewView, 'items'>[];
  }> {
    const ids = await this.sql<{ id: string }[]>`SELECT id FROM access_reviews ORDER BY quarter DESC`;
    const reviews = await Promise.all(ids.map(async ({ id }) => this.viewIn(this.sql, id)));
    const quarter = quarterOf(this.now());
    const missed = await this.sql<{ quarter: string }[]>`
      SELECT DISTINCT quarter FROM access_review_events WHERE kind = 'missed' ORDER BY quarter DESC`;
    return {
      quarter,
      due: !reviews.some((r) => r.quarter === quarter && r.status === 'completed'),
      missed: missed.map((m) => m.quarter),
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
          INSERT INTO access_review_items (id, review_id, kind, subject_id, label, detail, about, snapshot, cfo_only)
          VALUES (${newId('ari')}, ${id}, ${i.kind}, ${i.subjectId}, ${i.label}, ${i.detail}, ${i.about},
                  ${tx.json(i.snapshot as never)}, ${!!i.cfoOnly})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'access_review.opened',
          subjectType: 'access_review',
          subjectId: id,
          data: {
            quarter,
            items: items.length,
            byKind: Object.fromEntries(KINDS.map((k) => [k, items.filter((i) => i.kind === k).length])),
          },
        },
        tx,
      );
      if (!items.length) await this.completeIfDone(tx, id, by);
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
      await this.sync(tx, reviewId);
      const [item] = await tx<
        {
          id: string;
          kind: AccessItemKind;
          subject_id: string;
          label: string;
          about: string[];
          cfo_only: boolean;
          completed_at: Date | null;
        }[]
      >`
        SELECT i.id, i.kind, i.subject_id, i.label, i.about, i.cfo_only, a.completed_at
        FROM access_review_items i JOIN access_reviews a ON a.id = i.review_id
        WHERE i.id = ${itemId} AND i.review_id = ${reviewId}
        FOR UPDATE OF a`;
      if (!item) throw new ApiError('not_found', `Item ${itemId} is not in access review ${reviewId}`);
      if (item.completed_at) throw new ApiError('conflict', 'This access review is complete');
      const subject = item.subject_id.split('@')[0]!;
      const about = [...new Set([...item.about, ...(await this.aboutNow(tx, item.kind, subject))])];
      if (about.includes(by.id))
        throw new ApiError('forbidden', 'Nobody attests their own access: another controller or the CFO does');
      const cfoOnly =
        item.cfo_only ||
        ((item.kind === 'key' || item.kind === 'relay_channel' || item.kind === 'webhook') && !about.length);
      if (cfoOnly && !by.roles.includes('cfo'))
        throw new ApiError(
          'forbidden',
          'Nobody in Landledger stands behind this one (a system made it): the CFO attests it',
        );
      const atOnce = input.decision === 'revoke' && REVOKED_AT_ONCE.includes(item.kind);
      if (atOnce && !input.confirm)
        throw new ApiError(
          'bad_request',
          `Revoking this ${item.kind === 'session' ? 'person’s sessions' : item.kind} ends it now: confirm (confirm: true)`,
        );
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
      if (atOnce) await this.revokeNow(tx, reviewId, { ...item, subject_id: subject }, input.comment, by);
      await this.completeIfDone(tx, reviewId, by);
      return this.viewIn(tx, reviewId);
    });
  }

  /** A confirmed revoke of a key, a link or a person's sessions: done here, now, and recorded with the item. */
  private async revokeNow(
    tx: Tx,
    reviewId: string,
    item: { id: string; kind: AccessItemKind; subject_id: string; label: string },
    reason: string,
    by: Principal,
  ) {
    const now = this.now();
    let how = '';
    if (item.kind === 'key') {
      const k =
        await tx`UPDATE api_keys SET revoked_at = ${now} WHERE id = ${item.subject_id} AND revoked_at IS NULL RETURNING 1`;
      how = k.length ? 'key revoked' : 'key was revoked already';
      if (k.length)
        await this.audit.append(
          {
            ...actorOf(by),
            action: 'api_key.revoked',
            subjectType: 'api_key',
            subjectId: item.subject_id,
            data: { via: 'access_review', reviewId, reason },
          },
          tx,
        );
    } else if (item.kind === 'link') {
      const l =
        await tx`UPDATE person_links SET removed_at = ${now} WHERE id = ${item.subject_id} AND removed_at IS NULL RETURNING 1`;
      how = l.length ? 'link removed' : 'link was removed already';
      if (l.length)
        await this.audit.append(
          {
            ...actorOf(by),
            action: 'person_link.removed',
            subjectType: 'person_link',
            subjectId: item.subject_id,
            data: { via: 'access_review', reviewId, reason },
          },
          tx,
        );
    } else if (item.kind === 'session') {
      const s = await tx`
        UPDATE sessions SET revoked_at = ${now} WHERE user_id = ${item.subject_id} AND revoked_at IS NULL RETURNING 1`;
      how = `${s.length} session(s) ended`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'auth.sessions_ended',
          subjectType: 'user',
          subjectId: item.subject_id,
          data: { via: 'access_review', reviewId, sessions: s.length, reason },
        },
        tx,
      );
    }
    await tx`
      INSERT INTO access_review_revocations (item_id, how, by_user, at) VALUES (${item.id}, ${how}, ${by.id}, ${now})`;
  }

  /** Completes the review once every item is attested and no revoke is outstanding. Returns whether it did. */
  private async completeIfDone(tx: Tx, id: string, by: Principal | null): Promise<boolean> {
    const [r] = await tx<{ completed_at: Date | null }[]>`SELECT completed_at FROM access_reviews WHERE id = ${id}`;
    if (!r || r.completed_at) return false;
    const [left] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM access_review_items i
      WHERE i.review_id = ${id} AND NOT EXISTS (SELECT 1 FROM access_review_attestations t WHERE t.item_id = i.id)`;
    if (left!.n > 0) return false;
    const revokes = await tx<Pick<ItemRow, 'kind' | 'subject_id' | 'about' | 'snapshot'> & { at: Date }[]>`
      SELECT i.kind, i.subject_id, i.about, i.snapshot, t.at FROM access_review_items i
      JOIN access_review_attestations t ON t.item_id = i.id WHERE i.review_id = ${id} AND t.decision = 'revoke'`;
    for (const v of revokes as unknown as (Pick<ItemRow, 'kind' | 'subject_id' | 'about' | 'snapshot'> & {
      at: Date;
    })[])
      if (await this.stillThere(tx, { ...v, subject_id: v.subject_id.split('@')[0]! }, v.at)) return false;
    await this.completeIn(tx, id, by);
    return true;
  }

  private async completeIn(tx: Tx, id: string, by: Principal | null) {
    await tx`UPDATE access_reviews SET completed_at = ${this.now()} WHERE id = ${id}`;
    const [c] = await tx<{ total: number; revoke: number }[]>`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE t.decision = 'revoke')::int AS revoke
      FROM access_review_items i LEFT JOIN access_review_attestations t ON t.item_id = i.id
      WHERE i.review_id = ${id}`;
    await this.audit.append(
      {
        ...(by ? actorOf(by) : { actor: 'access review', actorKind: 'system' as const }),
        action: 'access_review.completed',
        subjectType: 'access_review',
        subjectId: id,
        data: { items: c!.total, revoke: c!.revoke },
      },
      tx,
    );
  }

  // The quarterly notice ----------------------------------------------------------------------------------------------

  /**
   * The job, every hour: an open review takes in what was granted since and completes when it can; `access_review.due`
   * once a quarter from its first day, and again each week (a reminder) while its review is not complete; and
   * `access_review.missed` once for a quarter that ended without a completed review. Returns whether it sent anything.
   */
  async dueNotice(): Promise<boolean> {
    const now = this.now();
    const quarter = quarterOf(now);
    let sent = false;
    // The quarter before: missed once if it ended without a completed review.
    const prev = quarterOf(
      new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1) - 86_400_000),
    );
    sent = (await this.missedNotice(prev)) || sent;
    const open = await this.sql<{ id: string }[]>`SELECT id FROM access_reviews WHERE completed_at IS NULL`;
    for (const { id } of open)
      await this.sql.begin(async (tx) => {
        await this.sync(tx, id);
        await this.completeIfDone(tx, id, null);
      });
    return (
      (await this.sql.begin(async (tx) => {
        const [r] = await tx<{ id: string; completed_at: Date | null }[]>`
          SELECT id, completed_at FROM access_reviews WHERE quarter = ${quarter}`;
        if (r?.completed_at) return false;
        const url = `${this.options.consoleUrl}/access-review${r ? `?id=${r.id}` : ''}`;
        const first = await tx`
          INSERT INTO access_review_notices (quarter, sent_at) VALUES (${quarter}, ${now})
          ON CONFLICT DO NOTHING RETURNING 1`;
        let reminder = false;
        if (!first.length) {
          // A reminder each week after the first notice, while the review is not complete.
          const [last] = await tx<{ at: Date }[]>`
            SELECT greatest(
              (SELECT sent_at FROM access_review_notices WHERE quarter = ${quarter}),
              coalesce((SELECT max(sent_at) FROM access_review_events WHERE quarter = ${quarter} AND kind = 'reminder'),
                       '-infinity'::timestamptz)) AS at`;
          if (now.getTime() - last!.at.getTime() < 7 * 86_400_000) return false;
          const today = localParts(now.getTime(), this.options.timeZone ?? 'UTC').date;
          const rows = await tx`
            INSERT INTO access_review_events (quarter, kind, day, sent_at) VALUES (${quarter}, 'reminder', ${today}, ${now})
            ON CONFLICT DO NOTHING RETURNING 1`;
          if (!rows.length) return false;
          reminder = true;
        }
        await this.webhooks.enqueue(tx, 'access_review.due', {
          quarter,
          reviewId: r?.id ?? null,
          url,
          ...(reminder ? { reminder: true } : {}),
        });
        await this.audit.append(
          {
            actor: 'access review',
            actorKind: 'system',
            action: reminder ? 'access_review.reminder' : 'access_review.due',
            subjectType: 'access_review',
            subjectId: r?.id ?? quarter,
            data: { quarter },
          },
          tx,
        );
        return true;
      })) || sent
    );
  }

  /** `access_review.missed`, once, for a quarter that ended without a completed review (recorded). */
  private async missedNotice(quarter: string): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const [r] = await tx<{ id: string; completed_at: Date | null }[]>`
        SELECT id, completed_at FROM access_reviews WHERE quarter = ${quarter}`;
      if (r?.completed_at) return false;
      // Only a quarter Landledger was running in (it sent that quarter's notice) can be missed.
      const [ran] = await tx`SELECT 1 FROM access_review_notices WHERE quarter = ${quarter}`;
      if (!ran && !r) return false;
      const today = localParts(this.now().getTime(), this.options.timeZone ?? 'UTC').date;
      const rows = await tx`
        INSERT INTO access_review_events (quarter, kind, day, sent_at)
        SELECT ${quarter}, 'missed', ${today}, ${this.now()}
        WHERE NOT EXISTS (SELECT 1 FROM access_review_events WHERE quarter = ${quarter} AND kind = 'missed')
        ON CONFLICT DO NOTHING RETURNING 1`;
      if (!rows.length) return false;
      const url = `${this.options.consoleUrl}/access-review${r ? `?id=${r.id}` : ''}`;
      await this.webhooks.enqueue(tx, 'access_review.missed', { quarter, reviewId: r?.id ?? null, url, missed: true });
      await this.audit.append(
        {
          actor: 'access review',
          actorKind: 'system',
          action: 'access_review.missed',
          subjectType: 'access_review',
          subjectId: r?.id ?? quarter,
          data: { quarter, opened: !!r },
        },
        tx,
      );
      return true;
    }) as Promise<boolean>;
  }
}
