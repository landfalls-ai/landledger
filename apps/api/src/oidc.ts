import { ROLE_BY_GROUP, type Role } from '@landledger/contracts';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, errors as joseErrors, type JSONWebKeySet, type JWTPayload, jwtVerify } from 'jose';
import type { OidcConfig } from './config.js';
import { ApiError } from './errors.js';
import { randomToken } from './ids.js';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

/** What Landledger keeps from a sign-in. */
export interface Identity {
  issuer: string;
  subject: string;
  email: string | null;
  name: string;
  /** Landbright group names (the `roles` claim), all of them. */
  groups: string[];
  /** The Landledger roles those groups map to. */
  roles: Role[];
  idToken: string;
}

/** PKCE (RFC 7636, S256): a random verifier and its challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The Landbright groups in a token or userinfo: the `roles` claim (Landbright puts group names there), else `groups`. */
export function groupsFromClaims(claims: Record<string, unknown>): string[] {
  const raw = Array.isArray(claims.roles) ? claims.roles : Array.isArray(claims.groups) ? claims.groups : [];
  return [...new Set(raw.filter((g): g is string => typeof g === 'string'))];
}

const ROLE_BY_LOWER = new Map(Object.entries(ROLE_BY_GROUP).map(([g, r]) => [g.toLowerCase(), r]));

/**
 * Group names → Landledger roles, without case (SCIM's display names may differ in case); groups Landledger doesn't
 * know (Everyone, …) are ignored.
 */
export function rolesFromGroups(groups: readonly string[]): Role[] {
  const roles = new Set<Role>();
  for (const g of groups) {
    const role = ROLE_BY_LOWER.get(g.toLowerCase());
    if (role) roles.add(role);
  }
  return [...roles].sort();
}

const fail = (message: string) => new ApiError('unauthorized', `Sign-in failed: ${message}`);

/**
 * Landledger as an OIDC relying party of Landbright: authorization code with PKCE (S256), the client secret sent in
 * the token request body (client_secret_post), the ID token verified against the issuer's JWKS (issuer, audience,
 * expiry, nonce). Claims missing from the ID token (email, name, roles) come from userinfo.
 */
export class OidcClient {
  private meta: Promise<Discovery> | null = null;
  private keys: ReturnType<typeof createLocalJWKSet> | null = null;

  constructor(
    readonly config: OidcConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new ApiError('unavailable', `Landbright didn't answer (${(e as Error).message})`);
    }
    const text = await res.text();
    if (!res.ok) throw fail(`${new URL(url).pathname} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw fail(`${new URL(url).pathname} didn't answer JSON`);
    }
  }

  discovery(): Promise<Discovery> {
    this.meta ??= this.json<Discovery>(`${this.config.issuer}/.well-known/openid-configuration`)
      .then((d) => {
        if (d.issuer !== this.config.issuer) throw fail(`the issuer says it is ${d.issuer}, not ${this.config.issuer}`);
        return d;
      })
      .catch((e: unknown) => {
        this.meta = null; // try again next time
        throw e;
      });
    return this.meta;
  }

  private async jwks(refresh = false): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (!this.keys || refresh) {
      const d = await this.discovery();
      this.keys = createLocalJWKSet(await this.json<JSONWebKeySet>(d.jwks_uri));
    }
    return this.keys;
  }

  async authorizationUrl(input: { state: string; nonce: string; challenge: string }): Promise<string> {
    const d = await this.discovery();
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes,
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.challenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  /** Exchanges the code, verifies the ID token, fills in from userinfo, maps groups to roles. */
  async signIn(input: { code: string; verifier: string; nonce: string }): Promise<Identity> {
    const d = await this.discovery();
    const tokens = await this.json<{ id_token?: string; access_token?: string; token_type?: string }>(
      d.token_endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: this.config.redirectUri,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code_verifier: input.verifier,
        }),
      },
    );
    if (!tokens.id_token) throw fail('no ID token in the token response');
    const claims = await this.verifyIdToken(tokens.id_token, input.nonce);
    let merged: Record<string, unknown> = { ...claims };
    const missing = !merged.email || !merged.name || groupsFromClaims(merged).length === 0;
    if (missing && d.userinfo_endpoint && tokens.access_token) {
      const info = await this.json<Record<string, unknown>>(d.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
      });
      if (info.sub !== claims.sub) throw fail('userinfo is for someone else');
      merged = { ...info, ...claims, roles: claims.roles ?? info.roles, groups: claims.groups ?? info.groups };
    }
    const groups = groupsFromClaims(merged);
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const email = str(merged.email);
    return {
      issuer: this.config.issuer,
      subject: claims.sub!,
      email,
      name: str(merged.name) ?? str(merged.preferred_username) ?? email ?? claims.sub!,
      groups,
      roles: rolesFromGroups(groups),
      idToken: tokens.id_token,
    };
  }

  async verifyIdToken(idToken: string, nonce: string): Promise<JWTPayload> {
    const verify = async (refresh: boolean) =>
      jwtVerify(idToken, await this.jwks(refresh), {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        clockTolerance: 30,
      });
    let payload: JWTPayload;
    try {
      payload = (await verify(false)).payload;
    } catch (e) {
      if (!(e instanceof joseErrors.JWKSNoMatchingKey))
        throw fail(`the ID token isn't valid (${(e as Error).message})`);
      try {
        payload = (await verify(true)).payload; // the issuer rotated its keys
      } catch (e2) {
        throw fail(`the ID token isn't valid (${(e2 as Error).message})`);
      }
    }
    if (payload.nonce !== nonce) throw fail('the ID token is for another sign-in (nonce)');
    if (!payload.sub) throw fail('the ID token names nobody (sub)');
    return payload;
  }

  /**
   * A back-channel logout token (OpenID Connect Back-Channel Logout 1.0, section 2.6): signed by the issuer for this
   * client, with `iat`, `jti`, the back-channel logout event, a `sub` (Landledger keeps no `sid`), and no `nonce`.
   */
  async verifyLogoutToken(token: string): Promise<{ sub: string; jti: string; sid: string | null; iat: Date }> {
    const verify = async (refresh: boolean) =>
      jwtVerify(token, await this.jwks(refresh), {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        clockTolerance: 30,
        maxTokenAge: '10m',
      });
    let payload: JWTPayload;
    try {
      payload = (await verify(false)).payload;
    } catch (e) {
      if (!(e instanceof joseErrors.JWKSNoMatchingKey))
        throw fail(`the logout token isn't valid (${(e as Error).message})`);
      try {
        payload = (await verify(true)).payload;
      } catch (e2) {
        throw fail(`the logout token isn't valid (${(e2 as Error).message})`);
      }
    }
    const events = payload.events as Record<string, unknown> | undefined;
    if (!events || typeof events !== 'object' || !('http://schemas.openid.net/event/backchannel-logout' in events))
      throw fail('the logout token carries no back-channel logout event');
    if ('nonce' in payload) throw fail('a logout token never carries a nonce');
    if (typeof payload.jti !== 'string' || !payload.jti) throw fail('the logout token has no jti');
    if (typeof payload.iat !== 'number') throw fail('the logout token has no iat');
    if (typeof payload.sub !== 'string' || !payload.sub)
      throw fail('the logout token names no sub: Landledger ends sessions by subject');
    return {
      sub: payload.sub,
      jti: payload.jti,
      sid: typeof payload.sid === 'string' ? payload.sid : null,
      iat: new Date(payload.iat * 1000),
    };
  }

  /** Where to send the browser to end the Landbright session too (RP-initiated logout), if Landbright offers it. */
  async endSessionUrl(idToken: string | null): Promise<string | null> {
    const d = await this.discovery().catch(() => null);
    if (!d?.end_session_endpoint) return null;
    const url = new URL(d.end_session_endpoint);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('post_logout_redirect_uri', this.config.postLogoutRedirectUri);
    if (idToken) url.searchParams.set('id_token_hint', idToken);
    return url.toString();
  }
}
