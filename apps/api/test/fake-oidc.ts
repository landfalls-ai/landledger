import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { OidcConfig } from '../src/config.js';

export const ISSUER = 'http://landbright.test/oidc';
export const CLIENT_ID = 'landledger-local';
export const CLIENT_SECRET = 'test-secret-not-real';

export const oidcConfig: OidcConfig = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: 'http://localhost:4811/api/auth/oidc/callback',
  postLogoutRedirectUri: 'http://localhost:4811/',
  scopes: 'openid email profile roles',
};

export interface Person {
  sub: string;
  email?: string;
  name?: string;
  roles?: string[];
}

/**
 * A fake Landbright for tests: discovery, JWKS, the token endpoint (checks client_secret_post, the redirect URI and the
 * PKCE verifier), userinfo and end_session. `authorize` stands in for the person signing in at Landbright: it takes the
 * authorization URL Landledger built and returns the code Landbright would send back. By default the ID token carries
 * only `sub` (as node-oidc-provider's does for the code flow) and the rest comes from userinfo.
 */
export async function fakeLandbright(options: { claimsInIdToken?: boolean; audience?: string; issuer?: string } = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { person: Person; nonce: string; challenge: string; redirectUri: string }>();
  const tokens = new Map<string, Person>();
  const calls: { url: string; body?: string }[] = [];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : (init?.body as string | undefined);
    calls.push({ url: url.toString(), body });
    if (!url.toString().startsWith(ISSUER)) throw new TypeError(`fetch failed: ${url}`);
    switch (url.pathname) {
      case '/oidc/.well-known/openid-configuration':
        return json({
          issuer: options.issuer ?? ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          userinfo_endpoint: `${ISSUER}/me`,
          end_session_endpoint: `${ISSUER}/session/end`,
        });
      case '/oidc/jwks':
        return json({ keys: [jwk] });
      case '/oidc/token': {
        const form = new URLSearchParams(body);
        if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET)
          return json({ error: 'invalid_client' }, 401);
        const grant = codes.get(form.get('code') ?? '');
        if (!grant) return json({ error: 'invalid_grant' }, 400);
        codes.delete(form.get('code')!);
        const challenge = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        if (challenge !== grant.challenge || form.get('redirect_uri') !== grant.redirectUri)
          return json({ error: 'invalid_grant' }, 400);
        const accessToken = randomBytes(16).toString('hex');
        tokens.set(accessToken, grant.person);
        const p = grant.person;
        const idToken = await new SignJWT({
          nonce: grant.nonce,
          ...(options.claimsInIdToken ? { email: p.email, name: p.name, roles: p.roles } : {}),
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(ISSUER)
          .setAudience(options.audience ?? CLIENT_ID)
          .setSubject(p.sub)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return json({ id_token: idToken, access_token: accessToken, token_type: 'Bearer', expires_in: 300 });
      }
      case '/oidc/me': {
        const person = tokens.get(
          (init?.headers as Record<string, string>)?.authorization?.replace('Bearer ', '') ?? '',
        );
        if (!person) return json({ error: 'invalid_token' }, 401);
        return json({ sub: person.sub, email: person.email, name: person.name, roles: person.roles });
      }
      default:
        return json({ error: 'not_found' }, 404);
    }
  };

  /** The person signs in at Landbright: returns the callback's query (code, state, iss). */
  function authorize(authorizationUrl: string, person: Person): { code: string; state: string; iss: string } {
    const u = new URL(authorizationUrl);
    const p = u.searchParams;
    if (
      p.get('client_id') !== CLIENT_ID ||
      p.get('response_type') !== 'code' ||
      p.get('code_challenge_method') !== 'S256'
    )
      throw new Error(`bad authorization request: ${authorizationUrl}`);
    const code = randomBytes(12).toString('hex');
    codes.set(code, {
      person,
      nonce: p.get('nonce')!,
      challenge: p.get('code_challenge')!,
      redirectUri: p.get('redirect_uri')!,
    });
    return { code, state: p.get('state')!, iss: ISSUER };
  }

  /** A back-channel logout token for a subject, as Landbright would post it (OIDC Back-Channel Logout 1.0). */
  async function logoutToken(
    sub: string,
    over: { jti?: string; events?: unknown; nonce?: string; audience?: string } = {},
  ) {
    return new SignJWT({
      events: over.events ?? { 'http://schemas.openid.net/event/backchannel-logout': {} },
      ...(over.nonce ? { nonce: over.nonce } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'logout+jwt' })
      .setIssuer(ISSUER)
      .setAudience(over.audience ?? CLIENT_ID)
      .setSubject(sub)
      .setJti(over.jti ?? randomBytes(8).toString('hex'))
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(privateKey);
  }

  return { fetchImpl, authorize, calls, logoutToken };
}
