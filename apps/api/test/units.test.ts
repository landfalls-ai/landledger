import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainHash, GENESIS } from '../src/audit.js';
import { safeReturnTo } from '../src/auth.js';
import { canonicalJson } from '../src/canonical.js';
import { configFromEnv } from '../src/config.js';
import { newApiKey } from '../src/keys.js';
import { groupsFromClaims, OidcClient, pkcePair, rolesFromGroups } from '../src/oidc.js';
import { KEY_PATTERN, scopesFor } from '../src/principal.js';
import { signWebhook } from '../src/webhooks.js';
import { CLIENT_SECRET, fakeLandbright, oidcConfig } from './fake-oidc.js';

describe('canonical JSON', () => {
  it('sorts keys at every depth and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [true, null], c: 'x' } })).toBe('{"a":{"c":"x","d":[true,null]},"b":1}');
  });

  it('refuses what jsonb would not give back exactly', () => {
    expect(() => canonicalJson({ amount: 0.1 })).toThrow(/safe integers/);
    expect(() => canonicalJson({ n: 2 ** 60 })).toThrow(/safe integers/);
    expect(() => canonicalJson({ big: 1n })).toThrow(/bigint/);
    expect(() => canonicalJson({ at: new Date() })).toThrow(/plain objects/);
    expect(() => canonicalJson({ x: undefined })).toThrow(/undefined/);
  });
});

describe('the audit hash chain', () => {
  const entry = {
    seq: 1,
    at: '2026-11-14T10:00:00.000Z',
    actor: 'seed',
    actorKind: 'system' as const,
    action: 'rate_card.created',
    subjectType: 'rate_card',
    subjectId: 'rc_internal',
    data: { currency: 'USD' },
  };

  it('is sha256(prev_hash ‖ canonical_json(entry))', () => {
    const h = chainHash(GENESIS, entry);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(chainHash(GENESIS, { ...entry, data: { currency: 'USD' } })).toBe(h);
    expect(chainHash(GENESIS, { ...entry, actor: 'someone else' })).not.toBe(h);
    expect(chainHash(h, { ...entry, seq: 2 })).not.toBe(chainHash(GENESIS, { ...entry, seq: 2 }));
  });
});

describe('API keys', () => {
  it('look like ll_ and 32 characters, and keep only a hash and a prefix', () => {
    const { key, prefix, hash } = newApiKey();
    expect(key).toMatch(KEY_PATTERN);
    expect(prefix).toBe(key.slice(0, 11));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key);
  });
});

describe('roles from Landbright groups', () => {
  it('maps the finance groups, ignores the rest, and reads roles before groups', () => {
    expect(rolesFromGroups(['Finance Controllers', 'Everyone', 'Engineering'])).toEqual(['controller', 'engineer']);
    expect(rolesFromGroups(['Everyone'])).toEqual([]);
    expect(groupsFromClaims({ roles: ['Finance CFO', 'Finance CFO', 7], groups: ['x'] })).toEqual(['Finance CFO']);
    expect(groupsFromClaims({ groups: ['Budget Owners'] })).toEqual(['Budget Owners']);
    expect(scopesFor(['auditor'])).toEqual(['read']);
    expect(scopesFor(['engineer', 'controller']).sort()).toEqual(['admin', 'read', 'requests:write']);
  });
});

describe('sign-in helpers', () => {
  it('only returns to a path on this site', () => {
    expect(safeReturnTo('/rules?x=1')).toBe('/rules?x=1');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo('/\\evil.example')).toBe('/');
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo(undefined)).toBe('/');
  });

  it('makes a PKCE S256 pair', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[\w-]{43}$/);
  });
});

describe('the OIDC client against a fake Landbright', () => {
  async function signIn(
    fake: Awaited<ReturnType<typeof fakeLandbright>>,
    person = { sub: 'u1', email: 'tal.levi@landbright.test', name: 'Tal Levi', roles: ['Engineering', 'Everyone'] },
  ) {
    const client = new OidcClient(oidcConfig, fake.fetchImpl);
    const { verifier, challenge } = pkcePair();
    const url = await client.authorizationUrl({ state: 's1', nonce: 'n1', challenge });
    const { code } = fake.authorize(url, person);
    return { client, identity: await client.signIn({ code, verifier, nonce: 'n1' }), url };
  }

  it('builds the authorization request: code, PKCE S256, the scopes and the redirect', async () => {
    const { url } = await signIn(await fakeLandbright());
    const p = new URL(url).searchParams;
    expect(p.get('scope')).toBe('openid email profile roles');
    expect(p.get('redirect_uri')).toBe('http://localhost:4811/api/auth/oidc/callback');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.has('client_secret')).toBe(false);
  });

  it('sends the secret in the token request body (client_secret_post), and fills claims from userinfo', async () => {
    const fake = await fakeLandbright();
    const { identity } = await signIn(fake);
    const token = fake.calls.find((c) => c.url.endsWith('/token'))!;
    expect(new URLSearchParams(token.body).get('client_secret')).toBe(CLIENT_SECRET);
    expect(fake.calls.some((c) => c.url.endsWith('/me'))).toBe(true);
    expect(identity).toMatchObject({
      subject: 'u1',
      email: 'tal.levi@landbright.test',
      name: 'Tal Levi',
      roles: ['engineer'],
    });
    expect(identity.groups).toEqual(['Engineering', 'Everyone']);
  });

  it('skips userinfo when the ID token carries the claims', async () => {
    const fake = await fakeLandbright({ claimsInIdToken: true });
    const { identity } = await signIn(fake);
    expect(identity.roles).toEqual(['engineer']);
    expect(fake.calls.some((c) => c.url.endsWith('/me'))).toBe(false);
  });

  it('refuses an ID token for another client, another sign-in, or from another issuer', async () => {
    await expect(signIn(await fakeLandbright({ audience: 'someone-else' }))).rejects.toThrow(/ID token isn't valid/);
    await expect(signIn(await fakeLandbright({ issuer: 'http://evil.test/oidc' }))).rejects.toThrow(/issuer says/);
    const fake = await fakeLandbright();
    const client = new OidcClient(oidcConfig, fake.fetchImpl);
    const { verifier, challenge } = pkcePair();
    const { code } = fake.authorize(await client.authorizationUrl({ state: 's', nonce: 'right', challenge }), {
      sub: 'u',
    });
    await expect(client.signIn({ code, verifier, nonce: 'wrong' })).rejects.toThrow(/nonce/);
  });

  it('builds the logout URL with the ID token hint and the post-logout redirect', async () => {
    const { client, identity } = await signIn(await fakeLandbright());
    const url = new URL((await client.endSessionUrl(identity.idToken))!);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:4811/');
    expect(url.searchParams.get('id_token_hint')).toBe(identity.idToken);
  });
});

describe('configuration', () => {
  const file = () => {
    const dir = mkdtempSync(join(tmpdir(), 'll-oidc-'));
    const path = join(dir, 'landledger-local.env');
    writeFileSync(
      path,
      '# test\nLANDBRIGHT_ISSUER=http://localhost:4402/oidc\nLANDBRIGHT_CLIENT_ID=landledger-local\nLANDBRIGHT_CLIENT_SECRET=s3cret\nLANDBRIGHT_TOKEN_ENDPOINT_AUTH_METHOD=client_secret_post\n',
    );
    return path;
  };

  it('reads the Landbright client file, and says why sign-in is off without it', () => {
    const on = configFromEnv({ LANDLEDGER_OIDC_ENV_FILE: file() });
    expect(on.oidc).toMatchObject({
      issuer: 'http://localhost:4402/oidc',
      clientId: 'landledger-local',
      clientSecret: 's3cret',
    });
    expect(on.oidc!.redirectUri).toBe('http://localhost:4811/api/auth/oidc/callback');
    const off = configFromEnv({ LANDLEDGER_OIDC_ENV_FILE: '/nowhere/landledger-local.env' });
    expect(off.oidc).toBeNull();
    expect(off.oidcProblem).toMatch(/doesn't exist yet/);
  });

  it('keeps the dev bypass off by default and on loopback only', () => {
    expect(configFromEnv({}).devAuth).toBe(false);
    expect(configFromEnv({ LANDLEDGER_DEV_AUTH: 'on' }).devAuth).toBe(true);
    expect(() => configFromEnv({ LANDLEDGER_DEV_AUTH: 'on', LANDLEDGER_API_HOST: '0.0.0.0' })).toThrow(
      /this machine only/,
    );
  });
});

describe('Standard Webhooks', () => {
  it('signs as the specification example does', () => {
    // https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md (example values)
    expect(
      signWebhook(
        'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
        'msg_p5jXN8AQM9LWM0D4loKWxJek',
        1614265330,
        '{"test": 2432232314}',
      ),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });
});

describe('business calendar (review of wave 2): days, time zone and holidays', () => {
  it('counts Sunday to Thursday in Asia/Jerusalem: Thursday 15:00 local plus 24 hours is Sunday 15:00 local', async () => {
    const { addBusinessHours } = await import('../src/business-hours.js');
    const { parseBusinessDays } = await import('../src/config.js');
    const days = parseBusinessDays('sun-thu');
    expect(days).toEqual([0, 1, 2, 3, 4]);
    // Thursday 19 November 2026, 15:00 in Jerusalem is 13:00 UTC (UTC+2 in November).
    const due = addBusinessHours(new Date('2026-11-19T13:00:00Z'), 24, { days, timeZone: 'Asia/Jerusalem' });
    expect(due.toISOString()).toBe('2026-11-22T13:00:00.000Z');
    // A holiday on Sunday 22 November moves it to Monday.
    const later = addBusinessHours(new Date('2026-11-19T13:00:00Z'), 24, {
      days,
      timeZone: 'Asia/Jerusalem',
      holidays: new Set(['2026-11-22']),
    });
    expect(later.toISOString()).toBe('2026-11-23T13:00:00.000Z');
  });

  it('reads LANDLEDGER_TZ and a holidays file, and refuses a bad one', async () => {
    const { readHolidays } = await import('../src/business-hours.js');
    const dir = mkdtempSync(join(tmpdir(), 'll-holidays-'));
    const file = join(dir, 'holidays.txt');
    writeFileSync(file, '# Israel 2026\n2026-09-12 # Rosh Hashanah\n\n2026-09-21\n');
    expect([...readHolidays(file)]).toEqual(['2026-09-12', '2026-09-21']);
    expect(readHolidays(join(dir, 'missing.txt')).size).toBe(0);
    writeFileSync(file, 'tomorrow\n');
    expect(() => readHolidays(file)).toThrow(/not a date/);
    const config = configFromEnv({
      LANDLEDGER_TZ: 'Asia/Jerusalem',
      LANDLEDGER_BUSINESS_DAYS: 'sun-thu',
      LANDLEDGER_HOLIDAYS_FILE: 'none',
    } as never);
    expect(config).toMatchObject({ timeZone: 'Asia/Jerusalem', businessDays: [0, 1, 2, 3, 4] });
    expect(() => configFromEnv({ LANDLEDGER_TZ: 'Mars/Olympus' } as never)).toThrow(/LANDLEDGER_TZ/);
  });
});
