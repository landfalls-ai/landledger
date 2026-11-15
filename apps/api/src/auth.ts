import { ROLE_BY_GROUP } from '@landledger/contracts';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuditLog } from './audit.js';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { ApiError } from './errors.js';
import { newId, randomToken, sha256 } from './ids.js';
import { type Identity, type OidcClient, pkcePair, rolesFromGroups } from './oidc.js';
import { isSealed, type SecretBox, sessionAad } from './secrets.js';
import { actorOf, identify, meOf, type Principal, SESSION_COOKIE } from './principal.js';

const LOGIN_COOKIE = 'll_login';
const LOGIN_TTL_S = 600;

/** Only a path on this site: `/x?y`, never `//host` or a full URL. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\'))
    return '/';
  return value.slice(0, 2000);
}

/** Why a sign-in came back to the console without a session (`/?signin_error=<code>`). */
export type SignInError = 'no_role' | 'inactive' | 'expired' | 'denied' | 'failed' | 'unavailable';

/**
 * Console sessions: sign-in through Landbright, then a random token in an httpOnly cookie; Postgres keeps its sha256,
 * the user and their roles from the groups claim. Each sign-in, refusal and sign-out is in the audit log.
 */
export class Sessions {
  constructor(
    private readonly sql: Sql,
    private readonly config: Config,
    private readonly audit: AuditLog,
    private readonly oidc: OidcClient | null,
    /** Seals the ID token kept for sign-out (secrets.ts); without it no ID token is kept. */
    private readonly box: SecretBox | null = null,
  ) {}

  private client(): OidcClient {
    if (!this.oidc)
      throw new ApiError('unavailable', `Sign-in with Landbright isn't set up: ${this.config.oidcProblem}`);
    return this.oidc;
  }

  async startLogin(returnTo: string): Promise<{ url: string; state: string }> {
    const oidc = this.client();
    const state = randomToken(24);
    const nonce = randomToken(24);
    const { verifier, challenge } = pkcePair();
    await this.sql`
      INSERT INTO auth_requests (state_hash, code_verifier, nonce, return_to, expires_at)
      VALUES (${sha256(state)}, ${verifier}, ${nonce}, ${returnTo}, now() + make_interval(secs => ${LOGIN_TTL_S}))`;
    return { url: await oidc.authorizationUrl({ state, nonce, challenge }), state };
  }

  /** The callback: checks the state (and that this browser started it), signs in, opens a session. */
  async finishLogin(input: {
    state: string;
    code: string;
    iss?: string;
    browserState?: string;
    userAgent?: string;
  }): Promise<{ token: string; returnTo: string; identity: Identity } | { error: SignInError; returnTo: string }> {
    const oidc = this.client();
    const [pending] = await this.sql<{ code_verifier: string; nonce: string; return_to: string; live: boolean }[]>`
      DELETE FROM auth_requests WHERE state_hash = ${sha256(input.state)}
      RETURNING code_verifier, nonce, return_to, expires_at > now() AS live`;
    if (!pending || !pending.live || input.browserState !== input.state) return { error: 'expired', returnTo: '/' };
    if (input.iss !== undefined && input.iss !== oidc.config.issuer) return { error: 'failed', returnTo: '/' };
    const identity = await oidc.signIn({ code: input.code, verifier: pending.code_verifier, nonce: pending.nonce });

    const result = await this.reconcile(identity, input.userAgent);
    if ('error' in result) {
      await this.audit.append({
        actor: identity.email ?? identity.subject,
        actorKind: 'person',
        action: 'auth.refused',
        subjectType: 'user',
        subjectId: result.userId ?? identity.subject,
        data: {
          reason:
            result.error === 'inactive'
              ? 'deactivated'
              : result.error === 'no_role'
                ? 'no Landledger group'
                : 'email taken by another subject',
          groups: identity.groups,
        },
      });
      return { error: result.error, returnTo: pending.return_to };
    }
    const token = result.token;
    return { token, returnTo: pending.return_to, identity };
  }

  /**
   * Sign-in meets SCIM (docs/identity.md, Clickland's rules): find the person by subject, else by email when SCIM made
   * them without a subject yet (`scim:` placeholder), else create them just in time. SCIM owns the profile once it has
   * spoken (`scim_managed`) and the groups once it has set them (`scim_groups_at`); the claim is kept either way. An
   * inactive person, or one in no Landledger group, gets no session.
   */
  async reconcile(
    identity: Identity,
    userAgent?: string,
  ): Promise<{ token: string; userId: string } | { error: 'no_role' | 'inactive' | 'failed'; userId: string | null }> {
    const token = randomToken(32);
    const sessionId = sha256(token);
    const refused = Symbol('refused');
    let outcome: { error: 'no_role' | 'inactive' | 'failed'; userId: string | null } = {
      error: 'failed',
      userId: null,
    };
    try {
      return (await this.sql.begin(async (tx) => {
        type U = { id: string; scim_managed: boolean; subject: string; deleted_at: Date | null };
        let [user] = await tx<U[]>`
          SELECT id, scim_managed, subject, deleted_at FROM users
          WHERE issuer = ${identity.issuer} AND subject = ${identity.subject} FOR UPDATE`;
        if (!user && identity.email) {
          const [byEmail] = await tx<U[]>`
            SELECT id, scim_managed, subject, deleted_at FROM users
            WHERE kind = 'person' AND deleted_at IS NULL
              AND (lower(user_name) = lower(${identity.email}) OR lower(email) = lower(${identity.email}))
            ORDER BY (subject LIKE 'scim:%') DESC LIMIT 1 FOR UPDATE`;
          if (byEmail && !byEmail.subject.startsWith('scim:')) {
            outcome = { error: 'failed', userId: byEmail.id }; // the email belongs to another Landbright subject
            throw refused;
          }
          if (byEmail) {
            await tx`UPDATE users SET issuer = ${identity.issuer}, subject = ${identity.subject}, updated_at = now()
                     WHERE id = ${byEmail.id}`;
            user = byEmail;
          }
        }
        if (user?.deleted_at) {
          outcome = { error: 'inactive', userId: user.id };
          throw refused;
        }
        if (!user) {
          [user] = await tx<U[]>`
            INSERT INTO users (id, issuer, subject, email, name, roles, groups, user_name)
            VALUES (${newId('usr')}, ${identity.issuer}, ${identity.subject}, ${identity.email}, ${identity.name},
                    ${identity.roles}, ${identity.groups}, ${identity.email})
            RETURNING id, scim_managed, subject, deleted_at`;
        } else if (!user.scim_managed) {
          await tx`UPDATE users SET email = ${identity.email}, name = ${identity.name}, updated_at = now() WHERE id = ${user.id}`;
        }
        const [row] = await tx<{ id: string; active: boolean; groups: string[] }[]>`
          UPDATE users u SET groups = ${identity.groups}, last_seen_at = now()
          WHERE u.id = ${user!.id}
          RETURNING u.id, u.active, landledger_effective_groups(u) AS groups`;
        if (!row!.active) {
          outcome = { error: 'inactive', userId: row!.id };
          throw refused;
        }
        const roles = rolesFromGroups(row!.groups);
        if (!roles.length) {
          outcome = { error: 'no_role', userId: row!.id };
          throw refused;
        }
        await tx`UPDATE users SET roles = ${roles} WHERE id = ${row!.id}`;
        for (const group of identity.groups)
          await tx`
            INSERT INTO groups (name, role) VALUES (${group}, ${ROLE_BY_GROUP[group] ?? null})
            ON CONFLICT (name) DO UPDATE SET last_seen_at = now(), role = EXCLUDED.role`;
        await tx`
          INSERT INTO sessions (id, user_id, expires_at, id_token, user_agent)
          VALUES (${sessionId}, ${row!.id}, now() + make_interval(hours => ${this.config.sessionHours}),
                  ${this.box ? this.box.seal(identity.idToken, sessionAad(sessionId)) : null},
                  ${userAgent?.slice(0, 300) ?? null})`;
        await this.audit.append(
          {
            actor: identity.email ?? identity.subject,
            actorKind: 'person',
            action: 'auth.signed_in',
            subjectType: 'user',
            subjectId: row!.id,
            data: { roles, groups: row!.groups },
          },
          tx,
        );
        return { token, userId: row!.id };
      })) as { token: string; userId: string };
    } catch (e) {
      if (e === refused) return outcome;
      throw e;
    }
  }

  /** Ends the session here; returns where to send the browser so Landbright ends its session too. */
  async logout(principal: Principal | null): Promise<string> {
    let idToken: string | null = null;
    if (principal?.kind === 'person' && principal.sessionId) {
      const [row] = await this.sql<{ id_token: string | null }[]>`
        UPDATE sessions SET revoked_at = now() WHERE id = ${principal.sessionId} AND revoked_at IS NULL
        RETURNING id_token`;
      const stored = row?.id_token ?? null;
      // A sealed token opens with its own session id only; a token that won't open just leaves out the hint.
      idToken =
        stored && this.box && isSealed(stored)
          ? (() => {
              try {
                return this.box.open(stored, sessionAad(principal.sessionId!));
              } catch {
                return null;
              }
            })()
          : null;
      await this.audit.append({
        ...actorOf(principal),
        action: 'auth.signed_out',
        subjectType: 'user',
        subjectId: principal.id,
      });
    }
    return (await this.oidc?.endSessionUrl(idToken)) ?? `${this.config.consoleUrl}/`;
  }

  /**
   * Back-channel logout (OpenID Connect Back-Channel Logout 1.0): Landbright posts a signed logout token when a person
   * signs out there or is disabled. Every validly signed token ends that person's sessions created before its `iat`
   * (to the second it names, as `iat` has no finer grain: ending one too many is the safe side), which is idempotent: a retry, or a later token for the same sign-out, ends nothing new, and a session signed in
   * after the token was issued stays. Landbright signs each delivery attempt afresh (a new random `jti` and `iat`), so a
   * `jti` seen before is not a Landbright retry; it still answers 200, still ends sessions created before its `iat`, and
   * is audited as `auth.backchannel_logout_replay`. Each token's SHA-256 and `iat` are kept for the audit (never the
   * token itself).
   */
  async backchannelLogout(token: string): Promise<{ sessions: number; replay: boolean }> {
    const { sub, jti, sid, iat } = await this.client().verifyLogoutToken(token);
    const tokenSha256 = sha256(token);
    return this.sql.begin(async (tx) => {
      const fresh = await tx`
        INSERT INTO logout_tokens (jti, sub, token_sha256, iat) VALUES (${jti}, ${sub}, ${tokenSha256}, ${iat})
        ON CONFLICT DO NOTHING RETURNING 1`;
      const ended = await tx<{ user_id: string }[]>`
        UPDATE sessions SET revoked_at = now()
        WHERE revoked_at IS NULL AND created_at < ${new Date(iat.getTime() + 1000)}
          AND user_id IN (SELECT id FROM users WHERE subject = ${sub})
        RETURNING user_id`;
      const [u] = await tx<{ id: string; email: string | null }[]>`SELECT id, email FROM users WHERE subject = ${sub}`;
      // A row from before the hash was kept (or with no sub) is just an earlier sighting.
      const [seen] = fresh.length
        ? []
        : await tx<{ sub: string | null; seen_at: Date; token_sha256: string | null }[]>`
            SELECT sub, seen_at, token_sha256 FROM logout_tokens WHERE jti = ${jti}`;
      await this.audit.append(
        {
          actor: 'landbright',
          actorKind: 'system',
          action: fresh.length ? 'auth.backchannel_logout' : 'auth.backchannel_logout_replay',
          subjectType: 'user',
          subjectId: u?.id ?? sub,
          data: {
            sub,
            sid,
            jti,
            iat: iat.toISOString(),
            tokenSha256,
            sessions: ended.length,
            person: u?.email ?? null,
            ...(seen
              ? {
                  firstSeenAt: seen.seen_at.toISOString(),
                  firstSub: seen.sub,
                  sameToken: seen.token_sha256 === null ? null : seen.token_sha256 === tokenSha256,
                }
              : {}),
          },
        },
        tx,
      );
      return { sessions: ended.length, replay: !fresh.length };
    });
  }

  /** Forgets sign-ins that never came back and sessions long expired. */
  async cleanup(): Promise<number> {
    const a = await this.sql`DELETE FROM auth_requests WHERE expires_at < now()`;
    const s = await this.sql`DELETE FROM sessions WHERE expires_at < now() - interval '30 days'`;
    return a.count + s.count;
  }
}

const Callback = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(500).optional(),
  iss: z.string().max(500).optional(),
  error: z.string().max(200).optional(),
});

/** The sign-in routes: login, the OIDC callback, logout and me. They are public; each checks what it needs. */
export function registerAuthRoutes(app: FastifyInstance, deps: { sql: Sql; config: Config; sessions: Sessions }): void {
  const { sql, config, sessions } = deps;
  const secure = config.consoleUrl.startsWith('https://');
  const cookieBase = { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };

  const backToConsole = (reply: FastifyReply, error: SignInError, returnTo = '/') =>
    reply
      .clearCookie(LOGIN_COOKIE, { ...cookieBase, path: '/api/auth' })
      .redirect(`${returnTo === '/' ? '/' : returnTo}${returnTo.includes('?') ? '&' : '?'}signin_error=${error}`);

  app.get('/api/auth/login', async (request, reply) => {
    const returnTo = safeReturnTo((request.query as { returnTo?: unknown }).returnTo);
    const { url, state } = await sessions.startLogin(returnTo);
    return reply
      .setCookie(LOGIN_COOKIE, state, { ...cookieBase, path: '/api/auth', maxAge: LOGIN_TTL_S })
      .redirect(url);
  });

  app.get('/api/auth/oidc/callback', async (request, reply) => {
    const parsed = Callback.safeParse(request.query);
    if (!parsed.success) return backToConsole(reply, 'failed');
    const q = parsed.data;
    if (q.error) return backToConsole(reply, q.error === 'access_denied' ? 'denied' : 'failed');
    if (!q.code || !q.state) return backToConsole(reply, 'failed');
    try {
      const result = await sessions.finishLogin({
        state: q.state,
        code: q.code,
        iss: q.iss,
        browserState: request.cookies[LOGIN_COOKIE],
        userAgent: request.headers['user-agent'],
      });
      if ('error' in result) return backToConsole(reply, result.error, result.returnTo);
      return reply
        .clearCookie(LOGIN_COOKIE, { ...cookieBase, path: '/api/auth' })
        .setCookie(SESSION_COOKIE, result.token, { ...cookieBase, maxAge: config.sessionHours * 3600 })
        .redirect(result.returnTo);
    } catch (error) {
      request.log.warn({ err: error }, 'sign-in failed');
      return backToConsole(reply, error instanceof ApiError && error.code === 'unavailable' ? 'unavailable' : 'failed');
    }
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const principal = await identify(sql, config, { sessionToken: request.cookies[SESSION_COOKIE] }).catch(() => null);
    const redirect = await sessions.logout(principal);
    return reply.clearCookie(SESSION_COOKIE, cookieBase).send({ redirect });
  });

  // OpenID Connect Back-Channel Logout 1.0: Landbright posts `logout_token` (form-encoded); 200 when the person's
  // sessions here are ended, or when a verified token's jti was already processed (a retry: nothing more ends);
  // 400 with `invalid_request` when the token doesn't verify. Register this path with Landbright.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded'))
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
  app.post('/api/auth/backchannel-logout', async (request, reply) => {
    const token = (request.body as { logout_token?: unknown } | null)?.logout_token;
    reply.header('cache-control', 'no-store');
    if (typeof token !== 'string' || !token)
      return reply.status(400).send({ error: 'invalid_request', error_description: 'logout_token is missing' });
    try {
      await sessions.backchannelLogout(token);
      return reply.status(200).send();
    } catch (error) {
      request.log.warn({ err: error }, 'back-channel logout refused');
      const message = error instanceof Error ? error.message : 'the logout token is not valid';
      return reply.status(400).send({ error: 'invalid_request', error_description: message });
    }
  });

  app.get('/api/auth/me', async (request) => {
    const principal = await identify(sql, config, {
      authorization: request.headers.authorization,
      sessionToken: request.cookies[SESSION_COOKIE],
    });
    if (!principal)
      throw new ApiError('unauthorized', 'Sign in with Landbright', {
        signIn: config.oidc ? 'available' : 'unavailable',
        ...(config.oidcProblem ? { problem: config.oidcProblem } : {}),
      });
    return meOf(principal, config);
  });
}
