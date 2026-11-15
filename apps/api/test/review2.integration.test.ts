/**
 * The review of wave 2 against Postgres (LANDLEDGER_INTEGRATION=db): a test per blocker (B1 relays and keys, B2
 * confirmation, B3 who created it and where it came from, B4 automatic approvals counted per month) and per should-fix
 * (frozen rate card lines, the legacy approve routes, evidence served and fresh, owners and deputies, release and
 * applied, USD only, backdated reservations, consumption by increment, the first full month, step deadlines,
 * exceptions, stored reports, the request page's figures, the evidence pack), plus the nits (idempotency, the single
 * CFO, back-channel logout). People sign in through a fake Landbright with their groups.
 */
import { createHash } from 'node:crypto';
import { createTestDatabase, integrationEnabled, type TestDatabase } from '@landledger/schema/testing';
import { slackButtonValue } from '@landledger/contracts';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSql, type Sql } from '../src/db.js';
import type { Principal } from '../src/principal.js';
import { slackSignature } from '../src/relays.js';
import { canonicalSnapshot } from '../src/requests.js';
import { lineMatches } from '../src/reservations.js';
import { RATE_CARD_V1, seed } from '../src/seed.js';
import { createServices, type Services } from '../src/services.js';
import { fakeLandbright, ISSUER, oidcConfig, type Person } from './fake-oidc.js';
import { fakeSources, testConfig } from './fakes.js';

const people = {
  tal: { sub: 'sub-tal', email: 'tal.levi@landbright.test', name: 'Tal Levi', roles: ['Engineering'] },
  shira: { sub: 'sub-shira', email: 'shira.navon@landbright.test', name: 'Shira Navon', roles: ['Budget Owners'] },
  noa: { sub: 'sub-noa', email: 'noa.peretz@landbright.test', name: 'Noa Peretz', roles: ['Budget Owners'] },
  yoav: {
    sub: 'sub-yoav',
    email: 'yoav.bendavid@landbright.test',
    name: 'Yoav Ben David',
    roles: ['Finance Controllers'],
  },
  roni: { sub: 'sub-roni', email: 'roni.amar@landbright.test', name: 'Roni Amar', roles: ['Finance Controllers'] },
  dana: { sub: 'sub-dana', email: 'dana.shalev@landbright.test', name: 'Dana Shalev', roles: ['Finance CFO'] },
  avi: { sub: 'sub-avi', email: 'avi.auditor@landbright.test', name: 'Avi Auditor', roles: ['Landledger Auditors'] },
  admin: { sub: 'sub-admin', email: 'admin@landbright.test', name: 'Administrator', roles: ['Finance Controllers'] },
} satisfies Record<string, Person>;
type Who = keyof typeof people;

const SLACK_SECRET = 'test-signing-secret-not-real-0001';
const TEAM = 'T_LANDDEV';
const APP = 'A_LANDLEDGER';
const sources = fakeSources();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe.skipIf(!integrationEnabled('db'))('review of wave 2', () => {
  let db: TestDatabase;
  let sql: Sql;
  let owner: postgres.Sql;
  let services: Services;
  let app: FastifyInstance;
  let fake: Awaited<ReturnType<typeof fakeLandbright>>;
  // Monday 16 November 2026, 10:00 UTC.
  const START = new Date('2026-11-16T10:00:00Z');
  let now = START;
  const cookie = {} as Record<Who, string>;
  const userId = {} as Record<Who, string>;
  const principal = (who: Who): Principal => ({
    kind: 'person',
    id: userId[who],
    name: people[who].name,
    email: people[who].email,
    roles: who === 'dana' ? ['cfo'] : ['yoav', 'roni', 'admin'].includes(who) ? ['controller'] : [],
    groups: people[who].roles,
    scopes: ['read', 'requests:write', 'admin'],
  });
  const keys: Record<string, { id: string; key: string }> = {};
  let channelId = '';

  const signIn = async (who: Who) => {
    const login = await app.inject({ method: 'GET', url: '/api/auth/login' });
    const state = login.cookies.find((c) => c.name === 'll_login')!.value;
    const q = fake.authorize(login.headers.location!, people[who]);
    const cb = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?${new URLSearchParams(q)}`,
      cookies: { ll_login: state },
    });
    return cb.cookies.find((c) => c.name === 'll_session')!.value;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    sql = createSql(db.appUrl);
    owner = postgres(db.url, { max: 2, onnotice: () => {} });
    fake = await fakeLandbright();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(ISSUER)) return fake.fetchImpl(input, init);
      return sources.fetchImpl(input, init);
    };
    services = createServices(
      testConfig({ postgresUrl: db.appUrl, devAuth: false, oidc: oidcConfig, oidcProblem: null }),
      sql,
      fetchImpl,
      undefined,
      () => now,
    );
    app = await buildApp(services);
    await seed(sql);
    for (const who of Object.keys(people) as Who[]) {
      cookie[who] = await signIn(who);
      const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE subject = ${people[who].sub}`;
      userId[who] = u!.id;
    }
    // Everyone signed in "today" on the test's clock (relays need someone current).
    await owner`UPDATE users SET last_seen_at = ${START} WHERE kind = 'person'`;
    await services.rateCards.importAiLines(RATE_CARD_V1, await services.landflow!.prices(), principal('roni'));
    await services.rateCards.approve(RATE_CARD_V1, principal('yoav'));
    await services.allocation.approve('rsv_main_1', principal('dana'));
    // Six days of cluster cost before the test's today: the 30-day baseline.
    for (const d of ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'])
      await services.ingest.run('clickland', d, 'manual', 'test');
    await services.allocation.allocatePending('2026-11');
    // Room in budgets, so automatic approvals aren't stopped by the seed's tiny dev budgets (except ENG-PRODUCT).
    await services.budgets.import(
      {
        csv: [
          'cost_center,month,amount,currency',
          'ENG-AGENTS,2026-11,100000.00,USD',
          'ENG-AGENTS,2026-12,100000.00,USD',
          'RND-DATA,2026-11,100000.00,USD',
          'RND-DATA,2026-12,100000.00,USD',
          'GA-IT,2026-11,100000.00,USD',
          'GA-IT,2026-12,100000.00,USD',
          'ENG-PLATFORM,2026-11,100000.00,USD',
          'ENG-PLATFORM,2026-12,100000.00,USD',
          'CS-SUPPORT,2026-11,100000.00,USD',
          'CS-SUPPORT,2026-12,100.00,USD',
          '',
        ].join('\n'),
        note: 'test',
      },
      principal('dana'),
    );
    // Keys, minted by a signed-in admin person (B1).
    const mint = async (name: string, scopes: string[], boundWorkflowIds?: string[]) => {
      const res = await as('dana', 'POST', '/api/keys', {
        name,
        scopes,
        ...(boundWorkflowIds ? { boundWorkflowIds } : {}),
      });
      expect(res.statusCode, res.body).toBe(201);
      keys[name] = { id: res.json().id, key: res.json().key };
    };
    await mint('write', ['read', 'requests:write']);
    await mint('write+reserve', ['read', 'requests:write', 'reservations:write']);
    await mint('bound', ['read', 'requests:write'], ['wf_capacity']);
    await mint('relay', ['read', 'decisions:relay']);
    await mint('hooks-a', ['webhooks:write']);
    await mint('hooks-b', ['webhooks:write']);
    await mint('read', ['read']);
    // A webhook that takes every event, to see what the outbox holds.
    await services.webhooks.create(
      {
        url: 'https://receiver.test/hook',
        events: [
          'request.created',
          'request.step_pending',
          'request.decided',
          'request.applied',
          'request.needs_confirmation',
          'decision.relayed',
          'report.exceptions',
        ],
        description: 'test',
      } as never,
      principal('dana'),
    );
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await owner?.end();
    await db?.drop();
  });

  const as = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      cookies: { ll_session: cookie[who] },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const withKey = (name: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${keys[name]!.key}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const raise = async (who: Who, body: Record<string, unknown>) => {
    const res = await as(who, 'POST', '/api/requests', {
      kind: 'infra_change',
      title: 'A request',
      recurrence: 'monthly',
      start: '2026-11-16',
      ...body,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().request;
  };
  const raiseByKey = async (name: string, body: Record<string, unknown>) => {
    const res = await withKey(name, 'POST', '/api/requests', {
      kind: 'infra_change',
      title: 'A request',
      recurrence: 'monthly',
      start: '2026-11-16',
      requester: { kind: 'person', person: { email: people.tal.email } },
      origin: { type: 'landflow_run', workflowId: 'wf_capacity', executionId: 'ex_1' },
      ...body,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().request;
  };
  const decide = async (who: Who, id: string, outcome: 'approve' | 'reject', comment = '') => {
    const shown = (await as(who, 'GET', `/api/requests/${id}`)).json();
    return as(who, 'POST', `/api/requests/${id}/decisions`, {
      outcome,
      comment,
      evidenceSha256: shown.evidenceSha256,
      ...(shown.request.currentStep ? { step: shown.request.currentStep } : {}),
    });
  };
  const outbox = async (type: string) =>
    (
      await sql<{ data: Record<string, unknown> }[]>`
        SELECT payload->'data' AS data FROM outbox WHERE event_type = ${type} ORDER BY created_at, id`
    ).map((r) => r.data);
  /** What Slack sends when a person presses a Landledger button on a card. */
  const press = (o: {
    user: string;
    requestId: string;
    step: number;
    hash: string;
    outcome?: 'approve' | 'reject';
    team?: string;
    app?: string;
    secret?: string;
    at?: number;
    comment?: string;
  }) => {
    const value = slackButtonValue({ requestId: o.requestId, step: o.step, evidenceSha256: o.hash });
    const payload =
      o.outcome === 'reject'
        ? {
            type: 'view_submission',
            team: { id: o.team ?? TEAM },
            user: { id: o.user, team_id: o.team ?? TEAM },
            api_app_id: o.app ?? APP,
            view: {
              callback_id: 'landledger.reject',
              private_metadata: value,
              state: { values: { comment: { comment: { type: 'plain_text_input', value: o.comment ?? '' } } } },
            },
          }
        : {
            type: 'block_actions',
            team: { id: o.team ?? TEAM },
            user: { id: o.user, team_id: o.team ?? TEAM },
            api_app_id: o.app ?? APP,
            actions: [{ action_id: 'landledger.approve', value }],
          };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const timestamp = String(Math.floor((o.at ?? now.getTime()) / 1000));
    return {
      body,
      timestamp,
      signature: slackSignature(o.secret ?? SLACK_SECRET, timestamp, body),
    };
  };
  const relay = (input: ReturnType<typeof press>, key = 'relay') => withKey(key, 'POST', '/api/relays/slack', input);

  // B1 ---------------------------------------------------------------------------------------------------------------

  it('B1: only a signed-in admin person mints keys; a relay key holds no write; the bootstrap key stops after setup', async () => {
    expect((await withKey('write', 'POST', '/api/keys', { name: 'x', scopes: ['read'] })).statusCode).toBe(403);
    const boot = await app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: { authorization: 'Bearer ll_bootstrap_test_key_0000000000000000' },
      payload: { name: 'x', scopes: ['read'] },
    });
    expect(boot.statusCode, boot.body).toBe(403);
    expect(boot.json().error.message).toMatch(/first admin person/);
    expect((await as('tal', 'POST', '/api/keys', { name: 'x', scopes: ['read'] })).statusCode).toBe(403);
    const mixed = await as('dana', 'POST', '/api/keys', { name: 'x', scopes: ['decisions:relay', 'requests:write'] });
    expect(mixed.statusCode).toBe(400);
    expect(
      (await as('dana', 'POST', '/api/keys', { name: 'x', scopes: ['decisions:relay', 'admin'] })).statusCode,
    ).toBe(400);
    // The database refuses one too, and a key that somehow holds both is refused at the door.
    await expect(
      owner`INSERT INTO api_keys (id, name, prefix, hash, scopes, created_by)
            VALUES ('key_bad', 'bad', 'll_bad', ${sha('bad')}, ${['decisions:relay', 'requests:write']}, 'test')`,
    ).rejects.toThrow(/api_keys_relay_alone/);
    const [created] =
      await sql`SELECT actor, data FROM audit_log WHERE action = 'api_key.created' AND subject_id = ${keys.relay!.id}`;
    expect(created).toMatchObject({ actor: people.dana.email, data: { scopes: ['read', 'decisions:relay'] } });
  });

  it('B1: a webhooks:write key manages only its own subscriptions and never sees another secret', async () => {
    const a = await withKey('hooks-a', 'POST', '/api/webhooks', {
      url: 'https://landflow.test/hooks/a',
      events: ['request.decided'],
      description: 'a',
    });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json().secret).toMatch(/^whsec_/);
    expect(a.json().createdByKey).toBe(keys['hooks-a']!.id);
    const listA = (await withKey('hooks-a', 'GET', '/api/webhooks')).json().webhooks;
    expect(listA.map((w: { id: string }) => w.id)).toEqual([a.json().id]);
    expect(JSON.stringify(listA)).not.toContain(a.json().secret);
    expect((await withKey('hooks-b', 'GET', '/api/webhooks')).json().webhooks).toEqual([]);
    expect((await withKey('hooks-b', 'DELETE', `/api/webhooks/${a.json().id}`)).statusCode).toBe(404);
    expect((await withKey('hooks-b', 'GET', `/api/webhooks/${a.json().id}/deliveries`)).statusCode).toBe(404);
    expect((await withKey('hooks-b', 'POST', `/api/webhooks/${a.json().id}/ping`)).statusCode).toBe(404);
    expect((await withKey('write', 'GET', '/api/webhooks')).statusCode).toBe(403);
    // An admin person sees every subscription.
    expect((await as('dana', 'GET', '/api/webhooks')).json().webhooks.length).toBeGreaterThanOrEqual(2);
    expect((await withKey('hooks-a', 'DELETE', `/api/webhooks/${a.json().id}`)).statusCode).toBe(204);
  });

  it('B1: an admin person registers a Slack channel (secret sealed), and each person links their own Slack id', async () => {
    expect(
      (
        await withKey('relay', 'POST', '/api/relay-channels', {
          kind: 'slack',
          name: 'x',
          signingSecret: SLACK_SECRET,
          teamId: TEAM,
          appId: APP,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await as('tal', 'POST', '/api/relay-channels', {
          kind: 'slack',
          name: 'x',
          signingSecret: SLACK_SECRET,
          teamId: TEAM,
          appId: APP,
        })
      ).statusCode,
    ).toBe(403);
    const ch = await as('dana', 'POST', '/api/relay-channels', {
      kind: 'slack',
      name: 'Landbright Slack',
      signingSecret: SLACK_SECRET,
      teamId: TEAM,
      appId: APP,
    });
    expect(ch.statusCode, ch.body).toBe(201);
    channelId = ch.json().id;
    expect(ch.body).not.toContain(SLACK_SECRET);
    const [row] = await owner`SELECT secret FROM relay_channels WHERE id = ${channelId}`;
    expect(row!.secret).toMatch(/^enc:v1:/);
    // Links: from the person's own session only, one person per Slack id.
    expect((await withKey('relay', 'POST', '/api/me/links', { kind: 'slack', externalId: 'U_SHIRA' })).statusCode).toBe(
      403,
    );
    const link = await as('shira', 'POST', '/api/me/links', { kind: 'slack', externalId: 'U_SHIRA' });
    expect(link.statusCode, link.body).toBe(201);
    expect((await as('noa', 'POST', '/api/me/links', { kind: 'slack', externalId: 'U_SHIRA' })).statusCode).toBe(409);
    expect((await as('noa', 'POST', '/api/me/links', { kind: 'slack', externalId: 'U_NOA' })).statusCode).toBe(201);
    expect((await as('yoav', 'POST', '/api/me/links', { kind: 'slack', externalId: 'U_YOAV' })).statusCode).toBe(201);
    expect((await as('shira', 'GET', '/api/me/links')).json().links).toMatchObject([
      { kind: 'slack', externalId: 'U_SHIRA' },
    ]);
  });

  it('B1: a relay is the raw Slack press, verified by Landledger, decided as the linked person; decision.relayed names them', async () => {
    const r = await raise('tal', {
      costCenter: 'GA-IT',
      title: 'Relay me',
      amount: { amount: '1200', currency: 'USD' },
    });
    expect(r.steps.map((s: { key: string }) => s.key)).toEqual(['budget_owner']);
    const card = (await withKey('relay', 'GET', `/api/requests/${r.id}`)).json();
    const base = { requestId: r.id, step: 1, hash: card.evidenceSha256 };
    // Signature, time window, team, app.
    expect(
      (await relay({ ...press({ ...base, user: 'U_SHIRA' }), signature: `v0=${'0'.repeat(64)}` })).statusCode,
    ).toBe(401);
    expect((await relay(press({ ...base, user: 'U_SHIRA', at: now.getTime() - 6 * 60_000 }))).statusCode).toBe(401);
    expect((await relay(press({ ...base, user: 'U_SHIRA', team: 'T_OTHER' }))).statusCode).toBe(401);
    expect((await relay(press({ ...base, user: 'U_SHIRA', app: 'A_OTHER' }))).statusCode).toBe(401);
    expect((await relay(press({ ...base, user: 'U_SHIRA', secret: 'another-secret-entirely-0000' }))).statusCode).toBe(
      401,
    );
    // Only a decisions:relay key relays.
    expect((await relay(press({ ...base, user: 'U_SHIRA' }), 'write')).statusCode).toBe(403);
    // An unlinked Slack user, and a linked person who isn't an approver.
    const unlinked = await relay(press({ ...base, user: 'U_NOBODY' }));
    expect(unlinked.statusCode).toBe(403);
    expect(unlinked.json().error.message).toMatch(/isn't linked/);
    expect((await relay(press({ ...base, user: 'U_YOAV' }))).statusCode).toBe(403);
    // A reject needs its reason.
    expect((await relay(press({ ...base, user: 'U_SHIRA', outcome: 'reject', comment: '' }))).statusCode).toBe(400);
    const ok = await relay(press({ ...base, user: 'U_SHIRA' }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().decision).toMatchObject({
      via: 'relay',
      relayedBy: 'relay',
      channel: 'slack',
      relay: { channelId, kind: 'slack', externalUserId: 'U_SHIRA' },
      person: { email: people.shira.email },
    });
    expect(ok.json().request.status).toBe('approved');
    const relayed = (await outbox('decision.relayed')).at(-1)!;
    expect(relayed).toMatchObject({
      person: { email: people.shira.email },
      channel: { id: channelId, kind: 'slack' },
      decision: { via: 'relay' },
    });
    const [entry] = await sql`
      SELECT actor, data FROM audit_log WHERE action = 'request.step_approved' AND subject_id = ${r.id}`;
    expect(entry).toMatchObject({ actor: people.shira.email, data: { relayed: true, externalUserId: 'U_SHIRA' } });
  });

  it('B1: a relay decides only the budget owner step of relayable kinds, and only for someone current', async () => {
    // $10,000 on GA-IT: budget owner, then Finance. The Finance step never takes a relay.
    const r = await raise('tal', { costCenter: 'GA-IT', title: 'Big', amount: { amount: '10000', currency: 'USD' } });
    expect(r.steps.map((s: { key: string }) => s.key)).toEqual(['budget_owner', 'finance']);
    expect((await decide('shira', r.id, 'approve')).statusCode).toBe(201);
    const card = (await withKey('relay', 'GET', `/api/requests/${r.id}`)).json();
    const fin = await relay(press({ requestId: r.id, step: 2, hash: card.evidenceSha256, user: 'U_YOAV' }));
    expect(fin.statusCode, fin.body).toBe(403);
    expect(fin.json().error.message).toMatch(/never decides the Finance step/);
    // Someone who hasn't signed in for over 7 days (and isn't SCIM-managed) isn't current.
    const r2 = await raise('tal', {
      costCenter: 'GA-IT',
      title: 'Stale person',
      amount: { amount: '1200', currency: 'USD' },
    });
    const card2 = (await withKey('relay', 'GET', `/api/requests/${r2.id}`)).json();
    await owner`UPDATE users SET last_seen_at = ${new Date(START.getTime() - 8 * 86_400_000)} WHERE id = ${userId.noa}`;
    const stale = await relay(press({ requestId: r2.id, step: 1, hash: card2.evidenceSha256, user: 'U_NOA' }));
    expect(stale.statusCode, stale.body).toBe(403);
    expect(stale.json().error.message).toMatch(/isn't current/);
    await owner`UPDATE users SET last_seen_at = ${START} WHERE id = ${userId.noa}`;
    // The database holds the rule too: no relayed decision on a Finance step.
    await expect(
      owner`INSERT INTO decisions (id, request_id, step, step_key, outcome, decided_by, evidence_sha256, via, relayed_by,
                                   channel, relay_channel_id, relay_external_id)
            VALUES ('dec_bad', ${r.id}, 2, 'finance', 'approve', ${userId.yoav}, ${card.evidenceSha256}, 'relay', 'relay',
                    'slack', ${channelId}, 'U_YOAV')`,
    ).rejects.toThrow();
  });

  // B2 ---------------------------------------------------------------------------------------------------------------

  it('B2: a request a key raises naming a person waits for that person to confirm it from their own session', async () => {
    const r = await raiseByKey('write', {
      costCenter: 'GA-IT',
      title: 'Needs Tal',
      amount: { amount: '900', currency: 'USD' },
    });
    expect(r).toMatchObject({
      status: 'awaiting_confirmation',
      steps: [],
      confirmation: { status: 'waiting', person: { email: people.tal.email } },
    });
    expect((await outbox('request.needs_confirmation')).at(-1)).toMatchObject({
      person: { email: people.tal.email },
      createdBy: { kind: 'key', id: keys.write!.id },
      url: `http://localhost:4811/requests/${r.id}`,
    });
    // Nobody decides it yet; Tal sees it under "confirm".
    expect((await decide('shira', r.id, 'approve')).statusCode).toBe(409);
    const box = (await as('tal', 'GET', '/api/requests?box=confirm')).json();
    expect(box.counts.confirm).toBeGreaterThanOrEqual(1);
    expect(box.requests.map((q: { id: string }) => q.id)).toContain(r.id);
    expect((await as('tal', 'GET', `/api/requests/${r.id}`)).json().request.you.canConfirm).toBe(true);
    // Not the key, not someone else.
    expect((await withKey('write', 'POST', `/api/requests/${r.id}/confirm`, {})).statusCode).toBe(403);
    expect((await as('shira', 'POST', `/api/requests/${r.id}/confirm`, {})).statusCode).toBe(403);
    // The database won't move it on without the confirmation.
    await expect(owner`UPDATE requests SET status = 'pending' WHERE id = ${r.id}`).rejects.toThrow();
    const ok = await as('tal', 'POST', `/api/requests/${r.id}/confirm`, { comment: 'Yes, I asked for this' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().request).toMatchObject({ status: 'pending', confirmation: { status: 'confirmed' } });
    expect(ok.json().request.steps[0].key).toBe('budget_owner');
    // Declined: cancelled, with the reason.
    const d = await raiseByKey('write', {
      costCenter: 'GA-IT',
      title: 'Not Tal',
      amount: { amount: '800', currency: 'USD' },
    });
    expect((await as('tal', 'POST', `/api/requests/${d.id}/decline`, { reason: 'x' })).statusCode).toBe(400);
    const no = await as('tal', 'POST', `/api/requests/${d.id}/decline`, { reason: 'I never asked for this' });
    expect(no.json().request).toMatchObject({
      status: 'cancelled',
      confirmation: { status: 'declined', reason: 'I never asked for this' },
    });
    // A person's own session skips confirmation.
    const own = await raise('tal', { costCenter: 'GA-IT', title: 'Mine', amount: { amount: '700', currency: 'USD' } });
    expect(own.confirmation).toBeNull();
    expect(own.status).toBe('pending');
    // Unconfirmed, it expires after the deadline.
    const e = await raiseByKey('write', {
      costCenter: 'GA-IT',
      title: 'Ignored',
      amount: { amount: '600', currency: 'USD' },
    });
    now = new Date('2026-11-18T12:00:00Z');
    await services.requests.expireDue();
    now = START;
    expect((await as('tal', 'GET', `/api/requests/${e.id}`)).json().request).toMatchObject({
      status: 'expired',
      confirmation: { status: 'expired' },
    });
  });

  // B3 ---------------------------------------------------------------------------------------------------------------

  it("B3: every request carries who created it; a key's origin is verified only for a workflow it is bound to", async () => {
    const plain = await raiseByKey('write', {
      costCenter: 'GA-IT',
      title: 'Unbound',
      amount: { amount: '100', currency: 'USD' },
    });
    expect(plain.createdBy).toEqual({ kind: 'key', id: keys.write!.id, name: 'write' });
    expect(plain.origin).toMatchObject({ type: 'landflow_run', workflowId: 'wf_capacity', verified: false });
    const bound = await raiseByKey('bound', {
      costCenter: 'GA-IT',
      title: 'Bound',
      amount: { amount: '100', currency: 'USD' },
    });
    expect(bound.origin).toMatchObject({ workflowId: 'wf_capacity', verified: true });
    const other = await raiseByKey('bound', {
      costCenter: 'GA-IT',
      title: 'Bound, other workflow',
      amount: { amount: '100', currency: 'USD' },
      origin: { type: 'landflow_run', workflowId: 'wf_other', executionId: 'ex_2' },
    });
    expect(other.origin).toMatchObject({ workflowId: 'wf_other', verified: false });
    const pr = await raiseByKey('bound', {
      costCenter: 'GA-IT',
      title: 'A PR',
      amount: { amount: '100', currency: 'USD' },
      origin: { type: 'pull_request', url: 'https://github.test/x/pull/2' },
    });
    expect(pr.origin.verified).toBe(false);
    const own = await raise('tal', { costCenter: 'GA-IT', title: 'Mine', amount: { amount: '100', currency: 'USD' } });
    expect(own.createdBy).toEqual({ kind: 'person', id: userId.tal, name: people.tal.name });
    expect(own.origin).toEqual({ type: 'console', verified: true });
    // MCP: the origin is always mcp, whatever the caller says.
    const mcp = (body: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { authorization: `Bearer ${keys.write!.key}`, accept: 'application/json, text/event-stream' },
        payload: body as object,
      });
    await mcp({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    const made = await mcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_request',
        arguments: {
          kind: 'infra_change',
          title: 'Over MCP',
          costCenter: 'GA-IT',
          amount: '100',
          recurrence: 'once',
          person: { email: people.tal.email },
          origin: { type: 'landflow_run', workflowId: 'wf_capacity', executionId: 'ex_9' },
        },
      },
    });
    const out = made.json().result;
    expect(out.isError, JSON.stringify(out)).toBeFalsy();
    expect(out.structuredContent.request).toMatchObject({
      origin: { type: 'mcp', verified: true },
      createdBy: { kind: 'key', id: keys.write!.id },
    });
  });

  // B4 ---------------------------------------------------------------------------------------------------------------

  it('B4: a split counts: $4,900 as ten requests of $490 gets one automatic approval, the rest go to a person', async () => {
    const out: { status: string; automatic: boolean; policy: { reason: string } }[] = [];
    for (let i = 0; i < 10; i++)
      out.push(
        await raise('tal', {
          costCenter: 'RND-DATA',
          title: `Split ${i + 1}`,
          recurrence: 'once',
          amount: { amount: '490', currency: 'USD' },
        }),
      );
    expect(out.filter((r) => r.automatic).length).toBe(1);
    expect(out.slice(1).every((r) => r.status === 'pending')).toBe(true);
    expect(out[1]!.policy.reason).toMatch(
      /With \$490\.00 approved by policy on RND-DATA this month, \$980\.00 reaches/,
    );
    const ev = (await as('tal', 'GET', `/api/requests?box=mine&costCenter=RND-DATA`)).json();
    expect(ev.requests.length).toBe(10);
  });

  it('B4: a ratchet counts per agent: small AI budgets on different cost centers reach a person', async () => {
    const agent = async (costCenter: string, amount: string) => {
      const r = await raiseByKey('write', {
        kind: 'ai_budget',
        costCenter,
        title: `Agent asks ${amount} on ${costCenter}`,
        recurrence: 'once',
        amount: { amount, currency: 'USD' },
        requester: {
          kind: 'agent',
          agent: { id: 'ag_ratchet', name: 'Ratchet agent', system: 'landflow' },
          sponsor: { email: people.tal.email },
        },
      });
      const ok = await as('tal', 'POST', `/api/requests/${r.id}/confirm`, {});
      expect(ok.statusCode, ok.body).toBe(200);
      return ok.json().request;
    };
    const a = await agent('ENG-AGENTS', '200');
    expect(a).toMatchObject({ status: 'approved', automatic: true });
    const b = await agent('GA-IT', '200');
    expect(b).toMatchObject({ status: 'approved', automatic: true });
    const c = await agent('CS-SUPPORT', '200');
    expect(c).toMatchObject({ status: 'pending', automatic: false });
    expect(c.policy.reason).toMatch(/approved by policy for agent Ratchet agent this month, \$600\.00 reaches/);
    expect((await as('tal', 'GET', `/api/requests/${c.id}`)).json().evidence.automaticThisMonth.agent).toBe(
      '400.000000',
    );
  });

  it('B4: nothing is automatic while the cost center is at risk or over budget', async () => {
    // ENG-PRODUCT's dev budget is $5: over already.
    const r = await raise('tal', {
      costCenter: 'ENG-PRODUCT',
      title: 'Small',
      amount: { amount: '50', currency: 'USD' },
    });
    expect(r).toMatchObject({ status: 'pending', automatic: false });
    expect(r.policy.reason).toMatch(/Nothing is automatic while ENG-PRODUCT is at risk or over budget/);
  });

  // Should-fix 1, 2 --------------------------------------------------------------------------------------------------

  it("1: a rate card version's lines are frozen once its request exists, and hashed into its evidence", async () => {
    const card = (await as('yoav', 'GET', '/api/rate-cards'))
      .json()
      .rateCards.find((c: { id: string }) => c.id === 'rc_internal');
    const v1 = card.versions.find((v: { status: string }) => v.status === 'approved');
    const cpu = v1.lines.find((l: { skuPriceId: string }) => /cpu/i.test(l.skuPriceId));
    const made = await as('yoav', 'POST', '/api/rate-cards/proposals', {
      effectiveFrom: '2026-11-15',
      changes: [{ skuPriceId: cpu.skuPriceId, unitPrice: String(Number(cpu.unitPrice) * 2) }],
      note: 'Cloud list price went up',
    });
    expect(made.statusCode, made.body).toBe(201);
    const { request: r, versionId } = made.json();
    const added = await as('yoav', 'POST', `/api/rate-cards/versions/${versionId}/ai-lines`);
    expect(added.statusCode, added.body).toBe(409);
    expect(added.json().error.message).toMatch(/frozen/);
    await expect(
      owner`INSERT INTO rate_lines (id, version_id, sku_id, sku_price_id, sku_meter, label, pricing_unit, unit_price,
                                    currency, position, added_by)
            VALUES ('rl_late', ${versionId}, 'x', 'x', 'x', 'x', '1 Hour', 1, 'USD', 999, 'test')`,
    ).rejects.toThrow(/frozen/);
    const shown = (await as('roni', 'GET', `/api/requests/${r.id}`)).json();
    const change = shown.evidence.rateCardChange;
    expect(change.versionId).toBe(versionId);
    const rows = await sql<
      {
        sku_price_id: string;
        label: string;
        pricing_unit: string;
        unit_price: string;
        currency: string;
        added_by: string;
      }[]
    >`SELECT sku_price_id, label, pricing_unit, unit_price::text AS unit_price, currency, added_by FROM rate_lines
      WHERE version_id = ${versionId} ORDER BY sku_price_id`;
    expect(change.lines).toBe(rows.length);
    expect(change.linesSha256).toBe(
      sha(
        canonicalSnapshot(
          rows.map((l) => ({
            skuPriceId: l.sku_price_id,
            label: l.label,
            pricingUnit: l.pricing_unit,
            unitPrice: l.unit_price,
            currency: l.currency.trim(),
            addedBy: l.added_by,
          })),
        ),
      ),
    );
    // The snapshot a decider is shown carries that hash.
    const [snap] = await sql<{ body: { evidence: { rateCardChange: { linesSha256: string } } } }[]>`
      SELECT body FROM evidence_snapshots WHERE request_id = ${r.id} AND sha256 = ${shown.evidenceSha256}`;
    expect(snap!.body.evidence.rateCardChange.linesSha256).toBe(change.linesSha256);
  });

  it('2: the folded approve routes need requests:write and a person, and audit the caller', async () => {
    // A version proposed before approvals became requests: no request yet.
    await owner`
      INSERT INTO rate_card_versions (id, rate_card_id, version, effective_from, hours_per_month, note, proposed_by)
      VALUES ('rcv_legacy', 'rc_internal', 99, '2026-12-01', 730, 'legacy', ${userId.yoav})`;
    expect((await as('avi', 'POST', '/api/rate-cards/versions/rcv_legacy/approve')).statusCode).toBe(403);
    expect((await withKey('read', 'POST', '/api/rate-cards/versions/rcv_legacy/approve')).statusCode).toBe(403);
    expect((await withKey('write', 'POST', '/api/rate-cards/versions/rcv_legacy/approve')).statusCode).toBe(403);
    expect((await as('avi', 'POST', '/api/allocation/rule-sets/versions/rsv_main_1/approve')).statusCode).toBe(403);
    const res = await as('roni', 'POST', '/api/rate-cards/versions/rcv_legacy/approve');
    expect(res.statusCode, res.body).toBe(409);
    const requestId = res.json().error.details.requestId;
    const rows = await sql<{ actor: string; action: string; data: Record<string, unknown> }[]>`
      SELECT actor, action, data FROM audit_log WHERE subject_id = ${requestId} ORDER BY seq`;
    expect(rows[0]).toMatchObject({
      actor: people.roni.email,
      action: 'request.created',
      data: { requester: people.yoav.email },
    });
    expect(rows.find((x) => x.action === 'request.submitted')!.actor).toBe(people.roni.email);
    const r = (await as('roni', 'GET', `/api/requests/${requestId}`)).json().request;
    expect(r.requester.person.email).toBe(people.yoav.email);
    expect(r.createdBy).toMatchObject({ kind: 'person', id: userId.roni });
  });

  // Should-fix 3, 13 -------------------------------------------------------------------------------------------------

  it('3, 13: a decision cites evidence served to its decider within 30 minutes, before the step deadline', async () => {
    const r = await raise('tal', { costCenter: 'GA-IT', title: 'Fresh', amount: { amount: '1500', currency: 'USD' } });
    const shown = (await as('shira', 'GET', `/api/requests/${r.id}`)).json();
    expect(shown.servedAt).toBe(now.toISOString());
    const [served] = await sql`
      SELECT to_kind, to_id FROM evidence_serves WHERE request_id = ${r.id} AND sha256 = ${shown.evidenceSha256}
        AND to_kind = 'person'`;
    expect(served).toMatchObject({ to_kind: 'person', to_id: userId.shira });
    now = new Date(START.getTime() + 31 * 60_000);
    const old = await as('shira', 'POST', `/api/requests/${r.id}/decisions`, {
      outcome: 'approve',
      evidenceSha256: shown.evidenceSha256,
    });
    expect(old.statusCode).toBe(409);
    expect(old.json().error.message).toBe('The request changed or the evidence is stale; reopen it');
    // A relay's card older than 30 minutes is stale too.
    const card = (await withKey('relay', 'GET', `/api/requests/${r.id}`)).json();
    now = new Date(START.getTime() + 62 * 60_000);
    const staleRelay = await relay(press({ requestId: r.id, step: 1, hash: card.evidenceSha256, user: 'U_SHIRA' }));
    expect(staleRelay.statusCode, staleRelay.body).toBe(409);
    // Past the step's deadline, no decision even before the job escalates it.
    now = new Date('2026-11-17T10:00:01Z');
    const late = await decide('shira', r.id, 'approve');
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toMatch(/deadline passed/);
    now = START;
  });

  // Should-fix 6 -----------------------------------------------------------------------------------------------------

  it("6: a cost center's owner and deputies decide its budget owner step; the group only without an owner", async () => {
    expect(
      (await as('tal', 'PUT', '/api/cost-centers/ENG-PLATFORM/owners', { owner: { email: people.noa.email } }))
        .statusCode,
    ).toBe(403);
    const refused = await as('dana', 'PUT', '/api/cost-centers/ENG-PLATFORM/owners', {
      owner: { email: people.admin.email },
    });
    expect(refused.statusCode).toBe(400);
    const set = await as('dana', 'PUT', '/api/cost-centers/ENG-PLATFORM/owners', {
      owner: { email: people.noa.email },
      deputies: [{ email: people.yoav.email }],
      note: 'Platform',
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ owner: { email: people.noa.email }, deputies: [{ email: people.yoav.email }] });
    const r = await raise('tal', {
      costCenter: 'ENG-PLATFORM',
      title: 'Owned',
      amount: { amount: '1500', currency: 'USD' },
    });
    const step = r.steps[0];
    expect(step.approvers.costCenterOwner).toMatchObject({ email: people.noa.email });
    expect(step.approvers.people.map((p: { email: string }) => p.email).sort()).toEqual(
      [people.noa.email, people.yoav.email].sort(),
    );
    // Shira is in Budget Owners, but not this cost center's owner.
    expect((await decide('shira', r.id, 'approve')).statusCode).toBe(403);
    const ok = await decide('yoav', r.id, 'approve');
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().decision.ownerRole).toBe('deputy');
    // Without an owner the step falls back to the group and says so.
    const plain = await raise('tal', {
      costCenter: 'GA-IT',
      title: 'No owner',
      amount: { amount: '1500', currency: 'USD' },
    });
    expect(plain.steps[0].approvers.fallback).toMatch(/GA-IT has no owner mapped/);
    // The owner raised it: straight to escalation (Finance), and the step says why.
    const mine = await raise('noa', {
      costCenter: 'ENG-PLATFORM',
      title: 'Noa asks',
      amount: { amount: '1500', currency: 'USD' },
    });
    await as('dana', 'PUT', '/api/cost-centers/ENG-PLATFORM/owners', { owner: { email: people.noa.email } });
    const mine2 = await raise('noa', {
      costCenter: 'ENG-PLATFORM',
      title: 'Noa asks again',
      amount: { amount: '1500', currency: 'USD' },
    });
    expect(mine.steps[0].approvers.people.map((p: { email: string }) => p.email)).toEqual([people.yoav.email]);
    expect(mine2.steps[0]).toMatchObject({ escalatedTo: ['Finance Controllers', 'Finance CFO'] });
    expect(mine2.steps[0].note).toMatch(/Noa Peretz, the cost center's owner, raised this request/);
    expect(mine2.steps[0].approvers.people.map((p: { email: string }) => p.email)).toContain(people.roni.email);
  });

  // Should-fix 7, 8, 9, 10, nits ---------------------------------------------------------------------------------------

  it('7, 8: only the creating key, the requester or an admin person releases a reservation or marks it applied', async () => {
    const r = await raiseByKey('write+reserve', {
      costCenter: 'ENG-AGENTS',
      title: 'Small node',
      amount: { amount: '100', currency: 'USD' },
    });
    const ok = await as('tal', 'POST', `/api/requests/${r.id}/confirm`, {});
    const live = ok.json().request;
    expect(live).toMatchObject({ status: 'approved', automatic: true });
    const rsv = live.reservations[0].id;
    expect((await withKey('write', 'POST', `/api/requests/${r.id}/applied`, {})).statusCode).toBe(403);
    expect((await as('shira', 'POST', `/api/requests/${r.id}/applied`, {})).statusCode).toBe(403);
    expect((await as('shira', 'POST', `/api/reservations/${rsv}/release`, {})).statusCode).toBe(403);
    expect(
      (await withKey('write+reserve', 'POST', `/api/reservations/${rsv}/release`, { reason: 'done' })).statusCode,
    ).toBe(200);
    const applied = await withKey('write+reserve', 'POST', `/api/requests/${r.id}/applied`, { note: 'in place' });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().request.you.canManage).toBe(true);
    // An admin person may too.
    const r2 = await raise('tal', {
      costCenter: 'ENG-AGENTS',
      title: 'Another',
      amount: { amount: '100', currency: 'USD' },
    });
    expect((await as('dana', 'POST', `/api/reservations/${r2.reservations[0].id}/release`, {})).statusCode).toBe(200);
  });

  it('9, nits: only USD; an idempotency key replayed with another body is 409', async () => {
    const eur = await as('tal', 'POST', '/api/requests', {
      kind: 'infra_change',
      title: 'Euro',
      costCenter: 'GA-IT',
      amount: { amount: '100', currency: 'EUR' },
      recurrence: 'once',
    });
    expect(eur.statusCode).toBe(422);
    expect(eur.json().error.message).toBe('Only USD until FX is set up');
    const body = {
      kind: 'infra_change',
      title: 'Once',
      costCenter: 'GA-IT',
      amount: { amount: '100', currency: 'USD' },
      recurrence: 'once',
      requester: { kind: 'person', person: { email: people.tal.email } },
      origin: { type: 'pull_request', url: 'https://github.test/x/pull/3' },
      idempotencyKey: 'replay-1',
    };
    expect((await withKey('write', 'POST', '/api/requests', body)).statusCode).toBe(201);
    expect((await withKey('write', 'POST', '/api/requests', body)).statusCode).toBe(200);
    const changed = await withKey('write', 'POST', '/api/requests', { ...body, title: 'Twice' });
    expect(changed.statusCode).toBe(409);
  });

  it('10: a backdated monthly request reserves from the current month', async () => {
    const r = await raise('tal', {
      costCenter: 'GA-IT',
      title: 'Since September',
      start: '2026-09-01',
      amount: { amount: '150', currency: 'USD' },
    });
    expect(r.status).toBe('approved');
    expect(r.reservations.map((v: { month: string }) => v.month)).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('nit: a single CFO who decided an earlier step: the CFO step escalates to the admin groups at once', async () => {
    await services.budgets.import(
      { csv: 'cost_center,month,amount,currency\nENG-PRODUCT,2026-11,1000000.00,USD\n', note: 'test' },
      principal('dana'),
    );
    const r = await raise('tal', {
      costCenter: 'ENG-PRODUCT',
      title: 'Huge',
      amount: { amount: '30000', currency: 'USD' },
    });
    expect(r.steps.map((s: { key: string }) => s.key)).toEqual(['budget_owner', 'finance', 'cfo']);
    expect((await decide('shira', r.id, 'approve')).statusCode).toBe(201);
    const fin = await decide('dana', r.id, 'approve');
    expect(fin.statusCode, fin.body).toBe(201);
    const cfo = fin.json().request.steps[2];
    expect(cfo).toMatchObject({ status: 'pending', escalatedTo: ['Finance Controllers', 'Finance CFO'] });
    expect(cfo.note).toMatch(/decided an earlier one/);
    expect(cfo.approvers.people.map((p: { email: string }) => p.email)).toContain(people.yoav.email);
    expect((await decide('yoav', r.id, 'approve')).statusCode).toBe(201);
    await services.budgets.import(
      { csv: 'cost_center,month,amount,currency\nENG-PRODUCT,2026-11,5.00,USD\n', note: 'test' },
      principal('dana'),
    );
  });

  // Should-fix 11 ----------------------------------------------------------------------------------------------------

  it('11: a reservation is consumed only by matched cost above its baseline, oldest first, never twice', async () => {
    const day = async (d: string, cpu: string) => {
      sources.state.cpuAllocated = cpu;
      await services.ingest.run('clickland', d, 'manual', 'test');
    };
    const body = {
      costCenter: 'ENG-PLATFORM',
      recurrence: 'once',
      amount: { amount: '600', currency: 'USD' },
      evidence: { match: { namespace: 'landflow-dev' } },
    };
    // ENG-PLATFORM is owned by Noa now: Yoav (deputy earlier) or Noa decide.
    const a = await raise('tal', { ...body, title: 'Older' });
    expect((await decide('noa', a.id, 'approve')).statusCode).toBe(201);
    const b = await raise('tal', { ...body, title: 'Newer' });
    expect((await decide('noa', b.id, 'approve')).statusCode).toBe(201);
    const none = await raise('tal', {
      costCenter: 'ENG-AGENTS',
      recurrence: 'once',
      title: 'No selector',
      amount: { amount: '90', currency: 'USD' },
    });
    const [ra] = (await as('tal', 'GET', `/api/reservations?month=2026-11&costCenter=ENG-PLATFORM`))
      .json()
      .reservations.filter((v: { requestId: string }) => v.requestId === a.id);
    const baseline = Number(ra.baselineDaily);
    expect(ra.consumption).toBe('matched');
    // The baseline: the matched cost's daily average over the 30 days before approval.
    const before = await services.spend.lines({ from: '2026-10-17', to: '2026-11-15' });
    const matched = before.lines
      .filter((l) => lineMatches(l, 'ENG-PLATFORM', { namespace: 'landflow-dev' }))
      .reduce((n, l) => n + Number(l.amount.toDecimal().toString()), 0);
    expect(baseline).toBeCloseTo(matched / 30, 5);
    expect(baseline).toBeGreaterThan(0);
    // Today the namespace allocates three times as much: only the increment above the baseline consumes.
    await day('2026-11-16', '6.000000');
    await services.allocation.allocatePending('2026-11');
    now = new Date('2026-11-17T08:00:00Z');
    await services.reservations.settle();
    const today = (await services.spend.lines({ from: '2026-11-16', to: '2026-11-16' })).lines
      .filter((l) => lineMatches(l, 'ENG-PLATFORM', { namespace: 'landflow-dev' }))
      .reduce((n, l) => n + Number(l.amount.toDecimal().toString()), 0);
    const list = (await as('tal', 'GET', `/api/reservations?month=2026-11&costCenter=ENG-PLATFORM`)).json()
      .reservations;
    const va = list.find((v: { requestId: string }) => v.requestId === a.id);
    const vb = list.find((v: { requestId: string }) => v.requestId === b.id);
    const increment = Math.max(0, today - baseline);
    expect(Number(va.consumed)).toBeCloseTo(Math.min(600, increment), 4);
    // The newer one sees only what the older one left: both together never exceed the increment over two baselines.
    expect(Number(va.consumed) + Number(vb.consumed)).toBeLessThanOrEqual(today + 1e-6);
    expect(Number(vb.consumed)).toBeCloseTo(Math.min(600, Math.max(0, today - Number(va.consumed) - baseline)), 4);
    // No selector: nothing consumes it, labelled so, and released at month end.
    const vn = (await as('tal', 'GET', `/api/reservations?month=2026-11&costCenter=ENG-AGENTS`))
      .json()
      .reservations.find((v: { requestId: string }) => v.requestId === none.id);
    expect(vn).toMatchObject({ consumption: 'none', baselineDaily: null, consumed: '0.000000' });
    now = new Date('2026-12-01T08:00:00Z');
    await services.reservations.settle();
    const ended = (await as('tal', 'GET', `/api/reservations?month=2026-11&costCenter=ENG-AGENTS`))
      .json()
      .reservations.find((v: { requestId: string }) => v.requestId === none.id);
    expect(ended.status).toBe('released');
    expect(ended.note).toMatch(/no match selector: nothing consumes it/);
    now = START;
    sources.state.cpuAllocated = '2.000000';
  });

  // Should-fix 12, 16 ------------------------------------------------------------------------------------------------

  it('12, 16: the over-budget check takes the first full month; the page shows the annual commitment', async () => {
    // CS-SUPPORT: room in November, $100 in December. $1,000 a month from 16 November fits November, not December.
    const r = await raise('tal', {
      costCenter: 'CS-SUPPORT',
      title: 'Desk seats',
      amount: { amount: '1000', currency: 'USD' },
    });
    const ev = (await as('tal', 'GET', `/api/requests/${r.id}`)).json().evidence;
    expect(ev.firstFullMonth).toMatchObject({
      month: '2026-12',
      adds: '1000.000000',
      budget: '100.000000',
      stateWith: 'over',
    });
    expect(ev.commitment).toMatchObject({ monthly: '1000.000000', annualised: '12000.000000' });
    expect(r.policy.reason).toMatch(/2026-12 budget, its first full month/);
    expect(r.steps.map((s: { key: string }) => s.key)).toContain('finance');
    // A service-like account in Finance Controllers is never an approver: listed apart, and refused.
    const fin = r.steps.find((s: { key: string }) => s.key === 'finance');
    expect(fin.approvers.people.map((p: { email: string }) => p.email)).not.toContain(people.admin.email);
    expect(fin.approvers.serviceAccounts.map((p: { email: string }) => p.email)).toContain(people.admin.email);
  });

  // Should-fix 14, 15 ------------------------------------------------------------------------------------------------

  it("14, 15: exceptions count budget and what each request's match selects; the weekly report is stored with its hash", async () => {
    // The review's case: ENG-PLATFORM with a budget ($1 now), a day of heavy cluster cost, an approved request without
    // a match ($1,500 a month from 16 November: it covers its cost center up to the $750 it adds in November) and two
    // approved one-offs of $600 whose match selects the namespace (each covers only matched cost, oldest first).
    await services.budgets.import(
      { csv: 'cost_center,month,amount,currency\nENG-PLATFORM,2026-11,1.00,USD\n', note: 'test' },
      principal('dana'),
    );
    sources.state.cpuAllocated = '150000.000000';
    await services.ingest.run('clickland', '2026-11-09', 'manual', 'test');
    sources.state.cpuAllocated = '2.000000';
    await services.allocation.allocatePending('2026-11');
    const report = (await as('avi', 'GET', '/api/exceptions?month=2026-11')).json();
    const row = report.rows.find((x: { costCenter: string }) => x.costCenter === 'ENG-PLATFORM');
    const lines = (await services.spend.lines({ fromMonth: '2026-11', toMonth: '2026-11' })).lines.filter(
      (l) => !l.correction && l.costCenter === 'ENG-PLATFORM',
    );
    const actual = lines.reduce((n, l) => n + Number(l.amount.toDecimal().toString()), 0);
    expect(row, JSON.stringify({ actual, rows: report.rows })).toBeTruthy();
    expect(Number(row.actual)).toBeCloseTo(actual, 5);
    expect(row.budget).toBe('1.000000');
    const by = (title: string) => row.requests.find((q: { title: string }) => q.title === title);
    expect(by('Owned')).toMatchObject({ covers: 'cost_center', amount: '750.000000' });
    expect(by('Older')).toMatchObject({ covers: 'match', amount: '600.000000' });
    expect(by('Newer')).toMatchObject({ covers: 'match', amount: '600.000000' });
    expect(row.covered).toBe('1950.000000');
    expect(Number(row.uncovered)).toBeCloseTo(actual - 1 - 1950, 5);
    await services.exceptions.weekly();
    const stored = (await as('avi', 'GET', '/api/exceptions/reports')).json().reports;
    expect(stored.length).toBe(1);
    const one = (await as('avi', 'GET', `/api/exceptions/reports/${stored[0].id}`)).json();
    expect(one.sha256).toBe(sha(canonicalSnapshot(one.report)));
    const [entry] = await sql`SELECT data FROM audit_log WHERE action = 'exceptions.weekly_report'`;
    expect(entry!.data).toMatchObject({ sha256: one.sha256 });
    expect((await outbox('report.exceptions')).at(-1)).toMatchObject({ id: one.id, sha256: one.sha256 });
    await expect(owner`UPDATE exception_reports SET rows = 0`).rejects.toThrow();
  });

  // Should-fix 17 ----------------------------------------------------------------------------------------------------

  it('17: the evidence pack has the request, every snapshot served, the decisions, the audit and the chain proof', async () => {
    const r = await raise('tal', {
      costCenter: 'GA-IT',
      title: 'Pack me',
      amount: { amount: '1300', currency: 'USD' },
    });
    expect((await decide('shira', r.id, 'approve', 'fine')).statusCode).toBe(201);
    const pack = (await as('avi', 'GET', `/api/requests/${r.id}/evidence-pack`)).json();
    expect(pack.request.id).toBe(r.id);
    expect(pack.decisions).toHaveLength(1);
    const cited = pack.snapshots.find((s: { sha256: string }) => s.sha256 === pack.decisions[0].evidenceSha256);
    expect(cited.served.map((v: { to: string }) => v.to)).toContain(people.shira.email);
    expect(pack.audit.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['request.created', 'request.submitted', 'request.step_approved', 'request.approved']),
    );
    expect(pack.chain).toMatchObject({ ok: true });
    expect(pack.chain.to).toBeGreaterThanOrEqual(pack.chain.from);
    const html = await as('avi', 'GET', `/api/requests/${r.id}/evidence-pack?format=html`);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.body).toContain('Evidence pack');
    expect(html.body).toContain('UTC');
  });

  // Back-channel logout ----------------------------------------------------------------------------------------------

  it("ends a person's sessions created before each logout token's iat; a seen jti is a replay (review of wave 3)", async () => {
    const session = await signIn('tal');
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { ll_session: session } })).statusCode,
    ).toBe(200);
    // Tal's session started a minute ago; Landbright's token was issued 30 seconds ago.
    await owner`UPDATE sessions SET created_at = created_at - interval '1 minute' WHERE user_id = ${userId.tal}`;
    const iat = Math.floor(Date.now() / 1000) - 30;
    const post = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/backchannel-logout',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `logout_token=${encodeURIComponent(token)}`,
      });
    expect((await post(await fake.logoutToken('sub-tal', { nonce: 'n' }))).statusCode).toBe(400);
    expect((await post(await fake.logoutToken('sub-tal', { events: { other: {} } }))).statusCode).toBe(400);
    expect((await post(await fake.logoutToken('sub-tal', { audience: 'someone-else' }))).statusCode).toBe(400);
    const token = await fake.logoutToken('sub-tal', { jti: 'jti-1', iat });
    // Every session of Tal's still live (this one, and the suite's own sign-in), all started before the iat.
    const [{ live }] = (await sql`
      SELECT count(*)::int AS live FROM sessions WHERE user_id = ${userId.tal} AND revoked_at IS NULL
        AND expires_at > now()`) as unknown as [{ live: number }];
    expect(live).toBeGreaterThanOrEqual(1);
    const res = await post(token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { ll_session: session } })).statusCode,
    ).toBe(401);
    // The token's hash and iat are kept for the audit, never the token.
    const [kept] = await sql`SELECT token_sha256, iat FROM logout_tokens WHERE jti = 'jti-1'`;
    expect(kept!.token_sha256).toBe(createHash('sha256').update(token).digest('hex'));
    expect(new Date(kept!.iat).getTime()).toBe(iat * 1000);
    // The same token again answers 200 and ends nothing new: Tal's session signed in after its iat survives, and it is
    // audited as a replay.
    const again = await signIn('tal');
    const replay = await post(token);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { ll_session: again } })).statusCode).toBe(
      200,
    );
    // A reused jti on a token that fails verification is still refused.
    expect((await post(await fake.logoutToken('sub-tal', { jti: 'jti-1', nonce: 'n' }))).statusCode).toBe(400);
    expect((await post(await fake.logoutToken('sub-tal', { jti: 'jti-1', audience: 'someone-else' }))).statusCode).toBe(
      400,
    );
    // A validly signed token always counts, whatever its jti: the same jti for another person ends that person's
    // sessions created before its iat (answering 200, audited as a replay); a later session survives.
    const shira = await signIn('shira');
    const other = await post(await fake.logoutToken('sub-shira', { jti: 'jti-1', iat }));
    expect(other.statusCode, other.body).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { ll_session: shira } })).statusCode).toBe(
      200,
    );
    // A row kept with no sub (before the hash was) is an earlier sighting: a retry answers 200, never 400.
    await owner`INSERT INTO logout_tokens (jti, sub) VALUES ('jti-old', NULL)`;
    const old = await post(await fake.logoutToken('sub-tal', { jti: 'jti-old', iat }));
    expect(old.statusCode, old.body).toBe(200);
    const logouts = await sql`SELECT data FROM audit_log WHERE action = 'auth.backchannel_logout'`;
    expect(logouts).toHaveLength(1);
    expect(logouts[0]!.data).toMatchObject({ sub: 'sub-tal', sessions: live });
    const replays = await sql`SELECT data FROM audit_log WHERE action = 'auth.backchannel_logout_replay' ORDER BY seq`;
    expect(replays.map((r) => [r.data.sub, r.data.jti, r.data.sessions, r.data.sameToken])).toEqual([
      ['sub-tal', 'jti-1', 0, true],
      ['sub-shira', 'jti-1', 0, false],
      ['sub-tal', 'jti-old', 0, null],
    ]);
    cookie.tal = await signIn('tal');
    cookie.shira = await signIn('shira');
    await owner`UPDATE users SET last_seen_at = ${START} WHERE id IN (${userId.tal}, ${userId.shira})`;
  });
});
