import type { ActorKind } from '@landledger/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AuditLog } from './audit.js';
import type { Sql, Tx } from './db.js';
import { notFound } from './errors.js';
import { newId, sha256 } from './ids.js';
import { actorOf, type Principal } from './principal.js';

/**
 * Landledger's SCIM 2.0 server (RFC 7643, RFC 7644) for Landbright's push, at `/scim/v2`: Clickland's `scim.ts`
 * (which passed Landbright's real pushes) on Landledger's tables. Users and Groups with eq filters, PATCH in the forms
 * Landbright and the common clients send, the discovery endpoints, bearer tokens (`lls_…`, stored hashed), RFC 7644
 * errors. Deactivating a person revokes their sessions in the same transaction; their groups decide their roles on the
 * next request (`landledger_effective_groups`). Users are never deleted (approvals and decisions name them): a DELETE
 * deactivates and hides them. Every change is in the audit log, by the token's name.
 */

export const SCHEMAS = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
  spc: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  resourceType: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
  schema: 'urn:ietf:params:scim:schemas:core:2.0:Schema',
} as const;
const SCIM_TYPE = 'application/scim+json; charset=utf-8';

/** An RFC 7644 §3.12 error. */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: string,
  ) {
    super(detail);
    this.name = 'ScimError';
  }
  body() {
    return {
      schemas: [SCHEMAS.error],
      status: String(this.status),
      ...(this.scimType ? { scimType: this.scimType } : {}),
      detail: this.detail,
    };
  }
}
const bad = (detail: string, scimType = 'invalidValue') => new ScimError(400, detail, scimType);

// Tokens -------------------------------------------------------------------------------------------------------------

export const SCIM_TOKEN_PATTERN = /^lls_[\w-]{40}$/;

export class ScimTokens {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
  ) {}

  /** The token is returned only here; Landledger keeps its sha256. */
  async create(name: string, by: { actor: string; actorKind: ActorKind }) {
    const token = `lls_${randomBytes(30).toString('base64url')}`;
    return this.sql.begin(async (tx) => {
      const [row] = await tx<{ id: string; created_at: Date }[]>`
        INSERT INTO scim_tokens (id, name, prefix, hash, created_by)
        VALUES (${newId('sct')}, ${name}, ${token.slice(0, 12)}, ${sha256(token)}, ${by.actor})
        RETURNING id, created_at`;
      await this.audit.append(
        { ...by, action: 'scim.token_created', subjectType: 'scim_token', subjectId: row!.id, data: { name } },
        tx,
      );
      return { id: row!.id, name, prefix: token.slice(0, 12), createdAt: row!.created_at.toISOString(), token };
    }) as Promise<{ id: string; name: string; prefix: string; createdAt: string; token: string }>;
  }

  async list() {
    const rows = await this.sql<
      {
        id: string;
        name: string;
        prefix: string;
        created_by: string;
        created_at: Date;
        last_used_at: Date | null;
        revoked_at: Date | null;
      }[]
    >`SELECT id, name, prefix, created_by, created_at, last_used_at, revoked_at FROM scim_tokens ORDER BY created_at DESC`;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
      lastUsedAt: r.last_used_at?.toISOString() ?? null,
      revokedAt: r.revoked_at?.toISOString() ?? null,
    }));
  }

  async revoke(id: string, by: Principal) {
    await this.sql.begin(async (tx) => {
      const rows =
        await tx`UPDATE scim_tokens SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL RETURNING id`;
      if (rows.length === 0) throw notFound('SCIM token');
      await this.audit.append(
        { ...actorOf(by), action: 'scim.token_revoked', subjectType: 'scim_token', subjectId: id },
        tx,
      );
    });
  }

  /** The token's name when it is valid (for the audit log), else null. */
  async verify(token: string): Promise<string | null> {
    if (!SCIM_TOKEN_PATTERN.test(token)) return null;
    const [row] = await this.sql<{ name: string }[]>`
      UPDATE scim_tokens SET last_used_at = now() WHERE hash = ${sha256(token)} AND revoked_at IS NULL RETURNING name`;
    return row?.name ?? null;
  }
}

// Filters ------------------------------------------------------------------------------------------------------------

/** `attr eq "value"`: the one filter form Landledger answers (RFC 7644 §3.4.2.2). */
export function parseFilter(filter: string, allowed: readonly string[]): { attr: string; value: string } {
  const m = filter.match(/^\s*([A-Za-z][\w.:]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i);
  if (!m)
    throw bad(
      `Landledger answers filters of the form: attribute eq "value" (got ${filter.slice(0, 100)})`,
      'invalidFilter',
    );
  const attr = allowed.find((a) => a.toLowerCase() === m[1]!.toLowerCase());
  if (!attr) throw bad(`Landledger filters on ${allowed.join(', ')} only`, 'invalidFilter');
  return { attr, value: m[2]!.replace(/\\(.)/g, '$1') };
}

/** A PATCH path with a value filter: `members[value eq "id"]` → { attr: 'members', value: 'id' }. */
export function parseValuePath(path: string): { attr: string; value: string | null } {
  const m = path.match(/^\s*(\w+)\s*\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/i);
  if (m) return { attr: m[1]!.toLowerCase(), value: m[2]!.replace(/\\(.)/g, '$1') };
  return { attr: path.trim().toLowerCase(), value: null };
}

const page = (q: { startIndex?: string; count?: string }) => {
  const startIndex = Math.max(1, Number.parseInt(q.startIndex ?? '1', 10) || 1);
  const raw = Number.parseInt(q.count ?? '100', 10);
  const count = Math.min(500, Math.max(0, Number.isNaN(raw) ? 100 : raw));
  return { startIndex, count };
};

// Users --------------------------------------------------------------------------------------------------------------

interface UserRow {
  id: string;
  subject: string;
  user_name: string | null;
  name: string;
  given_name: string | null;
  family_name: string | null;
  email: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
  groups: { id: string; name: string }[] | null;
}

interface UserDraft {
  userName: string;
  externalId: string | null;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  formatted: string | null;
  email: string | null;
  active: boolean;
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${what} must be a non-empty string`);
  return v.trim().slice(0, 500);
};
const optStr = (v: unknown, what: string): string | null =>
  v === null || v === undefined || v === '' ? null : str(v, what);
const bool = (v: unknown, what: string): boolean => {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'True') return true;
  if (v === 'false' || v === 'False') return false;
  throw bad(`${what} must be true or false`);
};
const primaryEmail = (v: unknown): string | null => {
  if (!Array.isArray(v)) throw bad('emails must be a list');
  const list = v.filter((e): e is { value: string; primary?: boolean } => typeof e?.value === 'string');
  return (list.find((e) => e.primary) ?? list[0])?.value ?? null;
};

const USER_PREFIX = `${SCHEMAS.user}:`;
const GROUP_PREFIX = `${SCHEMAS.group}:`;
const stripUrn = (path: string, prefix: string) =>
  path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length) : path;

/** Applies one attribute of a user (a path, lower case) to the draft; false when Landledger doesn't keep it. */
function setUserAttr(d: UserDraft, path: string, value: unknown, remove: boolean): boolean {
  switch (path) {
    case 'active':
      if (remove) throw bad('active can be replaced, not removed', 'mutability');
      d.active = bool(value, 'active');
      return true;
    case 'username':
      if (remove) throw bad('userName is required', 'mutability');
      d.userName = str(value, 'userName');
      return true;
    case 'externalid':
      d.externalId = remove ? null : optStr(value, 'externalId');
      return true;
    case 'displayname':
      d.displayName = remove ? null : optStr(value, 'displayName');
      return true;
    case 'name': {
      if (remove) {
        d.givenName = d.familyName = d.formatted = null;
        return true;
      }
      if (typeof value !== 'object' || value === null) throw bad('name must be an object');
      const n = value as Record<string, unknown>;
      if ('givenName' in n) d.givenName = optStr(n.givenName, 'name.givenName');
      if ('familyName' in n) d.familyName = optStr(n.familyName, 'name.familyName');
      if ('formatted' in n) d.formatted = optStr(n.formatted, 'name.formatted');
      return true;
    }
    case 'name.givenname':
      d.givenName = remove ? null : optStr(value, 'name.givenName');
      return true;
    case 'name.familyname':
      d.familyName = remove ? null : optStr(value, 'name.familyName');
      return true;
    case 'name.formatted':
      d.formatted = remove ? null : optStr(value, 'name.formatted');
      return true;
    case 'emails':
      d.email = remove ? null : primaryEmail(value);
      return true;
    case 'emails[type eq "work"].value':
    case 'emails[primary eq true].value':
      d.email = remove ? null : optStr(value, 'emails.value');
      return true;
    default:
      return false;
  }
}

function draftFromBody(body: Record<string, unknown>): UserDraft {
  const d: UserDraft = {
    userName: str(body.userName, 'userName'),
    externalId: null,
    displayName: null,
    givenName: null,
    familyName: null,
    formatted: null,
    email: null,
    active: body.active === undefined ? true : bool(body.active, 'active'),
  };
  for (const key of ['externalId', 'displayName', 'name', 'emails'] as const)
    if (body[key] !== undefined && body[key] !== null) setUserAttr(d, key.toLowerCase(), body[key], false);
  if (!d.email && /^[^@\s]+@[^@\s]+$/.test(d.userName)) d.email = d.userName;
  return d;
}

const PENDING = 'scim:';
/** A user's subject is Landbright's `sub` (SCIM `externalId`); until one is known, `scim:<id>`. */
const externalIdOf = (subject: string) => (subject.startsWith(PENDING) ? null : subject);

const draftOf = (r: UserRow): UserDraft => ({
  userName: r.user_name ?? r.email ?? r.subject,
  externalId: externalIdOf(r.subject),
  displayName: r.name,
  givenName: r.given_name,
  familyName: r.family_name,
  formatted: null,
  email: r.email,
  active: r.active,
});

/** The name Landledger shows: the display name, else the formatted name, else given and family, else the userName. */
const nameOf = (d: UserDraft) =>
  d.displayName ?? d.formatted ?? ([d.givenName, d.familyName].filter(Boolean).join(' ') || d.userName);

/** A group reference in a user's `groups` (by id or by name, as the replace form sends names). */
interface GroupRef {
  value?: unknown;
  display?: unknown;
}

type Actor = { actor: string; actorKind: 'key' };

// The store ----------------------------------------------------------------------------------------------------------

export class Scim {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    /** Landbright's issuer: a SCIM user's subject is a `sub` there. */
    private readonly issuer: string,
  ) {}

  private userSelect(tx: Tx) {
    return tx`
      SELECT u.id, u.subject, u.user_name, u.name, u.given_name, u.family_name, u.email, u.active, u.created_at,
             u.updated_at,
             (SELECT json_agg(json_build_object('id', g.id, 'name', g.display_name) ORDER BY g.display_name)
                FROM scim_group_members m JOIN scim_groups g ON g.id = m.group_id WHERE m.user_id = u.id) AS groups
      FROM users u`;
  }

  userResource(r: UserRow, base: string) {
    const name =
      r.given_name || r.family_name
        ? {
            ...(r.given_name ? { givenName: r.given_name } : {}),
            ...(r.family_name ? { familyName: r.family_name } : {}),
            formatted: [r.given_name, r.family_name].filter(Boolean).join(' '),
          }
        : undefined;
    const externalId = externalIdOf(r.subject);
    return {
      schemas: [SCHEMAS.user],
      id: r.id,
      ...(externalId ? { externalId } : {}),
      userName: r.user_name ?? r.email ?? r.subject,
      displayName: r.name,
      ...(name ? { name } : {}),
      ...(r.email ? { emails: [{ value: r.email, type: 'work', primary: true }] } : {}),
      active: r.active,
      groups: (r.groups ?? []).map((g) => ({ value: g.id, display: g.name, $ref: `${base}/Groups/${g.id}` })),
      meta: {
        resourceType: 'User',
        created: r.created_at.toISOString(),
        lastModified: r.updated_at.toISOString(),
        location: `${base}/Users/${r.id}`,
      },
    };
  }

  async getUser(id: string, tx: Tx = this.sql): Promise<UserRow> {
    const [row] = await tx<UserRow[]>`
      ${this.userSelect(tx)} WHERE u.id = ${id} AND u.kind = 'person' AND u.deleted_at IS NULL`;
    if (!row) throw new ScimError(404, `User ${id} not found`);
    return row;
  }

  async listUsers(filter: string | undefined, q: { startIndex?: string; count?: string }) {
    const f = filter ? parseFilter(filter, ['userName', 'externalId', 'displayName', 'id']) : null;
    const s = this.sql;
    const where = !f
      ? s`true`
      : f.attr === 'userName'
        ? s`lower(coalesce(u.user_name, u.email)) = lower(${f.value})`
        : f.attr === 'externalId'
          ? s`u.subject = ${f.value}`
          : f.attr === 'displayName'
            ? s`lower(u.name) = lower(${f.value})`
            : s`u.id = ${f.value}`;
    const live = s`u.kind = 'person' AND u.deleted_at IS NULL`;
    const { startIndex, count } = page(q);
    const [{ n }] = (await s<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users u WHERE ${live} AND ${where}`) as unknown as [{ n: number }];
    const rows = count
      ? await s<UserRow[]>`
          ${this.userSelect(s)} WHERE ${live} AND ${where} ORDER BY u.created_at, u.id OFFSET ${startIndex - 1} LIMIT ${count}`
      : [];
    return { total: n, startIndex, rows };
  }

  async createUser(body: Record<string, unknown>, by: Actor): Promise<UserRow> {
    const d = draftFromBody(body);
    return this.sql.begin(async (tx) => {
      const [clash] = await tx<{ id: string; deleted: boolean }[]>`
        SELECT id, deleted_at IS NOT NULL AS deleted FROM users
        WHERE kind = 'person' AND (lower(coalesce(user_name, email)) = lower(${d.userName})
          OR (${d.externalId}::text IS NOT NULL AND subject = ${d.externalId}))
        ORDER BY deleted_at NULLS FIRST LIMIT 1`;
      if (clash && !clash.deleted)
        throw new ScimError(409, `A user with userName ${d.userName} or that externalId already exists`, 'uniqueness');
      let id: string;
      if (clash) {
        // Deleted before and pushed again: the same person comes back (their history names this id).
        id = clash.id;
        await tx`UPDATE users SET deleted_at = NULL, updated_at = now() WHERE id = ${id}`;
        await this.saveDraft(tx, id, d, false, by);
      } else {
        id = newId('usr');
        await tx`
          INSERT INTO users (id, issuer, subject, email, name, user_name, given_name, family_name, active, scim_managed,
                             deactivated_at)
          VALUES (${id}, ${this.issuer}, ${d.externalId ?? `${PENDING}${id}`}, ${d.email}, ${nameOf(d)}, ${d.userName},
                  ${d.givenName}, ${d.familyName}, ${d.active}, true, ${d.active ? null : new Date()})`;
      }
      if (Array.isArray(body.groups)) await this.setUserGroups(tx, id, body.groups as GroupRef[]);
      await this.audit.append(
        {
          ...by,
          action: 'scim.user_created',
          subjectType: 'user',
          subjectId: id,
          data: { userName: d.userName, externalId: d.externalId, active: d.active },
        },
        tx,
      );
      return this.getUser(id, tx);
    }) as Promise<UserRow>;
  }

  private async saveDraft(tx: Tx, id: string, d: UserDraft, wasActive: boolean, by: Actor) {
    await tx`
      UPDATE users SET user_name = ${d.userName}, subject = ${d.externalId ?? `${PENDING}${id}`},
        issuer = ${this.issuer}, name = ${nameOf(d)}, given_name = ${d.givenName}, family_name = ${d.familyName},
        email = ${d.email}, active = ${d.active}, scim_managed = true, updated_at = now(),
        deactivated_at = CASE WHEN ${d.active}::boolean THEN NULL ELSE coalesce(deactivated_at, now()) END
      WHERE id = ${id}`;
    if (wasActive && !d.active) await this.endSessions(tx, id, 'deactivated', by);
    if (!wasActive && d.active)
      await this.audit.append({ ...by, action: 'scim.user_reactivated', subjectType: 'user', subjectId: id }, tx);
  }

  /** Revokes every session of a person at once: their next request is 401. */
  private async endSessions(tx: Tx, id: string, why: 'deactivated' | 'deleted', by: Actor) {
    const ended = await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${id} AND revoked_at IS NULL`;
    await this.audit.append(
      { ...by, action: `scim.user_${why}`, subjectType: 'user', subjectId: id, data: { sessionsEnded: ended.count } },
      tx,
    );
  }

  async replaceUser(id: string, body: Record<string, unknown>, by: Actor): Promise<UserRow> {
    const d = draftFromBody(body);
    return this.sql.begin(async (tx) => {
      const current = await this.getUser(id, tx);
      await this.saveDraft(tx, id, d, current.active, by);
      if (Array.isArray(body.groups)) await this.setUserGroups(tx, id, body.groups as GroupRef[]);
      await this.audit.append(
        { ...by, action: 'scim.user_replaced', subjectType: 'user', subjectId: id, data: { userName: d.userName } },
        tx,
      );
      return this.getUser(id, tx);
    }) as Promise<UserRow>;
  }

  /** RFC 7644 §3.5.2: add, replace and remove, with a path or without one (the value is then an object of attributes). */
  async patchUser(id: string, body: Record<string, unknown>, by: Actor): Promise<UserRow> {
    const ops = patchOps(body);
    return this.sql.begin(async (tx) => {
      const current = await this.getUser(id, tx);
      const d = draftOf(current);
      const changed: string[] = [];
      for (const op of ops) {
        if (op.path === undefined) {
          if (op.op === 'remove') throw bad('remove needs a path', 'noTarget');
          if (typeof op.value !== 'object' || op.value === null || Array.isArray(op.value))
            throw bad('An operation without a path takes an object of attributes');
          for (const [key, value] of Object.entries(op.value as Record<string, unknown>)) {
            const path = stripUrn(key, USER_PREFIX).toLowerCase();
            if (path === 'groups') await this.userGroupsOp(tx, id, op.op, null, value);
            else if (setUserAttr(d, path, value, false)) changed.push(path); // attributes not kept are ignored
          }
          continue;
        }
        const { attr, value: selector } = parseValuePath(stripUrn(op.path, USER_PREFIX));
        if (attr === 'groups') {
          await this.userGroupsOp(tx, id, op.op, selector, op.value);
          changed.push('groups');
          continue;
        }
        if (selector !== null || !setUserAttr(d, attr, op.value, op.op === 'remove'))
          throw bad(`Landledger can't change ${op.path}`, 'invalidPath');
        changed.push(attr);
      }
      await this.saveDraft(tx, id, d, current.active, by);
      await this.audit.append(
        { ...by, action: 'scim.user_patched', subjectType: 'user', subjectId: id, data: { changed, active: d.active } },
        tx,
      );
      return this.getUser(id, tx);
    }) as Promise<UserRow>;
  }

  /** Landbright never deletes; a DELETE deactivates, ends sessions, drops memberships and hides the person. */
  async deleteUser(id: string, by: Actor) {
    await this.sql.begin(async (tx) => {
      await this.getUser(id, tx);
      await tx`UPDATE users SET active = false, deleted_at = now(), updated_at = now(),
                 deactivated_at = coalesce(deactivated_at, now()) WHERE id = ${id}`;
      await tx`DELETE FROM scim_group_members WHERE user_id = ${id}`;
      await touchGroups(tx, [id]);
      await this.endSessions(tx, id, 'deleted', by);
    });
  }

  // A user's groups (the replace form: names, as Landbright sends them) ------------------------------------------------

  /** Groups by id, else by display name; a name Landledger hasn't seen becomes a group when `create`. */
  private async resolveGroups(tx: Tx, refs: GroupRef[], create: boolean): Promise<string[]> {
    const ids: string[] = [];
    for (const ref of refs) {
      const key = typeof ref?.value === 'string' ? ref.value : typeof ref?.display === 'string' ? ref.display : null;
      if (!key) throw bad('A group needs a value');
      const display = typeof ref.display === 'string' && ref.display ? ref.display : key;
      const [found] = await tx<{ id: string }[]>`
        SELECT id FROM scim_groups
        WHERE id = ${key} OR lower(display_name) = lower(${key}) OR lower(display_name) = lower(${display})
        ORDER BY (id = ${key}) DESC LIMIT 1`;
      if (found) ids.push(found.id);
      else if (create) {
        const [made] = await tx<{ id: string }[]>`
          INSERT INTO scim_groups (id, display_name) VALUES (${newId('grp')}, ${display}) RETURNING id`;
        ids.push(made!.id);
      }
    }
    return [...new Set(ids)];
  }

  private async setUserGroups(tx: Tx, userId: string, refs: GroupRef[]) {
    const ids = await this.resolveGroups(tx, refs, true);
    await tx`DELETE FROM scim_group_members WHERE user_id = ${userId} AND NOT (group_id = ANY(${ids}))`;
    for (const g of ids)
      await tx`INSERT INTO scim_group_members (group_id, user_id) VALUES (${g}, ${userId}) ON CONFLICT DO NOTHING`;
    await touchGroups(tx, [userId]);
  }

  private async userGroupsOp(tx: Tx, userId: string, op: string, selector: string | null, value: unknown) {
    const refs = (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]) as GroupRef[];
    if (op === 'replace') return this.setUserGroups(tx, userId, refs);
    if (op === 'add') {
      for (const g of await this.resolveGroups(tx, refs, true))
        await tx`INSERT INTO scim_group_members (group_id, user_id) VALUES (${g}, ${userId}) ON CONFLICT DO NOTHING`;
    } else if (selector === null && refs.length === 0) {
      await tx`DELETE FROM scim_group_members WHERE user_id = ${userId}`;
    } else {
      const ids = await this.resolveGroups(tx, selector !== null ? [{ value: selector }] : refs, false);
      await tx`DELETE FROM scim_group_members WHERE user_id = ${userId} AND group_id = ANY(${ids})`;
    }
    await touchGroups(tx, [userId]);
  }

  // Groups -------------------------------------------------------------------------------------------------------------

  private groupSelect(tx: Tx) {
    return tx`
      SELECT g.id, g.display_name, g.external_id, g.created_at, g.updated_at,
             (SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY coalesce(u.user_name, u.email))
                FROM scim_group_members m JOIN users u ON u.id = m.user_id
                WHERE m.group_id = g.id AND u.deleted_at IS NULL) AS members
      FROM scim_groups g`;
  }

  groupResource(r: GroupRow, base: string, withMembers = true) {
    return {
      schemas: [SCHEMAS.group],
      id: r.id,
      displayName: r.display_name,
      ...(r.external_id ? { externalId: r.external_id } : {}),
      ...(withMembers
        ? {
            members: (r.members ?? []).map((m) => ({
              value: m.id,
              display: m.name,
              type: 'User',
              $ref: `${base}/Users/${m.id}`,
            })),
          }
        : {}),
      meta: {
        resourceType: 'Group',
        created: r.created_at.toISOString(),
        lastModified: r.updated_at.toISOString(),
        location: `${base}/Groups/${r.id}`,
      },
    };
  }

  async getGroup(id: string, tx: Tx = this.sql): Promise<GroupRow> {
    const [row] = await tx<GroupRow[]>`${this.groupSelect(tx)} WHERE g.id = ${id}`;
    if (!row) throw new ScimError(404, `Group ${id} not found`);
    return row;
  }

  async listGroups(filter: string | undefined, q: { startIndex?: string; count?: string }) {
    const f = filter ? parseFilter(filter, ['displayName', 'externalId', 'id']) : null;
    const s = this.sql;
    const where = !f
      ? s`true`
      : f.attr === 'displayName'
        ? s`lower(g.display_name) = lower(${f.value})`
        : f.attr === 'externalId'
          ? s`g.external_id = ${f.value}`
          : s`g.id = ${f.value}`;
    const { startIndex, count } = page(q);
    const [{ n }] = (await s<{ n: number }[]>`
      SELECT count(*)::int AS n FROM scim_groups g WHERE ${where}`) as unknown as [{ n: number }];
    const rows = count
      ? await s<GroupRow[]>`
          ${this.groupSelect(s)} WHERE ${where} ORDER BY g.created_at, g.id OFFSET ${startIndex - 1} LIMIT ${count}`
      : [];
    return { total: n, startIndex, rows };
  }

  /** Member ids that are people here; an unknown id is a 400 (RFC 7644 invalidValue). */
  private async memberIds(tx: Tx, value: unknown): Promise<string[]> {
    const list = (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]) as {
      value?: unknown;
    }[];
    const ids = [...new Set(list.map((m) => (typeof m?.value === 'string' ? m.value : null)))];
    if (ids.includes(null)) throw bad('Each member needs a value (a user id)');
    const known = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE id = ANY(${ids as string[]}) AND kind = 'person' AND deleted_at IS NULL`;
    const missing = (ids as string[]).filter((id) => !known.some((k) => k.id === id));
    if (missing.length) throw bad(`No user ${missing.join(', ')}`);
    return ids as string[];
  }

  private async addMembers(tx: Tx, groupId: string, ids: string[]) {
    for (const u of ids)
      await tx`INSERT INTO scim_group_members (group_id, user_id) VALUES (${groupId}, ${u}) ON CONFLICT DO NOTHING`;
    await touchGroups(tx, ids);
  }

  private async setMembers(tx: Tx, groupId: string, ids: string[]) {
    const removed = await tx<{ user_id: string }[]>`
      DELETE FROM scim_group_members WHERE group_id = ${groupId} AND NOT (user_id = ANY(${ids})) RETURNING user_id`;
    await this.addMembers(tx, groupId, ids);
    await touchGroups(
      tx,
      removed.map((r) => r.user_id),
    );
  }

  private async removeMembers(tx: Tx, groupId: string, ids: string[] | null) {
    const removed = ids
      ? await tx<{ user_id: string }[]>`
          DELETE FROM scim_group_members WHERE group_id = ${groupId} AND user_id = ANY(${ids}) RETURNING user_id`
      : await tx<{ user_id: string }[]>`DELETE FROM scim_group_members WHERE group_id = ${groupId} RETURNING user_id`;
    await touchGroups(
      tx,
      removed.map((r) => r.user_id),
    );
  }

  private async auditGroup(tx: Tx, by: Actor, action: string, id: string) {
    const [g] = await tx<{ display_name: string; members: string[] }[]>`
      SELECT g.display_name, coalesce(array_agg(m.user_id ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS members
      FROM scim_groups g LEFT JOIN scim_group_members m ON m.group_id = g.id WHERE g.id = ${id} GROUP BY g.id`;
    await this.audit.append(
      {
        ...by,
        action,
        subjectType: 'scim_group',
        subjectId: id,
        data: g ? { displayName: g.display_name, members: g.members } : {},
      },
      tx,
    );
  }

  async createGroup(body: Record<string, unknown>, by: Actor): Promise<GroupRow> {
    const displayName = str(body.displayName, 'displayName');
    return this.sql.begin(async (tx) => {
      const [clash] = await tx`SELECT id FROM scim_groups WHERE lower(display_name) = lower(${displayName})`;
      if (clash) throw new ScimError(409, `A group named ${displayName} already exists`, 'uniqueness');
      const ids = await this.memberIds(tx, body.members);
      const id = newId('grp');
      await tx`INSERT INTO scim_groups (id, display_name, external_id)
               VALUES (${id}, ${displayName}, ${optStr(body.externalId, 'externalId')})`;
      await this.addMembers(tx, id, ids);
      await this.auditGroup(tx, by, 'scim.group_created', id);
      return this.getGroup(id, tx);
    }) as Promise<GroupRow>;
  }

  async replaceGroup(id: string, body: Record<string, unknown>, by: Actor): Promise<GroupRow> {
    const displayName = str(body.displayName, 'displayName');
    return this.sql.begin(async (tx) => {
      await this.getGroup(id, tx);
      await tx`UPDATE scim_groups SET display_name = ${displayName}, external_id = ${optStr(body.externalId, 'externalId')},
               updated_at = now() WHERE id = ${id}`;
      await this.setMembers(tx, id, await this.memberIds(tx, body.members));
      // A rename changes what the group means for every member: their roles follow on the next request.
      await this.touchMembers(tx, id);
      await this.auditGroup(tx, by, 'scim.group_replaced', id);
      return this.getGroup(id, tx);
    }) as Promise<GroupRow>;
  }

  private async touchMembers(tx: Tx, groupId: string) {
    const members = await tx<{ user_id: string }[]>`SELECT user_id FROM scim_group_members WHERE group_id = ${groupId}`;
    await touchGroups(
      tx,
      members.map((m) => m.user_id),
    );
  }

  async patchGroup(id: string, body: Record<string, unknown>, by: Actor): Promise<GroupRow> {
    const ops = patchOps(body);
    return this.sql.begin(async (tx) => {
      await this.getGroup(id, tx);
      const apply = async (op: string, attr: string, selector: string | null, value: unknown) => {
        switch (attr) {
          case 'members':
            if (op === 'remove') {
              if (selector !== null) return this.removeMembers(tx, id, [selector]);
              if (value === undefined || value === null) return this.removeMembers(tx, id, null);
              const list = (Array.isArray(value) ? value : [value]) as { value?: unknown }[];
              return this.removeMembers(
                tx,
                id,
                list.map((m) => String(m?.value ?? '')),
              );
            }
            if (selector !== null) throw bad('Add or replace members with a list, not a filter', 'invalidPath');
            return op === 'add'
              ? this.addMembers(tx, id, await this.memberIds(tx, value))
              : this.setMembers(tx, id, await this.memberIds(tx, value));
          case 'displayname':
            if (op === 'remove') throw bad('displayName is required', 'mutability');
            await tx`UPDATE scim_groups SET display_name = ${str(value, 'displayName')} WHERE id = ${id}`;
            await this.touchMembers(tx, id);
            return;
          case 'externalid':
            await tx`UPDATE scim_groups SET external_id = ${op === 'remove' ? null : optStr(value, 'externalId')} WHERE id = ${id}`;
            return;
          default:
            throw bad(`Landledger can't change ${attr}`, 'invalidPath');
        }
      };
      for (const op of ops) {
        if (op.path === undefined) {
          if (op.op === 'remove') throw bad('remove needs a path', 'noTarget');
          if (typeof op.value !== 'object' || op.value === null || Array.isArray(op.value))
            throw bad('An operation without a path takes an object of attributes');
          for (const [key, value] of Object.entries(op.value as Record<string, unknown>)) {
            const attr = stripUrn(key, GROUP_PREFIX).toLowerCase();
            if (['members', 'displayname', 'externalid'].includes(attr)) await apply(op.op, attr, null, value);
          }
          continue;
        }
        const { attr, value: selector } = parseValuePath(stripUrn(op.path, GROUP_PREFIX));
        await apply(op.op, attr, selector, op.value);
      }
      await tx`UPDATE scim_groups SET updated_at = now() WHERE id = ${id}`;
      await this.auditGroup(tx, by, 'scim.group_patched', id);
      return this.getGroup(id, tx);
    }) as Promise<GroupRow>;
  }

  async deleteGroup(id: string, by: Actor) {
    await this.sql.begin(async (tx) => {
      const members = await tx<{ user_id: string }[]>`SELECT user_id FROM scim_group_members WHERE group_id = ${id}`;
      const [g] = await tx<{ display_name: string }[]>`SELECT display_name FROM scim_groups WHERE id = ${id}`;
      const rows = await tx`DELETE FROM scim_groups WHERE id = ${id} RETURNING id`;
      if (rows.length === 0) throw new ScimError(404, `Group ${id} not found`);
      await touchGroups(
        tx,
        members.map((m) => m.user_id),
      );
      await this.audit.append(
        {
          ...by,
          action: 'scim.group_deleted',
          subjectType: 'scim_group',
          subjectId: id,
          data: { displayName: g?.display_name ?? null, members: members.map((m) => m.user_id) },
        },
        tx,
      );
    });
  }
}

interface GroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
  created_at: Date;
  updated_at: Date;
  members: { id: string; name: string }[] | null;
}

/** SCIM has set these people's groups: from now on their memberships, not the sign-in claim, decide their roles. */
async function touchGroups(tx: Tx, userIds: string[]) {
  if (userIds.length)
    await tx`UPDATE users SET scim_groups_at = now(), updated_at = now() WHERE id = ANY(${[...new Set(userIds)]})`;
}

interface PatchOp {
  op: 'add' | 'replace' | 'remove';
  path?: string;
  value?: unknown;
}

/** The Operations of a PatchOp message; `op` without case (some clients send "Replace"). */
export function patchOps(body: Record<string, unknown>): PatchOp[] {
  const schemas = body.schemas;
  if (Array.isArray(schemas) && !schemas.includes(SCHEMAS.patch))
    throw bad(`A PATCH body is a ${SCHEMAS.patch}`, 'invalidSyntax');
  if (!Array.isArray(body.Operations) || body.Operations.length === 0)
    throw bad('Operations must be a non-empty list', 'invalidSyntax');
  return body.Operations.map((raw: unknown) => {
    const o = raw as Record<string, unknown>;
    const op = typeof o?.op === 'string' ? o.op.toLowerCase() : '';
    if (op !== 'add' && op !== 'replace' && op !== 'remove') throw bad(`Unknown op ${String(o?.op)}`, 'invalidSyntax');
    if (o.path !== undefined && (typeof o.path !== 'string' || !o.path.trim()))
      throw bad('path must be a string', 'invalidPath');
    return { op, path: o.path as string | undefined, value: o.value };
  });
}

// Routes -------------------------------------------------------------------------------------------------------------

const SPC = {
  schemas: [SCHEMAS.spc],
  documentationUri: 'https://github.com/landfalls-ai/landledger/blob/main/docs/identity.md',
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 500 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: 'oauthbearertoken',
      name: 'Bearer token',
      description: 'A Landledger SCIM token (lls_…), minted with `pnpm scim:token`',
      primary: true,
    },
  ],
  meta: { resourceType: 'ServiceProviderConfig' },
};

const attr = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type,
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...extra,
});

const USER_SCHEMA = {
  schemas: [SCHEMAS.schema],
  id: SCHEMAS.user,
  name: 'User',
  description: 'A person who signs in to Landledger through Landbright',
  attributes: [
    attr('userName', 'string', { required: true, uniqueness: 'server' }),
    attr('displayName', 'string'),
    attr('name', 'complex', {
      subAttributes: [attr('givenName', 'string'), attr('familyName', 'string'), attr('formatted', 'string')],
    }),
    attr('emails', 'complex', {
      multiValued: true,
      subAttributes: [attr('value', 'string'), attr('type', 'string'), attr('primary', 'boolean')],
    }),
    attr('active', 'boolean'),
    attr('groups', 'complex', {
      multiValued: true,
      mutability: 'readOnly',
      subAttributes: [
        attr('value', 'string', { mutability: 'readOnly' }),
        attr('display', 'string', { mutability: 'readOnly' }),
      ],
    }),
  ],
  meta: { resourceType: 'Schema', location: `/scim/v2/Schemas/${SCHEMAS.user}` },
};

const GROUP_SCHEMA = {
  schemas: [SCHEMAS.schema],
  id: SCHEMAS.group,
  name: 'Group',
  description:
    'A Landbright group; Finance CFO, Finance Controllers, Finance FP&A, Budget Owners, Landledger Auditors and Engineering give a role',
  attributes: [
    attr('displayName', 'string', { required: true, uniqueness: 'server' }),
    attr('members', 'complex', {
      multiValued: true,
      subAttributes: [
        attr('value', 'string', { mutability: 'immutable' }),
        attr('display', 'string', { mutability: 'readOnly' }),
      ],
    }),
  ],
  meta: { resourceType: 'Schema', location: `/scim/v2/Schemas/${SCHEMAS.group}` },
};

const RESOURCE_TYPES = [
  {
    schemas: [SCHEMAS.resourceType],
    id: 'User',
    name: 'User',
    endpoint: '/Users',
    schema: SCHEMAS.user,
    meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/User' },
  },
  {
    schemas: [SCHEMAS.resourceType],
    id: 'Group',
    name: 'Group',
    endpoint: '/Groups',
    schema: SCHEMAS.group,
    meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/Group' },
  },
];

const listResponse = (total: number, startIndex: number, resources: unknown[]) => ({
  schemas: [SCHEMAS.list],
  totalResults: total,
  startIndex,
  itemsPerPage: resources.length,
  Resources: resources,
});

/** `excludedAttributes=members` (or `attributes` without members) leaves the members out of a group. */
const wantsMembers = (q: { attributes?: string; excludedAttributes?: string }) => {
  const has = (list: string | undefined) => (list ?? '').split(',').some((a) => a.trim().toLowerCase() === 'members');
  if (has(q.excludedAttributes)) return false;
  return q.attributes ? has(q.attributes) : true;
};

/** Mounts `/scim/v2` with its own bearer auth, content type, error shape and 404s. */
export async function registerScim(app: FastifyInstance, scim: Scim, tokens: ScimTokens): Promise<void> {
  await app.register(
    async (s) => {
      s.addContentTypeParser(['application/scim+json'], { parseAs: 'string' }, (_req, body, done) => {
        try {
          done(null, body === '' ? {} : JSON.parse(body as string));
        } catch {
          done(new ScimError(400, 'The body is not JSON', 'invalidSyntax'), undefined);
        }
      });
      s.addHook('onRequest', async (request: FastifyRequest) => {
        const m = request.headers.authorization?.match(/^Bearer\s+(\S+)$/i);
        const name = m ? await tokens.verify(m[1]!) : null;
        if (!name) throw new ScimError(401, 'Send a Landledger SCIM token: Authorization: Bearer lls_…');
        (request as FastifyRequest & { scimActor?: Actor }).scimActor = { actor: `scim:${name}`, actorKind: 'key' };
      });
      s.addHook('onSend', async (_request, reply, payload) => {
        if (String(reply.getHeader('content-type') ?? '').startsWith('application/json'))
          reply.header('content-type', SCIM_TYPE);
        return payload;
      });
      s.setErrorHandler((error, request, reply) => {
        if (error instanceof ScimError) return reply.status(error.status).type(SCIM_TYPE).send(error.body());
        const e = error as { statusCode?: number; code?: string; message: string };
        if (e.code === '23505')
          return reply
            .status(409)
            .type(SCIM_TYPE)
            .send(new ScimError(409, 'That userName or displayName is taken', 'uniqueness').body());
        if (e.statusCode && e.statusCode < 500)
          return reply
            .status(e.statusCode)
            .type(SCIM_TYPE)
            .send(new ScimError(e.statusCode, e.message, e.statusCode === 400 ? 'invalidSyntax' : undefined).body());
        request.log.error(error);
        return reply.status(500).type(SCIM_TYPE).send(new ScimError(500, 'Something went wrong in Landledger').body());
      });
      s.setNotFoundHandler((request, reply) =>
        reply
          .status(404)
          .type(SCIM_TYPE)
          .send(new ScimError(404, `No SCIM route ${request.method} ${request.url.split('?')[0]}`).body()),
      );

      const base = (r: FastifyRequest) => `${r.protocol}://${r.headers.host}/scim/v2`;
      const id = (r: FastifyRequest) => (r.params as { id: string }).id;
      const who = (r: FastifyRequest) => (r as FastifyRequest & { scimActor: Actor }).scimActor;
      const body = (r: FastifyRequest) => {
        if (typeof r.body !== 'object' || r.body === null || Array.isArray(r.body))
          throw bad('The body must be a JSON object', 'invalidSyntax');
        return r.body as Record<string, unknown>;
      };
      type Q = {
        filter?: string;
        startIndex?: string;
        count?: string;
        attributes?: string;
        excludedAttributes?: string;
      };
      const created = (reply: FastifyReply, resource: { meta: { location: string } }) =>
        reply.status(201).header('location', resource.meta.location).send(resource);

      s.get('/ServiceProviderConfig', async () => SPC);
      s.get('/ResourceTypes', async () => listResponse(RESOURCE_TYPES.length, 1, RESOURCE_TYPES));
      s.get('/ResourceTypes/:id', async (r) => {
        const found = RESOURCE_TYPES.find((t) => t.id === id(r));
        if (!found) throw new ScimError(404, `No resource type ${id(r)}`);
        return found;
      });
      s.get('/Schemas', async () => listResponse(2, 1, [USER_SCHEMA, GROUP_SCHEMA]));
      s.get('/Schemas/:id', async (r) => {
        const found = [USER_SCHEMA, GROUP_SCHEMA].find((t) => t.id === id(r));
        if (!found) throw new ScimError(404, `No schema ${id(r)}`);
        return found;
      });

      s.get('/Users', async (r) => {
        const q = r.query as Q;
        const { total, startIndex, rows } = await scim.listUsers(q.filter, q);
        return listResponse(
          total,
          startIndex,
          rows.map((u) => scim.userResource(u, base(r))),
        );
      });
      s.post('/Users', async (r, reply) =>
        created(reply, scim.userResource(await scim.createUser(body(r), who(r)), base(r))),
      );
      s.get('/Users/:id', async (r) => scim.userResource(await scim.getUser(id(r)), base(r)));
      s.put('/Users/:id', async (r) => scim.userResource(await scim.replaceUser(id(r), body(r), who(r)), base(r)));
      s.patch('/Users/:id', async (r) => scim.userResource(await scim.patchUser(id(r), body(r), who(r)), base(r)));
      s.delete('/Users/:id', async (r, reply) => {
        await scim.deleteUser(id(r), who(r));
        return reply.status(204).send();
      });

      s.get('/Groups', async (r) => {
        const q = r.query as Q;
        const { total, startIndex, rows } = await scim.listGroups(q.filter, q);
        return listResponse(
          total,
          startIndex,
          rows.map((g) => scim.groupResource(g, base(r), wantsMembers(q))),
        );
      });
      s.post('/Groups', async (r, reply) =>
        created(reply, scim.groupResource(await scim.createGroup(body(r), who(r)), base(r))),
      );
      s.get('/Groups/:id', async (r) =>
        scim.groupResource(await scim.getGroup(id(r)), base(r), wantsMembers(r.query as Q)),
      );
      s.put('/Groups/:id', async (r) => scim.groupResource(await scim.replaceGroup(id(r), body(r), who(r)), base(r)));
      s.patch('/Groups/:id', async (r) => scim.groupResource(await scim.patchGroup(id(r), body(r), who(r)), base(r)));
      s.delete('/Groups/:id', async (r, reply) => {
        await scim.deleteGroup(id(r), who(r));
        return reply.status(204).send();
      });
    },
    { prefix: '/scim/v2' },
  );
}
