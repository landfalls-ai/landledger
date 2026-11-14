/**
 * Wave 2 against Postgres (LANDLEDGER_INTEGRATION=db): every policy path, the requester never approves, relays carry a
 * named person's decision and nothing else decides, an agent never decides, deadlines escalate and then expire,
 * reservations move budget left, auditors read and never write, the weekly exceptions report, and rate card, rule set
 * and policy changes as requests. People sign in through a fake Landbright with their groups.
 */
import { createTestDatabase, integrationEnabled, type TestDatabase } from '@landledger/schema/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { addBusinessHours } from '../src/business-hours.js';
import { createSql, type Sql } from '../src/db.js';
import { DEV_PRINCIPAL, type Principal } from '../src/principal.js';
import { RATE_CARD_V1, seed } from '../src/seed.js';
import { createServices, type Services } from '../src/services.js';
import { fakeLandbright, ISSUER, oidcConfig, type Person } from './fake-oidc.js';
import { call, fakeSources, testConfig } from './fakes.js';

const people = {
  tal: { sub: 'sub-tal', email: 'tal.levi@landbright.test', name: 'Tal Levi', roles: ['Engineering'] },
  shira: { sub: 'sub-shira', email: 'shira.navon@landbright.test', name: 'Shira Navon', roles: ['Budget Owners'] },
  noa: {
    sub: 'sub-noa',
    email: 'noa.peretz@landbright.test',
    name: 'Noa Peretz',
    roles: ['Budget Owners', 'Engineering'],
  },
  yoav: {
    sub: 'sub-yoav',
    email: 'yoav.bendavid@landbright.test',
    name: 'Yoav Ben David',
    roles: ['Finance Controllers'],
  },
  roni: { sub: 'sub-roni', email: 'roni.amar@landbright.test', name: 'Roni Amar', roles: ['Finance Controllers'] },
  dana: { sub: 'sub-dana', email: 'dana.shalev@landbright.test', name: 'Dana Shalev', roles: ['Finance CFO'] },
  avi: { sub: 'sub-avi', email: 'avi.auditor@landbright.test', name: 'Avi Auditor', roles: ['Landledger Auditors'] },
} satisfies Record<string, Person>;
type Who = keyof typeof people;

const sources = fakeSources();

describe.skipIf(!integrationEnabled('db'))('wave 2: requests, decisions, reservations', () => {
  let db: TestDatabase;
  let sql: Sql;
  let services: Services;
  let app: FastifyInstance;
  let fake: Awaited<ReturnType<typeof fakeLandbright>>;
  // Monday 16 November 2026, 10:00 UTC: deadlines are business hours from here.
  let now = new Date('2026-11-16T10:00:00Z');
  const cookie: Record<Who, string> = {} as Record<Who, string>;
  const userId: Record<Who, string> = {} as Record<Who, string>;
  const principal = (who: Who): Principal => ({
    kind: 'person',
    id: userId[who],
    name: people[who].name,
    email: people[who].email,
    roles: who === 'dana' ? ['cfo'] : who === 'yoav' || who === 'roni' ? ['controller'] : [],
    groups: people[who].roles,
    scopes: ['read', 'requests:write', 'admin'],
  });
  let writeKey = '';
  let relayKey = '';
  let reserveKey = '';

  beforeAll(async () => {
    db = await createTestDatabase();
    sql = createSql(db.appUrl);
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
      const login = await app.inject({ method: 'GET', url: '/api/auth/login' });
      const state = login.cookies.find((c) => c.name === 'll_login')!.value;
      const q = fake.authorize(login.headers.location!, people[who]);
      const cb = await app.inject({
        method: 'GET',
        url: `/api/auth/oidc/callback?${new URLSearchParams(q)}`,
        cookies: { ll_login: state },
      });
      cookie[who] = cb.cookies.find((c) => c.name === 'll_session')!.value;
      const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE subject = ${people[who].sub}`;
      userId[who] = u!.id;
    }
    // Wave 1's state: rate card v1 and rule set v1 approved (directly, as before requests), one day of cluster cost.
    await services.rateCards.importAiLines(RATE_CARD_V1, await services.landflow!.prices(), principal('roni'));
    await services.rateCards.approve(RATE_CARD_V1, principal('yoav'));
    await services.allocation.approve('rsv_main_1', principal('dana'));
    await services.ingest.run('clickland', '2026-11-15', 'manual', 'test');
    await services.allocation.allocatePending('2026-11');
    // Review of wave 2: nothing is automatic while a cost center is at risk or over, so AI Agents and Data & ML get room
    // for the automatic requests below (the seed's tiny dev budgets are over already).
    await services.budgets.import(
      {
        csv: 'cost_center,month,amount,currency\nENG-AGENTS,2026-11,300.00,USD\nRND-DATA,2026-11,5000.00,USD\n',
        note: 'test',
      },
      principal('dana'),
    );
    // Wave 3 (decision 8): a month with no budget is never on track, so December (these monthly requests' first full
    // month) gets November's budgets, and the paths below stay as wave 2 tested them.
    const nov = await services.budgets.forMonth('2026-11');
    await services.budgets.import(
      {
        csv: `cost_center,month,amount,currency\n${[...nov.entries()]
          .map(([code, b]) => `${code},2026-12,${b.amount.toDecimal().toString()},USD`)
          .join('\n')}\n`,
        note: 'test: December like November',
      },
      principal('dana'),
    );
    const key = async (
      name: string,
      scopes: ('requests:write' | 'decisions:relay' | 'reservations:write' | 'read')[],
    ) => (await services.keys.create({ name, scopes }, principal('dana'))).key;
    writeKey = await key('landflow requests', ['read', 'requests:write']);
    relayKey = await key('landflow relay', ['read', 'decisions:relay']);
    reserveKey = await key('landflow reservations', ['read', 'reservations:write']);
    // A webhook that takes every wave 2 event, to see what the outbox holds.
    await services.webhooks.create(
      {
        url: 'https://receiver.test/hook',
        events: ['request.created', 'request.step_pending', 'request.decided', 'request.applied', 'budget.at_risk'],
        description: 'test',
      } as never,
      principal('dana'),
    );
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  const as = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      cookies: { ll_session: cookie[who] },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const withKey = (key: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}` },
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
  /** What a person does in the console: open the request, then decide on the evidence they were shown. */
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

  it('counts deadlines in business hours: Friday afternoon to Monday afternoon', () => {
    const fri = new Date('2026-11-20T15:00:00Z');
    expect(addBusinessHours(fri, 24, [1, 2, 3, 4, 5]).toISOString()).toBe('2026-11-23T15:00:00.000Z');
    expect(addBusinessHours(new Date('2026-11-21T09:00:00Z'), 24, [1, 2, 3, 4, 5]).toISOString()).toBe(
      '2026-11-24T00:00:00.000Z',
    );
    expect(addBusinessHours(new Date('2026-11-22T09:00:00Z'), 24, [0, 1, 2, 3, 4]).toISOString()).toBe(
      '2026-11-23T09:00:00.000Z',
    );
  });

  it('approves under the threshold by policy at once, and reserves its months', async () => {
    const r = await raise('tal', {
      title: 'A bigger node',
      costCenter: 'ENG-AGENTS',
      amount: { amount: '120.00', currency: 'USD' },
    });
    expect(r).toMatchObject({ status: 'approved', automatic: true, steps: [], decisions: [] });
    expect(r.policy.reason).toMatch(/under the automatic threshold of \$500\.00/);
    // 16 to 30 November is 15 of 30 days: half a month; then December and January whole.
    expect(r.reservations.map((v: { month: string; amount: string }) => [v.month, v.amount])).toEqual([
      ['2026-11', '60.000000'],
      ['2026-12', '120.000000'],
      ['2026-01'.replace('2026', '2027'), '120.000000'],
    ]);
    const ov = (await as('tal', 'GET', '/api/overview?month=2026-11')).json();
    const agents = ov.costCenters.find((c: { code: string }) => c.code === 'ENG-AGENTS');
    expect(agents.reserved).toBe('60.000000');
    expect(Number(ov.reserved)).toBeGreaterThanOrEqual(60);
    const budgets = (await as('tal', 'GET', '/api/budgets?month=2026-11')).json();
    const row = budgets.rows.find((c: { code: string }) => c.code === 'ENG-AGENTS');
    expect(Number(row.available)).toBeCloseTo(Number(row.budget) - Number(row.monthToDate) - 60, 6);
    const decided = await outbox('request.decided');
    expect(decided.at(-1)).toMatchObject({ outcome: 'approved', decision: null });
  });

  let live = '';
  it('sends $1,840 a month to the budget owner, then Finance (it takes the cost center over budget); the requester never approves', async () => {
    const r = await raise('tal', {
      title: 'Second node pool for Landflow runners',
      costCenter: 'ENG-PLATFORM',
      amount: { amount: '1840.00', currency: 'USD' },
      evidence: { lines: [{ label: '2 × m7i.2xlarge', amount: '1840.00' }], match: { namespace: 'landflow-dev' } },
      origin: { type: 'landflow_run', workflowId: 'wf_capacity', executionId: 'ex_42' },
    });
    live = r.id;
    expect(r.status).toBe('pending');
    expect(r.steps.map((s: { key: string; status: string }) => [s.key, s.status])).toEqual([
      ['budget_owner', 'pending'],
      ['finance', 'waiting'],
    ]);
    expect(r.policy.reason).toMatch(/takes the cost center over its 2026-11 budget/);
    expect(r.steps[0].approvers.people.map((p: { email: string }) => p.email).sort()).toEqual([
      people.noa.email,
      people.shira.email,
    ]);
    const pending = await outbox('request.step_pending');
    expect(pending.at(-1)).toMatchObject({
      step: { key: 'budget_owner', groups: ['Budget Owners'], escalated: false },
      url: `http://localhost:4811/requests/${live}`,
    });
    expect((pending.at(-1)!.approvers as { sub: string }[]).map((a) => a.sub).sort()).toEqual(['sub-noa', 'sub-shira']);

    const self = await decide('tal', live, 'approve');
    expect(self.statusCode).toBe(403);
    expect(self.json().error.message).toMatch(/You raised this request/);
    const notOwner = await decide('yoav', live, 'approve');
    expect(notOwner.statusCode).toBe(403);
    expect(notOwner.json().error.message).toMatch(/Budget Owners/);
    // Rejecting needs a reason.
    const bare = await decide('shira', live, 'reject');
    expect(bare.statusCode).toBe(400);
    // A hash Landledger never served is refused.
    const forged = await as('shira', 'POST', `/api/requests/${live}/decisions`, {
      outcome: 'approve',
      evidenceSha256: 'a'.repeat(64),
    });
    expect(forged.statusCode).toBe(400);

    const first = await decide('shira', live, 'approve', 'Capacity plan checked');
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().request.steps.map((s: { status: string }) => s.status)).toEqual(['approved', 'pending']);
    // Shira decided step 1; step 2 is Finance's, and she isn't in it.
    expect((await decide('shira', live, 'approve')).statusCode).toBe(403);
    const second = await decide('yoav', live, 'approve', 'Within the quarter plan');
    expect(second.statusCode, second.body).toBe(201);
    const done = second.json().request;
    expect(done.status).toBe('approved');
    expect(done.decisions.map((d: { person: { email: string }; via: string }) => [d.person.email, d.via])).toEqual([
      [people.shira.email, 'console'],
      [people.yoav.email, 'console'],
    ]);
    expect(done.reservations.map((v: { month: string; amount: string }) => [v.month, v.amount])).toEqual([
      ['2026-11', '920.000000'],
      ['2026-12', '1840.000000'],
      ['2027-01', '1840.000000'],
    ]);
    // Once approved, "now" is without its own reservation, so the evidence reads as it did when it was decided.
    const ev = (await as('avi', 'GET', `/api/requests/${live}`)).json().evidence;
    expect(Number(ev.leftNow) - Number(ev.leftAfter)).toBeCloseTo(920, 6);
    // The snapshot each person was shown is kept, and names the step they decided.
    const snap = await as('avi', 'GET', `/api/requests/${live}/evidence/${done.decisions[1].evidenceSha256}`);
    expect(snap.statusCode).toBe(200);
    expect(snap.json().body.request.currentStep).toBe(2);
    expect(snap.json().body.evidence.month).toBe('2026-11');
    // The database holds the rules too: no decision by the requester, no status moving back.
    await expect(
      sql`INSERT INTO decisions (id, request_id, step, step_key, outcome, decided_by, evidence_sha256, via)
          VALUES ('dec_x', ${live}, 2, 'finance', 'approve', ${userId.tal}, ${done.decisions[1].evidenceSha256}, 'console')`,
    ).rejects.toThrow();
    await expect(sql`UPDATE requests SET status = 'pending' WHERE id = ${live}`).rejects.toThrow(/forward/);
    await expect(sql`DELETE FROM decisions WHERE request_id = ${live}`).rejects.toThrow();
    expect((await as('avi', 'GET', '/api/audit/verify')).json()).toMatchObject({ ok: true });
    // Only the key that raised it, its requester or an admin person says it's in place (review of wave 2): the requester.
    expect((await withKey(writeKey, 'POST', `/api/requests/${live}/applied`, { note: 'x' })).statusCode).toBe(403);
    const applied = await as('tal', 'POST', `/api/requests/${live}/applied`, {
      note: 'Node pool created',
      links: [{ label: 'PR', url: 'https://github.test/landflow/pull/9' }],
    });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().request.status).toBe('applied');
    expect((await outbox('request.applied')).at(-1)).toMatchObject({ note: 'Node pool created' });
  });

  it('adds Finance above 5,000 and the CFO above 25,000; seats always go to the budget owner; in budget, the owner alone', async () => {
    await services.budgets.import(
      {
        csv: 'cost_center,month,amount,currency\nENG-PRODUCT,2026-11,100000.00,USD\nENG-PRODUCT,2026-12,100000.00,USD\n',
        note: 'test',
      },
      principal('dana'),
    );
    const path = async (body: Record<string, unknown>) =>
      (await raise('tal', { costCenter: 'ENG-PRODUCT', title: 'Path', ...body })).steps.map(
        (s: { key: string }) => s.key,
      );
    expect(await path({ amount: { amount: '1000', currency: 'USD' } })).toEqual(['budget_owner']);
    expect(await path({ amount: { amount: '500', currency: 'USD' } })).toEqual(['budget_owner']);
    expect(await path({ amount: { amount: '10000', currency: 'USD' } })).toEqual(['budget_owner', 'finance']);
    expect(await path({ amount: { amount: '30000', currency: 'USD' } })).toEqual(['budget_owner', 'finance', 'cfo']);
    expect(
      await path({ kind: 'tool_or_seat', amount: { amount: '100', currency: 'USD' }, recurrence: 'once' }),
    ).toEqual(['budget_owner']);
    const once = await raise('tal', {
      costCenter: 'ENG-PRODUCT',
      title: 'One-off',
      recurrence: 'once',
      amount: { amount: '6000', currency: 'USD' },
    });
    expect(once.steps.map((s: { key: string }) => s.key)).toEqual(['budget_owner', 'finance']);
    expect(once.end).toBe('2026-11-16');
    const draft = await raise('tal', {
      costCenter: 'ENG-PRODUCT',
      title: 'Draft',
      amount: { amount: '50', currency: 'USD' },
      submit: false,
    });
    expect(draft.status).toBe('draft');
    expect((await as('shira', 'POST', `/api/requests/${draft.id}/submit`)).statusCode).toBe(403);
    const sub = await as('tal', 'POST', `/api/requests/${draft.id}/submit`);
    expect(sub.json().request).toMatchObject({ status: 'approved', automatic: true });
    // A key retrying with the same idempotency key gets the first request back.
    const body = {
      kind: 'ai_budget',
      title: 'Evaluations budget',
      costCenter: 'ENG-PRODUCT',
      amount: { amount: '900', currency: 'USD' },
      recurrence: 'monthly',
      requester: { kind: 'person', person: { email: people.tal.email } },
      origin: { type: 'pull_request', url: 'https://github.test/x/pull/1' },
      idempotencyKey: 'run-1',
    };
    const a = await withKey(writeKey, 'POST', '/api/requests', body);
    const b = await withKey(writeKey, 'POST', '/api/requests', body);
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().request.id).toBe(a.json().request.id);
    // A key must say who asks and where it comes from.
    expect(
      (await withKey(writeKey, 'POST', '/api/requests', { ...body, requester: undefined, idempotencyKey: undefined }))
        .statusCode,
    ).toBe(400);
    expect(
      (await withKey(writeKey, 'POST', '/api/requests', { ...body, origin: undefined, idempotencyKey: 'run-2' }))
        .statusCode,
    ).toBe(400);
  });

  it('decides only as a signed-in person: an API key, the developer and an agent never decide (relays: review2 tests)', async () => {
    const r = await raise('tal', {
      costCenter: 'ENG-PRODUCT',
      title: 'Relay me',
      amount: { amount: '1200', currency: 'USD' },
    });
    const shown = (await withKey(relayKey, 'GET', `/api/requests/${r.id}`)).json();
    // The old relay (a key naming a person) is gone: every key gets 403 on the decisions route.
    for (const key of [writeKey, relayKey]) {
      const res = await withKey(key, 'POST', `/api/requests/${r.id}/decisions`, {
        outcome: 'approve',
        evidenceSha256: shown.evidenceSha256,
        channel: 'slack',
        person: { sub: 'sub-shira' },
      });
      expect(res.statusCode, res.body).toBe(403);
    }
    await expect(
      services.requests.decide(
        r.id,
        { outcome: 'approve', comment: '', evidenceSha256: shown.evidenceSha256 },
        DEV_PRINCIPAL,
      ),
    ).rejects.toThrow(/local developer is not a person/);
    // A signed-in person decides as themselves, on evidence served to them.
    const other = await as('noa', 'POST', `/api/requests/${r.id}/decisions`, {
      outcome: 'approve',
      evidenceSha256: shown.evidenceSha256,
      person: { email: people.shira.email },
    });
    expect(other.statusCode, other.body).toBe(403);
    // Evidence served to someone else (here, the key) is not evidence Noa saw: 409, reopen it.
    const notShown = await as('noa', 'POST', `/api/requests/${r.id}/decisions`, {
      outcome: 'approve',
      evidenceSha256: shown.evidenceSha256,
    });
    expect(notShown.statusCode, notShown.body).toBe(409);
    expect(notShown.json().error.message).toBe('The request changed or the evidence is stale; reopen it');
    const ok = await decide('shira', r.id, 'approve');
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().decision).toMatchObject({ via: 'console', person: { email: people.shira.email } });
  });

  it("lets an agent raise a request only with a sponsor, who can't decide it; MCP has no tool that decides", async () => {
    const agentBody = {
      kind: 'ai_budget',
      title: 'More tokens for the triage agent',
      costCenter: 'ENG-PRODUCT',
      amount: { amount: '1500', currency: 'USD' },
      recurrence: 'monthly',
      origin: { type: 'landflow_run', workflowId: 'wf_triage', executionId: 'ex_7' },
    };
    const noSponsor = await withKey(writeKey, 'POST', '/api/requests', {
      ...agentBody,
      requester: { kind: 'agent', agent: { id: 'ag_triage', name: 'Triage agent' } },
    });
    expect(noSponsor.statusCode).toBe(400);
    const res = await withKey(writeKey, 'POST', '/api/requests', {
      ...agentBody,
      requester: {
        kind: 'agent',
        agent: { id: 'ag_triage', name: 'Triage agent' },
        sponsor: { email: people.noa.email },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const r = res.json().request;
    expect(r.requester).toMatchObject({
      kind: 'agent',
      agent: { name: 'Triage agent' },
      sponsor: { email: people.noa.email },
    });
    expect(r.createdByKey).toBe('landflow requests');
    // A key named the sponsor: it waits for Noa's confirmation before it enters the policy (review of wave 2).
    expect(r).toMatchObject({ status: 'awaiting_confirmation', steps: [], confirmation: { status: 'waiting' } });
    expect((await as('shira', 'POST', `/api/requests/${r.id}/confirm`, {})).statusCode).toBe(403);
    const confirmed = await as('noa', 'POST', `/api/requests/${r.id}/confirm`, { comment: 'Yes, mine' });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    Object.assign(r, confirmed.json().request);
    expect(r.status).toBe('pending');
    expect(r.steps[0].approvers.people.map((p: { email: string }) => p.email)).toEqual([people.shira.email]);
    const sponsor = await decide('noa', r.id, 'approve');
    expect(sponsor.statusCode).toBe(403);
    expect(sponsor.json().error.message).toMatch(/You sponsor the agent/);

    const mcp = (body: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { authorization: `Bearer ${writeKey}`, accept: 'application/json, text/event-stream' },
        payload: body as object,
      });
    await mcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    const tools = (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).json().result.tools;
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_requests', 'get_request', 'create_request', 'reserve']));
    expect(names.filter((n: string) => /decide|approve|reject/.test(n))).toEqual([]);
    const made = await mcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'create_request',
        arguments: {
          kind: 'ai_budget',
          title: 'Agent asks over MCP',
          costCenter: 'ENG-PRODUCT',
          amount: '700',
          recurrence: 'monthly',
          agent: { id: 'ag_triage', name: 'Triage agent' },
          sponsor: { sub: 'sub-noa' },
        },
      },
    });
    const out = made.json().result;
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent.request).toMatchObject({
      createdVia: 'mcp',
      origin: { type: 'mcp', verified: true },
      status: 'awaiting_confirmation',
    });
    // The MCP's reserve needs reservations:write.
    const refused = await mcp({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'reserve', arguments: { requestId: live } },
    });
    expect(refused.json().result.isError).toBe(true);
  });

  it('escalates a step after its deadline, then expires the request after the escalated one', async () => {
    const r = await raise('tal', {
      costCenter: 'ENG-PRODUCT',
      title: 'Will expire',
      amount: { amount: '800', currency: 'USD' },
    });
    expect(r.steps[0].deadlineAt).toBe('2026-11-17T10:00:00.000Z');
    const before = (await as('dana', 'GET', `/api/requests/${r.id}`)).json().request;
    expect(before.you.canDecide).toBe(false);
    now = new Date('2026-11-17T11:00:00Z');
    await services.requests.expireDue();
    const esc = (await as('dana', 'GET', `/api/requests/${r.id}`)).json().request;
    expect(esc.steps[0]).toMatchObject({
      status: 'pending',
      escalatedTo: ['Finance CFO'],
      escalatedAt: '2026-11-17T11:00:00.000Z',
      deadlineAt: '2026-11-18T11:00:00.000Z',
    });
    expect(esc.you.canDecide).toBe(true);
    expect((await outbox('request.step_pending')).at(-1)).toMatchObject({ step: { escalated: true } });
    now = new Date('2026-11-18T12:00:00Z');
    await services.requests.expireDue();
    const gone = (await as('dana', 'GET', `/api/requests/${r.id}`)).json().request;
    expect(gone.status).toBe('expired');
    expect(gone.steps[0].status).toBe('expired');
    expect((await decide('dana', r.id, 'approve')).statusCode).toBe(409);
    expect((await outbox('request.decided')).at(-1)).toMatchObject({ outcome: 'expired' });
    now = new Date('2026-11-16T10:00:00Z');
  });

  it('reserves budget for approved requests only, and budget left counts what they hold', async () => {
    const before = (await as('tal', 'GET', '/api/budgets?month=2026-11')).json();
    const platform = before.rows.find((c: { code: string }) => c.code === 'ENG-PLATFORM');
    expect(platform.reserved).toBe('920.000000');
    expect(Number(platform.available)).toBeCloseTo(Number(platform.budget) - Number(platform.monthToDate) - 920, 6);
    expect(before.totals.reserved).not.toBe('0.000000');
    // Another month of the window: idempotent, capped, and only for an approved request.
    const feb = await withKey(reserveKey, 'POST', '/api/reservations', { requestId: live, month: '2027-02' });
    expect(feb.statusCode, feb.body).toBe(201);
    expect(
      (await withKey(reserveKey, 'POST', '/api/reservations', { requestId: live, month: '2027-02' })).statusCode,
    ).toBe(200);
    expect(
      (await withKey(reserveKey, 'POST', '/api/reservations', { requestId: live, month: '2027-03', amount: '5000' }))
        .statusCode,
    ).toBe(400);
    const pending = await raise('tal', {
      costCenter: 'ENG-PRODUCT',
      title: 'Pending',
      amount: { amount: '900', currency: 'USD' },
    });
    expect((await withKey(reserveKey, 'POST', '/api/reservations', { requestId: pending.id })).statusCode).toBe(409);
    expect(
      (await withKey(writeKey, 'POST', '/api/reservations', { requestId: live, month: '2027-03' })).statusCode,
    ).toBe(403);
    // Only the key that raised the request, its requester or an admin person releases (review of wave 2).
    expect(
      (await withKey(reserveKey, 'POST', `/api/reservations/${feb.json().reservation.id}/release`, {})).statusCode,
    ).toBe(403);
    const released = await as('tal', 'POST', `/api/reservations/${feb.json().reservation.id}/release`, {
      reason: 'plan changed',
    });
    expect(released.json().reservation).toMatchObject({ status: 'released', remaining: '0.000000' });
    // At month end what is left is released (the namespace's real cost consumed part of it).
    now = new Date('2026-12-02T08:00:00Z');
    await services.reservations.settle();
    const nov = (await as('tal', 'GET', '/api/reservations?month=2026-11&costCenter=ENG-PLATFORM')).json()
      .reservations[0];
    expect(nov.status).toBe('released');
    expect(nov.note).toMatch(/month ended/);
    now = new Date('2026-11-16T10:00:00Z');
    const after = (await as('tal', 'GET', '/api/budgets?month=2026-11')).json();
    expect(after.rows.find((c: { code: string }) => c.code === 'ENG-PLATFORM').reserved).toBe('0.000000');
  });

  it('lets auditors read everything and write nothing', async () => {
    for (const url of [
      '/api/requests?box=all',
      `/api/requests/${live}`,
      `/api/requests/${live}/decisions`,
      '/api/reservations',
      '/api/policies',
      '/api/audit',
      '/api/audit/verify',
      '/api/budgets',
      '/api/overview',
      '/api/spend?by=costCenter',
      '/api/exceptions',
      '/api/allocation/rule-sets',
      '/api/rate-cards',
    ])
      expect((await as('avi', 'GET', url)).statusCode, url).toBe(200);
    const me = (await as('avi', 'GET', '/api/auth/me')).json();
    expect(me).toMatchObject({ user: { roles: ['auditor'] }, scopes: ['read'] });
    const pending = (await as('avi', 'GET', '/api/requests?box=open')).json().requests[0];
    for (const [url, body] of [
      [
        '/api/requests',
        {
          kind: 'other',
          title: 'x',
          costCenter: 'GA-IT',
          amount: { amount: '1', currency: 'USD' },
          recurrence: 'once',
        },
      ],
      [`/api/requests/${pending.id}/cancel`, {}],
      [`/api/requests/${pending.id}/submit`, {}],
      [`/api/requests/${live}/applied`, {}],
      ['/api/reservations', { requestId: live }],
      ['/api/policies', {}],
      ['/api/rate-cards/proposals', {}],
      ['/api/allocation/rule-sets/proposals', {}],
      ['/api/keys', { name: 'x', scopes: ['read'] }],
      ['/api/webhooks', {}],
      ['/api/scim/tokens', { name: 'x' }],
      ['/api/budgets/import', { csv: 'x' }],
      ['/api/periods/2026-11/close', {}],
      ['/api/ingest/run', {}],
      ['/api/allocation/rebuild/2026-11', {}],
    ] as const)
      expect((await as('avi', 'POST', url, body)).statusCode, url).toBe(403);
    // Deciding is per step: an auditor is in no step's groups.
    const d = await decide('avi', pending.id, 'approve');
    expect(d.statusCode).toBe(403);
    expect(d.json().error.message).toMatch(/aren't in/);
  });

  it('makes a rate card change a request: preview, Finance then the CFO, never the proposer; approval applies it', async () => {
    const card = (await as('yoav', 'GET', '/api/rate-cards'))
      .json()
      .rateCards.find((c: { id: string }) => c.id === 'rc_internal');
    const v1 = card.versions.find((v: { status: string }) => v.status === 'approved');
    const cpu = v1.lines.find((l: { skuPriceId: string }) => /cpu/i.test(l.skuPriceId));
    const skuPriceId = cpu.skuPriceId as string;
    const unitPrice = String(Number(cpu.unitPrice) * 2);
    const preview = await as('yoav', 'POST', '/api/rate-cards/proposals/preview', {
      effectiveFrom: '2026-11-15',
      changes: [{ skuPriceId, unitPrice }],
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ month: '2026-11', currency: 'USD' });
    expect(Number(preview.json().proposed)).toBeGreaterThan(Number(preview.json().current));
    expect(preview.json().byLine[0].key).toBe(skuPriceId);
    const made = await as('yoav', 'POST', '/api/rate-cards/proposals', {
      effectiveFrom: '2026-11-15',
      changes: [{ skuPriceId, unitPrice }],
      note: 'Cloud list price went up',
    });
    expect(made.statusCode, made.body).toBe(201);
    const { request: r, versionId } = made.json();
    expect(r).toMatchObject({
      kind: 'rate_card_change',
      status: 'pending',
      change: { type: 'rate_card_version', versionId },
    });
    expect(r.steps.map((s: { key: string }) => s.key)).toEqual(['finance', 'cfo']);
    // The old route: 409 naming the request to decide.
    const old = await as('dana', 'POST', `/api/rate-cards/versions/${versionId}/approve`);
    expect(old.statusCode).toBe(409);
    expect(old.json().error.details.requestId).toBe(r.id);
    const proposer = await decide('yoav', r.id, 'approve');
    expect(proposer.statusCode).toBe(403);
    expect(proposer.json().error.message).toMatch(/You raised this request/);
    expect((await decide('roni', r.id, 'approve')).statusCode).toBe(201);
    expect((await decide('roni', r.id, 'approve')).statusCode).toBe(403);
    const last = await decide('dana', r.id, 'approve', 'Agreed');
    expect(last.statusCode, last.body).toBe(201);
    expect(last.json().request.status).toBe('applied');
    const [v] = await sql`SELECT approved_by FROM rate_card_versions WHERE id = ${versionId}`;
    expect(v!.approved_by).toBe(userId.dana);
    const [audit] = await sql`
      SELECT data FROM audit_log WHERE action = 'rate_card.version_approved' AND subject_id = ${versionId}`;
    expect(audit!.data).toMatchObject({ requestId: r.id, approvedBy: people.dana.email });
  });

  it('makes a rule set change and a policy change requests too; the new policy routes the next request', async () => {
    const current = (await as('yoav', 'GET', '/api/allocation/rule-sets')).json().versions[0];
    const rules = [
      {
        id: 'all-to-it',
        name: 'Everything to IT',
        selector: { source: '*' },
        target: { costCenter: 'GA-IT', plClass: 'ga', capitalisable: false },
      },
    ];
    const preview = (
      await as('yoav', 'POST', '/api/allocation/rule-sets/proposals/preview', { effectiveFrom: '2026-11-15', rules })
    ).json();
    expect(preview.byCostCenter.find((c: { code: string }) => c.code === 'GA-IT').delta).not.toBe('0.000000');
    const made = await as('yoav', 'POST', '/api/allocation/rule-sets/proposals', {
      effectiveFrom: '2026-11-15',
      rules: current.rules,
      shares: current.shares,
      note: 'Same rules, new version',
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().request.steps.map((s: { key: string }) => s.key)).toEqual(['finance', 'cfo']);
    expect((await decide('yoav', made.json().request.id, 'approve')).statusCode).toBe(403);

    // A policy for RND-DATA: automatic under USD 2,000 a month.
    const bad = await as('yoav', 'POST', '/api/policies', {
      policy: {
        kind: 'rate_card_change',
        automaticBelow: '10',
        steps: [{ key: 'f', label: 'F', approvers: { groups: ['Finance CFO'] }, when: { always: true } }],
      },
    });
    expect(bad.statusCode).toBe(400);
    const proposed = await as('yoav', 'POST', '/api/policies', {
      policy: {
        kind: 'infra_change',
        costCenter: 'RND-DATA',
        automaticBelow: '2000',
        steps: [
          {
            key: 'budget_owner',
            label: 'Budget owner',
            approvers: { groups: ['Budget Owners'] },
            when: { amountAtLeast: '2000' },
          },
        ],
      },
      note: 'Data jobs move fast',
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const pr = proposed.json().request;
    expect(pr.steps.map((s: { key: string }) => s.key)).toEqual(['finance', 'cfo']);
    expect((await decide('roni', pr.id, 'approve')).statusCode).toBe(201);
    expect((await decide('dana', pr.id, 'approve')).statusCode).toBe(201);
    const policies = (await as('tal', 'GET', '/api/policies')).json().policies;
    expect(policies.find((p: { id: string }) => p.id === proposed.json().versionId)).toMatchObject({
      current: true,
      status: 'approved',
    });
    const next = await raise('tal', {
      costCenter: 'RND-DATA',
      title: 'Bigger ClickHouse',
      amount: { amount: '1500', currency: 'USD' },
    });
    expect(next).toMatchObject({ status: 'approved', automatic: true });
  });

  it('reports spend above the threshold that no approved request covers', async () => {
    // A billion input tokens on Landflow's agents (ENG-AGENTS), which only the automatic $120 a month covers.
    sources.state.events = [call('2026-11-15T10:00:00.000Z', 1_000_000_000, 0)];
    await services.ingest.run('landflow', '2026-11-15', 'manual', 'test');
    await services.allocation.allocatePending('2026-11');
    const owned = { code: 'ENG-AGENTS' };
    const report = (await as('avi', 'GET', '/api/exceptions?month=2026-11')).json();
    const row = report.rows.find((x: { costCenter: string }) => x.costCenter === owned.code);
    expect(row).toMatchObject({ month: '2026-11', threshold: '500.000000', covered: '60.000000' });
    expect(Number(row.actual)).toBeGreaterThan(560);
    expect(row.requests.map((q: { title: string }) => q.title)).toEqual(['A bigger node']);
    // Uncovered = actual − budget − covered (review of wave 2).
    expect(row.budget).toBe('300.000000');
    expect(Number(row.uncovered)).toBeCloseTo(Number(row.actual) - 300 - Number(row.covered), 6);
    expect(report.unowned.map((u: { costCenter: string }) => u.costCenter)).toContain('SHARED-POOL');
    // ENG-PLATFORM's spend is covered by the approved $1,840 request: no exception.
    expect(report.rows.find((x: { costCenter: string }) => x.costCenter === 'ENG-PLATFORM')).toBeUndefined();
    await services.exceptions.weekly();
    const [entry] = await sql`SELECT data FROM audit_log WHERE action = 'exceptions.weekly_report'`;
    expect(entry).toBeTruthy();
    // Budget alerts: each over-budget cost center once.
    const sent = await services.exceptions.budgetAlerts();
    expect(sent).toBeGreaterThan(0);
    expect(await services.exceptions.budgetAlerts()).toBe(0);
    expect((await outbox('budget.at_risk')).length).toBe(sent);
  });

  it('cancels a pending request for its requester or an admin, never for someone else', async () => {
    const r = await raise('tal', {
      costCenter: 'ENG-PRODUCT',
      title: 'Cancel me',
      amount: { amount: '700', currency: 'USD' },
    });
    expect((await as('shira', 'POST', `/api/requests/${r.id}/cancel`, {})).statusCode).toBe(403);
    const c = await as('tal', 'POST', `/api/requests/${r.id}/cancel`, { reason: 'not needed' });
    expect(c.json().request).toMatchObject({ status: 'cancelled' });
    expect(c.json().request.steps[0].status).toBe('skipped');
    expect((await as('tal', 'POST', `/api/requests/${r.id}/cancel`, {})).statusCode).toBe(409);
    const inbox = (await as('shira', 'GET', '/api/requests?box=waiting')).json();
    expect(inbox.counts.waiting).toBe(inbox.requests.length);
    expect(inbox.requests.every((q: { you: { canDecide: boolean } }) => q.you.canDecide)).toBe(true);
    const mine = (await as('tal', 'GET', '/api/requests?box=mine&limit=200')).json();
    expect(
      mine.requests.every(
        (q: { requester: { person?: { email: string } } }) => q.requester.person?.email === people.tal.email,
      ),
    ).toBe(true);
  });
});
