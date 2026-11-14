import {
  type ActorKind,
  type ApiScope,
  type Me,
  type PrincipalKind,
  type Role,
  SCOPES_BY_ROLE,
} from '@landledger/contracts';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { ApiError } from './errors.js';
import { sha256 } from './ids.js';

/** Who is calling: a person (a console session), an API key, the bootstrap key, or the local developer. */
export interface Principal {
  kind: PrincipalKind;
  /** `usr_…` for a person, `key_…` for a key, `bootstrap`, `dev`. */
  id: string;
  name: string;
  email: string | null;
  roles: Role[];
  groups: string[];
  scopes: ApiScope[];
  /** The session's id (sha256 of the cookie) when a person signed in. */
  sessionId?: string;
}

export const SESSION_COOKIE = 'll_session';
export const KEY_PATTERN = /^ll_[\w-]{32}$/;

/** The scopes a person's roles grant (the union). */
export function scopesFor(roles: readonly Role[]): ApiScope[] {
  const out = new Set<ApiScope>();
  for (const role of roles) for (const scope of SCOPES_BY_ROLE[role]) out.add(scope);
  return [...out];
}

/** How the audit log names the principal. A person by email (or subject id), a key by its name. */
export function actorOf(p: Principal): { actor: string; actorKind: ActorKind } {
  switch (p.kind) {
    case 'person':
      return { actor: p.email ?? p.id, actorKind: 'person' };
    case 'key':
      return { actor: `key:${p.name}`, actorKind: 'key' };
    case 'bootstrap':
      return { actor: 'bootstrap key', actorKind: 'key' };
    case 'dev':
      return { actor: 'local developer', actorKind: 'person' };
  }
}

export const DEV_PRINCIPAL: Principal = {
  kind: 'dev',
  id: 'dev',
  name: 'Local developer',
  email: null,
  roles: ['controller'],
  groups: [],
  scopes: ['admin', 'read', 'requests:write'],
};

const sameString = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Who is calling. An `Authorization: Bearer` key wins (and must be valid); else the console's session cookie; else,
 * with LANDLEDGER_DEV_AUTH=on only, the local developer. Keys and sessions are stored as sha256; the bootstrap key is
 * compared in constant time. Null when nobody is signed in.
 */
export async function identify(
  sql: Sql,
  config: Config,
  input: { authorization?: string; sessionToken?: string },
): Promise<Principal | null> {
  const match = input.authorization?.match(/^Bearer\s+(\S+)$/i);
  if (input.authorization !== undefined) {
    if (!match) throw new ApiError('unauthorized', 'Send an API key as Authorization: Bearer ll_…');
    const key = match[1]!;
    if (config.bootstrapKey && sameString(key, config.bootstrapKey))
      return {
        kind: 'bootstrap',
        id: 'bootstrap',
        name: 'Bootstrap key',
        email: null,
        roles: [],
        groups: [],
        scopes: ['admin'],
      };
    if (KEY_PATTERN.test(key)) {
      const [row] = await sql<{ id: string; name: string; scopes: ApiScope[] }[]>`
        UPDATE api_keys SET last_used_at = now()
        WHERE hash = ${sha256(key)} AND revoked_at IS NULL
        RETURNING id, name, scopes`;
      if (row)
        return { kind: 'key', id: row.id, name: row.name, email: null, roles: [], groups: [], scopes: row.scopes };
    }
    throw new ApiError('unauthorized', 'The API key is not valid');
  }
  if (input.sessionToken) {
    const id = sha256(input.sessionToken);
    const [row] = await sql<{ user_id: string; name: string; email: string | null; roles: Role[]; groups: string[] }[]>`
      WITH s AS (
        UPDATE sessions SET last_seen_at = now()
        WHERE id = ${id} AND revoked_at IS NULL AND expires_at > now()
        RETURNING user_id)
      SELECT u.id AS user_id, u.name, u.email, u.roles, u.groups FROM s JOIN users u ON u.id = s.user_id`;
    if (row)
      return {
        kind: 'person',
        id: row.user_id,
        name: row.name,
        email: row.email,
        roles: row.roles,
        groups: row.groups,
        scopes: scopesFor(row.roles),
        sessionId: id,
      };
  }
  return config.devAuth ? DEV_PRINCIPAL : null;
}

export function requireScope(principal: Principal, scope: ApiScope): void {
  if (principal.scopes.includes('admin') || principal.scopes.includes(scope)) return;
  throw new ApiError('forbidden', `This needs the ${scope} scope`);
}

export function meOf(p: Principal, config: Config): Me {
  return {
    kind: p.kind,
    user: { id: p.id, name: p.name, email: p.email, roles: p.roles, groups: p.groups },
    scopes: p.scopes,
    authMode: config.devAuth ? 'dev' : 'oidc',
  };
}
