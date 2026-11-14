import { CostRecord } from '@landledger/contracts';
import { correct, ulid } from '@landledger/focus';
import { clusterRow } from '@landledger/focus/testing';
import { loadMigrations } from '@landledger/schema';
import { createTestDatabase, integrationEnabled, type TestDatabase } from '@landledger/schema/testing';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createSql, type Sql } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createServices, type Services } from '../src/services.js';
import { signWebhook } from '../src/webhooks.js';
import { fakeLandbright, ISSUER, oidcConfig, type Person } from './fake-oidc.js';

const config = (over: Partial<Config> = {}): Config => ({
  port: 0,
  host: '127.0.0.1',
  postgresUrl: '',
  consoleUrl: 'http://localhost:4811',
  bootstrapKey: null,
  devAuth: false,
  sessionHours: 8,
  oidc: oidcConfig,
  oidcProblem: null,
  backgroundJobs: false,
  landflow: null,
  clickland: null,
  clicklandConsoleUrl: 'http://localhost:4711',
  costMetricsEndpoint: null,
  ingestJobs: false,
  dockerSharesCluster: null,
  auditAnchorMinutes: 0,
  stepDeadlineHours: 24,
  businessDays: [1, 2, 3, 4, 5],
  timeZone: 'UTC',
  holidays: new Set(),
  secretKey: Buffer.alloc(32, 7),
  ...over,
});

const TAL: Person = {
  sub: 'sub-tal',
  email: 'tal.levi@landbright.test',
  name: 'Tal Levi',
  roles: ['Engineering', 'Everyone'],
};
const YOAV: Person = {
  sub: 'sub-yoav',
  email: 'yoav.bendavid@landbright.test',
  name: 'Yoav Ben David',
  roles: ['Finance Controllers', 'Everyone'],
};

describe.skipIf(!integrationEnabled('db'))('the API against Postgres', () => {
  let db: TestDatabase;
  let sql: Sql;
  let services: Services;
  let app: FastifyInstance;
  let fake: Awaited<ReturnType<typeof fakeLandbright>>;
  const received: { headers: Record<string, string>; body: string }[] = [];
  let receiverStatus = 204;

  beforeAll(async () => {
    db = await createTestDatabase();
    sql = createSql(db.appUrl);
    fake = await fakeLandbright();
    // Landbright is the fake; webhook receivers are recorded.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(ISSUER)) return fake.fetchImpl(input, init);
      received.push({ headers: init!.headers as Record<string, string>, body: init!.body as string });
      return new Response(null, { status: receiverStatus });
    };
    services = createServices(config(), sql, fetchImpl);
    app = await buildApp(services);
    expect(await seed(sql)).toBe(11);
  });
  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const cookieFrom = (setCookie: string | string[] | undefined, name: string) => {
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const c = list.find((s) => s.startsWith(`${name}=`));
    return c ? { value: c.split(';')[0]!.slice(name.length + 1), raw: c } : null;
  };

  /** Signs a person in through the fake Landbright the way a browser does; returns the session cookie (or the error). */
  async function signIn(person: Person, returnTo = '/rules') {
    const login = await app.inject({ method: 'GET', url: `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}` });
    expect(login.statusCode).toBe(302);
    const loginCookie = cookieFrom(login.headers['set-cookie'], 'll_login')!;
    expect(loginCookie.raw).toMatch(/HttpOnly/);
    const q = fake.authorize(login.headers.location!, person);
    const callback = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?${new URLSearchParams(q)}`,
      cookies: { ll_login: loginCookie.value },
    });
    expect(callback.statusCode).toBe(302);
    return { callback, session: cookieFrom(callback.headers['set-cookie'], 'll_session'), q, loginCookie };
  }

  it('answers health with the migrations applied', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', postgres: 'ok', migrations: loadMigrations().length });
  });

  it('asks a stranger to sign in, and says sign-in is available', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.details).toEqual({ signIn: 'available' });
    expect((await app.inject({ method: 'GET', url: '/api/cost-centers' })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'GET',
      url: '/api/cost-centers',
      headers: { authorization: 'Bearer ll_nope' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('signs a person in through Landbright: a session cookie, roles from groups, back where they started', async () => {
    const { callback, session } = await signIn(YOAV, '/rules');
    expect(callback.headers.location).toBe('/rules');
    expect(session!.raw).toMatch(/HttpOnly/);
    expect(session!.raw).toMatch(/SameSite=Lax/);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { ll_session: session!.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      kind: 'person',
      user: { name: 'Yoav Ben David', email: 'yoav.bendavid@landbright.test', roles: ['controller'] },
      authMode: 'oidc',
    });
    // Only the hash of the cookie is stored.
    const [row] = await sql`SELECT count(*)::int AS n FROM sessions WHERE id = ${session!.value}`;
    expect(row!.n).toBe(0);
    const groups = await sql`SELECT name, role FROM groups ORDER BY name`;
    expect(groups).toEqual(
      expect.arrayContaining([
        { name: 'Everyone', role: null },
        { name: 'Finance Controllers', role: 'controller' },
      ]),
    );
  });

  it('refuses a replayed or foreign callback', async () => {
    const { q, loginCookie } = await signIn(TAL);
    const replay = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?${new URLSearchParams(q)}`,
      cookies: { ll_login: loginCookie.value },
    });
    expect(replay.headers.location).toBe('/?signin_error=expired');
    // A callback this browser didn't start (no ll_login cookie).
    const login = await app.inject({ method: 'GET', url: '/api/auth/login' });
    const q2 = fake.authorize(login.headers.location!, TAL);
    const foreign = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?${new URLSearchParams(q2)}` });
    expect(foreign.headers.location).toBe('/?signin_error=expired');
    const denied = await app.inject({ method: 'GET', url: '/api/auth/oidc/callback?error=access_denied' });
    expect(denied.headers.location).toBe('/?signin_error=denied');
  });

  it('turns away someone in no Landledger group, and records it', async () => {
    const { callback, session } = await signIn(
      { sub: 'sub-x', email: 'x@landbright.test', name: 'X', roles: ['Everyone'] },
      '/',
    );
    expect(session).toBeNull();
    expect(callback.headers.location).toBe('/?signin_error=no_role');
    const [entry] = await sql`SELECT action, data FROM audit_log WHERE action = 'auth.refused'`;
    expect(entry!.data).toMatchObject({ reason: 'no Landledger group', groups: ['Everyone'] });
  });

  it('reads the seeded rate card v1 and the development cost centers', async () => {
    const { session } = await signIn(TAL);
    const cookies = { ll_session: session!.value };
    const cards = (await app.inject({ method: 'GET', url: '/api/rate-cards?on=2026-11-14', cookies })).json();
    const card = cards.rateCards[0];
    // v1 is a proposal until a person approves it (spec 002), so nothing is in effect yet.
    expect(card).toMatchObject({ id: 'rc_internal', currency: 'USD', current: null });
    expect(card.versions[0]).toMatchObject({
      version: 1,
      status: 'proposed',
      effectiveFrom: '2026-11-01',
      hoursPerMonth: '730',
      proposedBy: 'seed',
      approvedBy: null,
    });
    expect(
      card.versions[0].lines.map((l: { skuId: string; pricingUnit: string; unitPrice: string }) => [
        l.skuId,
        l.pricingUnit,
        l.unitPrice,
      ]),
    ).toEqual([
      ['landledger:k8s:cpu', 'Core-Hours', '0.034'],
      ['landledger:k8s:memory', 'GiB-Hours', '0.0045'],
      ['landledger:k8s:storage', 'GB-Months', '0.10'],
      ['landledger:network:egress', 'GB', '0.02'],
    ]);
    expect(card.versions[0].lines[3].details).toMatchObject({ Applied: false });
    const ccs = (await app.inject({ method: 'GET', url: '/api/cost-centers?on=2026-11-14', cookies })).json();
    expect(ccs.costCenters.map((c: { code: string }) => c.code)).toEqual([
      'CS-SUPPORT',
      'ENG-AGENTS',
      'ENG-PLATFORM',
      'ENG-PRODUCT',
      'GA-IT',
      'RND-DATA',
    ]);
    expect(ccs.costCenters.every((c: { origin: string }) => c.origin === 'dev-seed')).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/rate-cards/nope', cookies })).statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/api/cost-centers?on=yesterday', cookies });
    expect(bad.statusCode).toBe(400);
  });

  it('seeds once: a second run adds nothing', async () => {
    expect(await seed(sql)).toBe(0);
  });

  it('lets a controller make API keys (shown once, scoped) and an engineer not', async () => {
    const tal = { ll_session: (await signIn(TAL)).session!.value };
    const yoav = { ll_session: (await signIn(YOAV)).session!.value };
    expect(
      (await app.inject({ method: 'POST', url: '/api/keys', cookies: tal, payload: { name: 'x', scopes: ['read'] } }))
        .statusCode,
    ).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/api/keys',
      cookies: yoav,
      payload: { name: 'ingest bot', scopes: ['ingest'] },
    });
    expect(created.statusCode).toBe(201);
    const { key, id } = created.json();
    expect(key).toMatch(/^ll_[\w-]{32}$/);
    const listed = (await app.inject({ method: 'GET', url: '/api/keys', cookies: yoav })).json();
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(listed.keys[0]).toMatchObject({
      name: 'ingest bot',
      scopes: ['ingest'],
      createdBy: 'yoav.bendavid@landbright.test',
    });

    const auth = { authorization: `Bearer ${key}` };
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth })).json()).toMatchObject({
      kind: 'key',
      scopes: ['ingest'],
    });
    expect((await app.inject({ method: 'GET', url: '/api/cost-centers', headers: auth })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/keys', headers: auth })).statusCode).toBe(403);

    const reader = (
      await app.inject({
        method: 'POST',
        url: '/api/keys',
        cookies: yoav,
        payload: { name: 'reader', scopes: ['read'] },
      })
    ).json();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/cost-centers',
          headers: { authorization: `Bearer ${reader.key}` },
        })
      ).statusCode,
    ).toBe(200);

    expect((await app.inject({ method: 'DELETE', url: `/api/keys/${id}`, cookies: yoav })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: `/api/keys/${id}`, cookies: yoav })).statusCode).toBe(404);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/keys',
      cookies: yoav,
      payload: { name: 'x', scopes: ['decide'] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('signs out: the session ends here and the browser goes to Landbright to end it there', async () => {
    const { session } = await signIn(TAL);
    const cookies = { ll_session: session!.value };
    // The ID token kept for sign-out is sealed at rest (AES-256-GCM, bound to its session).
    const tokens = await sql`SELECT id_token FROM sessions WHERE id_token IS NOT NULL`;
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) expect(t.id_token).toMatch(/^enc:v1:/);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies });
    const redirect = new URL(out.json().redirect);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(`${ISSUER}/session/end`);
    expect(redirect.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:4811/');
    expect(redirect.searchParams.get('id_token_hint')).toMatch(/^ey/); // the token itself, opened
    expect(cookieFrom(out.headers['set-cookie'], 'll_session')!.raw).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies })).statusCode).toBe(401);
  });

  it('sends webhooks through the outbox, signed, and retries a failure', async () => {
    const yoav = { ll_session: (await signIn(YOAV)).session!.value };
    const hook = (
      await app.inject({
        method: 'POST',
        url: '/api/webhooks',
        cookies: yoav,
        payload: { url: 'http://receiver.test/hook', events: ['ping', 'budget.at_risk'] },
      })
    ).json();
    expect(hook.secret).toMatch(/^whsec_/);
    const [stored] = await sql`SELECT secret FROM webhooks WHERE id = ${hook.id}`;
    expect(stored!.secret).toMatch(/^enc:v1:/); // sealed at rest; the signer opens it
    expect(stored!.secret).not.toContain(hook.secret.slice(6));
    const ping = await app.inject({ method: 'POST', url: `/api/webhooks/${hook.id}/ping`, cookies: yoav });
    expect(ping.statusCode).toBe(202);
    expect(await services.webhooks.dispatchDue()).toBe(1);
    const got = received.at(-1)!;
    expect(got.headers['webhook-signature']).toBe(
      signWebhook(hook.secret, got.headers['webhook-id']!, Number(got.headers['webhook-timestamp']), got.body),
    );
    expect(JSON.parse(got.body)).toMatchObject({ type: 'ping', data: { webhookId: hook.id } });

    receiverStatus = 500;
    await app.inject({ method: 'POST', url: `/api/webhooks/${hook.id}/ping`, cookies: yoav });
    expect(await services.webhooks.dispatchDue()).toBe(1);
    const deliveries = (
      await app.inject({ method: 'GET', url: `/api/webhooks/${hook.id}/deliveries`, cookies: yoav })
    ).json().deliveries;
    expect(
      deliveries.map((d: { status: string; attempts: number; lastError: string | null }) => [
        d.status,
        d.attempts,
        d.lastError,
      ]),
    ).toEqual([
      ['pending', 1, 'HTTP 500'],
      ['delivered', 1, null],
    ]);
    expect(await services.webhooks.dispatchDue()).toBe(0); // waits 5 s before the retry
    receiverStatus = 204;
  });

  it('closes and locks a month by a person only, one step at a time, never back (spec 001)', async () => {
    const tal = { ll_session: (await signIn(TAL)).session!.value };
    const yoav = { ll_session: (await signIn(YOAV)).session!.value };
    await sql`INSERT INTO ingest_runs (id, source, kind, day, started_by) VALUES ('run_t', 'manual', 'manual', '2026-10-30', 'test')`;
    const october = clusterRow({ x_RecordId: ulid(), x_IngestRunId: 'run_t', x_RateCardVersion: null });
    expect(await services.records.append([october])).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/periods', cookies: tal })).json().periods).toEqual([
      expect.objectContaining({ month: '2026-10', status: 'open', closingBy: null }),
    ]);

    const adminKey = (
      await app.inject({ method: 'POST', url: '/api/keys', cookies: yoav, payload: { name: 'ops', scopes: ['admin'] } })
    ).json().key;
    const asKey = { authorization: `Bearer ${adminKey}` };
    const post = (url: string, auth: { cookies?: Record<string, string>; headers?: Record<string, string> }) =>
      app.inject({ method: 'POST', url, ...auth });

    expect((await post('/api/periods/2026-10/close', { cookies: tal })).statusCode).toBe(403); // an engineer
    const keyClose = await post('/api/periods/2026-10/close', { headers: asKey });
    expect(keyClose.statusCode).toBe(403);
    expect(keyClose.json().error.message).toMatch(/person/);
    expect((await post('/api/periods/2026-10/lock', { cookies: yoav })).statusCode).toBe(409); // open → locked skips
    expect((await post('/api/periods/2099-01/close', { cookies: yoav })).statusCode).toBe(400);
    expect((await post('/api/periods/2026-13/close', { cookies: yoav })).statusCode).toBe(400);

    const closing = await post('/api/periods/2026-10/close', { cookies: yoav });
    expect(closing.json()).toMatchObject({
      month: '2026-10',
      status: 'closing',
      closingBy: expect.stringMatching(/^usr_/),
    });
    expect((await post('/api/periods/2026-10/lock', { headers: asKey })).statusCode).toBe(403); // a key never locks
    // The record was appended by hand, never allocated: the month isn't whole, so the lock needs an override.
    const notWhole = await post('/api/periods/2026-10/lock', { cookies: yoav });
    expect(notWhole.statusCode).toBe(409);
    expect(notWhole.json().error.details.problems).toEqual(['1 record(s) booked in 2026-10 have no stored allocation']);
    const locked = await app.inject({
      method: 'POST',
      url: '/api/periods/2026-10/lock',
      cookies: yoav,
      payload: { override: { reason: 'A test record, appended without allocation' } },
    });
    expect(locked.json()).toMatchObject({ status: 'locked', lockedBy: expect.stringMatching(/^usr_/) });
    expect((await post('/api/periods/2026-10/lock', { cookies: yoav })).json().error.message).toMatch(/never reopens/);
    expect((await post('/api/periods/2026-10/close', { cookies: yoav })).statusCode).toBe(409);

    // Locked: October takes nothing more; late data is a correction in November, dated 30 October.
    await expect(
      services.records.append([
        clusterRow({ x_RecordId: ulid(), x_IngestRunId: 'run_t', x_RateCardVersion: null, x_SourceKey: 'k:late' }),
      ]),
    ).rejects.toThrow(/locked/);
    const [reversal] = correct(
      october,
      null,
      { isLocked: (m) => m <= '2026-10', openMonth: '2026-11' },
      { ingestRunId: 'run_t' },
    );
    expect(await services.records.append([reversal!])).toBe(1);
    const actions = (await sql`SELECT action FROM audit_log WHERE subject_type = 'period' ORDER BY seq`).map(
      (r) => r.action,
    );
    expect(actions).toEqual(['period.closing', 'period.locked']);
  });

  it('reads cost records: paged, filtered, amounts as decimal strings (spec 001)', async () => {
    const tal = { ll_session: (await signIn(TAL)).session!.value };
    const get = (q: string) => app.inject({ method: 'GET', url: `/api/records${q}`, cookies: tal });
    const all = (await get('')).json();
    expect(all.records).toHaveLength(2);
    expect(all.next).toBeNull();
    const [original, reversal] = all.records;
    expect(original).toMatchObject({
      EffectiveCost: '0.042500',
      BilledCost: '0.000000',
      PricingQuantity: '1.25',
      ChargeClass: null,
    });
    expect(reversal).toMatchObject({
      EffectiveCost: '-0.042500',
      ChargeClass: 'Correction',
      ChargePeriodStart: '2026-10-30T00:00:00Z',
      BillingPeriodStart: '2026-11-01T00:00:00Z',
      x_CorrectionOfId: original.x_RecordId,
    });
    expect(CostRecord.safeParse(original).success).toBe(true);
    expect((await get('?month=2026-11')).json().records).toHaveLength(1);
    expect((await get('?basis=invoiced')).json().records).toHaveLength(0);
    const first = (await get('?limit=1')).json();
    expect(first.records).toHaveLength(1);
    const second = (await get(`?limit=1&after=${first.next}`)).json();
    expect(second.records[0].x_RecordId).toBe(reversal.x_RecordId);
    expect((await get('?month=2026-1')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/records' })).statusCode).toBe(401);
  });

  it('chains the audit log and finds a changed or missing entry', async () => {
    const yoav = { ll_session: (await signIn(YOAV)).session!.value };
    const ok = (await app.inject({ method: 'GET', url: '/api/audit/verify', cookies: yoav })).json();
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM audit_log`;
    expect(ok).toMatchObject({ ok: true, checked: n, brokenAt: null });
    const list = (await app.inject({ method: 'GET', url: '/api/audit?limit=3', cookies: yoav })).json();
    expect(list.total).toBe(n);
    expect(list.entries[0].seq).toBe(n);
    expect(list.entries[0].prevHash).toBe(list.entries[1].hash);
    const actions = (await sql`SELECT DISTINCT action FROM audit_log`).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'rate_card.version_proposed',
        'cost_center.created',
        'auth.signed_in',
        'api_key.created',
        'webhook.created',
      ]),
    );

    // Tamper as a superuser would: past the append-only trigger.
    const admin = postgres(db.url, { onnotice: () => {}, max: 1 });
    try {
      await admin`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`;
      await admin`UPDATE audit_log SET data = data || '{"owner":"Someone Else"}' WHERE seq = 5`;
      const changed = (await app.inject({ method: 'GET', url: '/api/audit/verify', cookies: yoav })).json();
      expect(changed).toMatchObject({
        ok: false,
        checked: 4,
        brokenAt: 5,
        reason: 'entry 5 was changed after it was written',
      });
      await admin`DELETE FROM audit_log WHERE seq = 5`;
      const missing = (await app.inject({ method: 'GET', url: '/api/audit/verify', cookies: yoav })).json();
      expect(missing).toMatchObject({ ok: false, brokenAt: 5, reason: 'entry 5 is missing' });
    } finally {
      await admin.end();
    }
  });

  it('lets the local developer in only when the bypass is on', async () => {
    const dev = await buildApp(createServices(config({ devAuth: true }), sql));
    try {
      const me = (await dev.inject({ method: 'GET', url: '/api/auth/me' })).json();
      expect(me).toMatchObject({
        kind: 'dev',
        authMode: 'dev',
        user: { name: 'Local developer', roles: ['controller'] },
      });
      expect((await dev.inject({ method: 'GET', url: '/api/cost-centers' })).statusCode).toBe(200);
    } finally {
      await dev.close();
    }
  });

  it('says sign-in is unavailable without a client secret', async () => {
    const off = await buildApp(createServices(config({ oidc: null, oidcProblem: 'No client secret' }), sql));
    try {
      expect((await off.inject({ method: 'GET', url: '/api/auth/me' })).json().error.details).toEqual({
        signIn: 'unavailable',
        problem: 'No client secret',
      });
      const login = await off.inject({ method: 'GET', url: '/api/auth/login' });
      expect(login.statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });
});
