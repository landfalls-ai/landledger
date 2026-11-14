import { ROLE_BY_GROUP } from '@landledger/contracts';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuditLog } from './audit.js';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { ApiError } from './errors.js';
import { newId, randomToken, sha256 } from './ids.js';
import { type Identity, type OidcClient, pkcePair } from './oidc.js';
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
export type SignInError = 'no_role' | 'expired' | 'denied' | 'failed' | 'unavailable';

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

    if (identity.roles.length === 0) {
      await this.audit.append({
        actor: identity.email ?? identity.subject,
        actorKind: 'person',
        action: 'auth.refused',
        subjectType: 'user',
        subjectId: identity.subject,
        data: { reason: 'no Landledger group', groups: identity.groups },
      });
      return { error: 'no_role', returnTo: pending.return_to };
    }

    const token = randomToken(32);
    const sessionId = sha256(token);
    await this.sql.begin(async (tx) => {
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO users (id, issuer, subject, email, name, roles, groups)
        VALUES (${newId('usr')}, ${identity.issuer}, ${identity.subject}, ${identity.email}, ${identity.name},
                ${identity.roles}, ${identity.groups})
        ON CONFLICT (issuer, subject) DO UPDATE SET
          email = EXCLUDED.email, name = EXCLUDED.name, roles = EXCLUDED.roles, groups = EXCLUDED.groups,
          last_seen_at = now()
        RETURNING id`;
      for (const group of identity.groups)
        await tx`
          INSERT INTO groups (name, role) VALUES (${group}, ${ROLE_BY_GROUP[group] ?? null})
          ON CONFLICT (name) DO UPDATE SET last_seen_at = now(), role = EXCLUDED.role`;
      await tx`
        INSERT INTO sessions (id, user_id, expires_at, id_token, user_agent)
        VALUES (${sessionId}, ${user!.id}, now() + make_interval(hours => ${this.config.sessionHours}),
                ${this.box ? this.box.seal(identity.idToken, sessionAad(sessionId)) : null},
                ${input.userAgent?.slice(0, 300) ?? null})`;
      await this.audit.append(
        {
          actor: identity.email ?? identity.subject,
          actorKind: 'person',
          action: 'auth.signed_in',
          subjectType: 'user',
          subjectId: user!.id,
          data: { roles: identity.roles, groups: identity.groups },
        },
        tx,
      );
    });
    return { token, returnTo: pending.return_to, identity };
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
