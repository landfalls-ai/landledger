import type { ApiKey, ApiKeyInput, ApiScope } from '@landledger/contracts';
import { randomBytes } from 'node:crypto';
import type { AuditLog } from './audit.js';
import type { Sql } from './db.js';
import { notFound } from './errors.js';
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
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  revokedAt: r.revoked_at?.toISOString() ?? null,
});

export class Keys {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
  ) {}

  async list(): Promise<ApiKey[]> {
    const rows = await this.sql<Row[]>`
      SELECT id, name, prefix, scopes, created_by, created_at, last_used_at, revoked_at FROM api_keys
      ORDER BY created_at DESC`;
    return rows.map(toKey);
  }

  /** The key itself is returned only here, once. */
  async create(input: ApiKeyInput, by: Principal): Promise<ApiKey & { key: string }> {
    const { key, prefix, hash } = newApiKey();
    const scopes = [...new Set(input.scopes)];
    const actor = actorOf(by);
    return this.sql.begin(async (tx) => {
      const [row] = await tx<Row[]>`
        INSERT INTO api_keys (id, name, prefix, hash, scopes, created_by)
        VALUES (${newId('key')}, ${input.name}, ${prefix}, ${hash}, ${scopes}, ${actor.actor})
        RETURNING id, name, prefix, scopes, created_by, created_at, last_used_at, revoked_at`;
      await this.audit.append(
        {
          ...actor,
          action: 'api_key.created',
          subjectType: 'api_key',
          subjectId: row!.id,
          data: { name: input.name, prefix, scopes },
        },
        tx,
      );
      return { ...toKey(row!), key };
    }) as Promise<ApiKey & { key: string }>;
  }

  async revoke(id: string, by: Principal): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows =
        await tx`UPDATE api_keys SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL RETURNING id`;
      if (rows.length === 0) throw notFound('API key');
      await this.audit.append({ ...actorOf(by), action: 'api_key.revoked', subjectType: 'api_key', subjectId: id }, tx);
    });
  }
}
