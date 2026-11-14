import { type ApiKey, ApiKeyInput, type ApiScope, RELAY_EXCLUDES } from '@landledger/contracts';
import { randomBytes } from 'node:crypto';
import type { AuditLog } from './audit.js';
import type { Sql } from './db.js';
import { ApiError, notFound } from './errors.js';
import { newId, sha256 } from './ids.js';
import { actorOf, type Principal } from './principal.js';

/** A new key: `ll_` and 32 base64url characters. Only its sha256 is stored; the prefix helps people tell keys apart. */
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `ll_${randomBytes(24).toString('base64url').slice(0, 32)}`;
  return { key, prefix: key.slice(0, 11), hash: sha256(key) };
}

type Row = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  bound_workflow_ids: string[];
  created_by: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};
const toKey = (r: Row): ApiKey => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scopes: r.scopes,
  boundWorkflowIds: r.bound_workflow_ids,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  revokedAt: r.revoked_at?.toISOString() ?? null,
});

/**
 * API keys (review of wave 2): only a signed-in person with `admin` mints one. The bootstrap key may mint only until
 * the first admin person has signed in (the documented first-setup path is that person signing in through Landbright
 * in `Finance Controllers` or `Finance CFO`); a key, and the local developer, never mint. A `decisions:relay` key
 * holds neither `requests:write` nor `admin`.
 */
export class Keys {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
  ) {}

  async list(): Promise<ApiKey[]> {
    const rows = await this.sql<Row[]>`
      SELECT id, name, prefix, scopes, bound_workflow_ids, created_by, created_at, last_used_at, revoked_at
      FROM api_keys ORDER BY created_at DESC`;
    return rows.map(toKey);
  }

  /** Whether a person who administers Landledger (CFO or controller) has signed in yet. */
  async adminPersonExists(): Promise<boolean> {
    const [row] = await this.sql`
      SELECT 1 FROM users WHERE kind = 'person' AND active AND deleted_at IS NULL
        AND roles && ARRAY['cfo', 'controller']::text[] LIMIT 1`;
    return !!row;
  }

  private async mayMint(by: Principal): Promise<void> {
    if (by.kind === 'person') {
      if (!by.scopes.includes('admin')) throw new ApiError('forbidden', 'This needs the admin scope');
      return;
    }
    if (by.kind === 'bootstrap') {
      if (await this.adminPersonExists())
        throw new ApiError(
          'forbidden',
          'The bootstrap key mints keys only before the first admin person signs in: an admin person mints them now',
        );
      return;
    }
    throw new ApiError(
      'forbidden',
      'A signed-in person with admin mints API keys; a key or the local developer never does',
    );
  }

  /** The key itself is returned only here, once. */
  async create(input: ApiKeyInput, by: Principal): Promise<ApiKey & { key: string }> {
    await this.mayMint(by);
    const parsed = ApiKeyInput.parse(input);
    const scopes = [...new Set(parsed.scopes)];
    if (scopes.includes('decisions:relay') && scopes.some((s) => RELAY_EXCLUDES.includes(s)))
      throw new ApiError('bad_request', 'A decisions:relay key holds neither requests:write nor admin');
    const bound = [...new Set(parsed.boundWorkflowIds)];
    const { key, prefix, hash } = newApiKey();
    const actor = actorOf(by);
    return this.sql.begin(async (tx) => {
      const [row] = await tx<Row[]>`
        INSERT INTO api_keys (id, name, prefix, hash, scopes, bound_workflow_ids, created_by, created_by_user)
        VALUES (${newId('key')}, ${parsed.name}, ${prefix}, ${hash}, ${scopes}, ${bound}, ${actor.actor},
                ${by.kind === 'person' ? by.id : null})
        RETURNING id, name, prefix, scopes, bound_workflow_ids, created_by, created_at, last_used_at, revoked_at`;
      await this.audit.append(
        {
          ...actor,
          action: 'api_key.created',
          subjectType: 'api_key',
          subjectId: row!.id,
          data: { name: parsed.name, prefix, scopes, boundWorkflowIds: bound },
        },
        tx,
      );
      return { ...toKey(row!), key };
    }) as Promise<ApiKey & { key: string }>;
  }

  async revoke(id: string, by: Principal): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string; name: string; scopes: string[] }[]>`
        UPDATE api_keys SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL RETURNING id, name, scopes`;
      if (rows.length === 0) throw notFound('API key');
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'api_key.revoked',
          subjectType: 'api_key',
          subjectId: id,
          data: { name: rows[0]!.name, scopes: rows[0]!.scopes },
        },
        tx,
      );
    });
  }
}
