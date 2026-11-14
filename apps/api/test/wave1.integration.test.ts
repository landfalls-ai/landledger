/**
 * Wave 1 against Postgres (LANDLEDGER_INTEGRATION=db): rate card approval, ingest from fake Landflow and Clickland
 * (idempotent runs, corrections, a locked month), allocation generations, budgets, the read API, exports and MCP.
 */
import { createTestDatabase, integrationEnabled, type TestDatabase } from '@landledger/schema/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createSql, type Sql } from '../src/db.js';
import type { Principal } from '../src/principal.js';
import { RATE_CARD_V1, seed } from '../src/seed.js';
import { createServices, type Services } from '../src/services.js';

const config: Config = {
  port: 0,
  host: '127.0.0.1',
  postgresUrl: '',
  consoleUrl: 'http://localhost:4811',
  bootstrapKey: 'll_bootstrap_test_key_0000000000000000',
  devAuth: true,
  sessionHours: 8,
  oidc: null,
  oidcProblem: 'tests',
  backgroundJobs: false,
  landflow: { url: 'http://landflow.test', key: 'lf_test', service: 'landflow-host', namespace: 'landflow-dev' },
  clickland: { url: 'http://clickland.test', key: 'ck_test', labels: [] },
  clicklandConsoleUrl: 'http://localhost:4711',
  costMetricsEndpoint: null,
  ingestJobs: false,
};

const person = (id: string, email: string, roles: Principal['roles']): Principal => ({
  kind: 'person',
  id,
  name: email,
  email,
  roles,
  groups: [],
  scopes: ['read', 'admin'],
});
const YOAV = person('usr_yoav', 'yoav.bendavid@landbright.test', ['controller']);
const DANA = person('usr_dana', 'dana.shalev@landbright.test', ['cfo']);
const TAL = person('usr_tal', 'tal.levi@landbright.test', ['engineer']);
const KEY: Principal = {
  kind: 'key',
  id: 'key_1',
  name: 'ingest bot',
  email: null,
  roles: [],
  groups: [],
  scopes: ['admin'],
};

// The sources: what they answer can change between runs, as a real source's late data would.
let events: unknown[] = [];
let cpuAllocated = '2.000000';
const rollup = (day: string) => ({
  rows: [
    {
      start: `${day}T00:00:00Z`,
      end: `${day}T00:00:00Z`,
      source: 'kubernetes',
      group: {
        'k8s.cluster.name': 'orbstack',
        'k8s.namespace.name': 'landflow-dev',
        'k8s.workload.kind': 'Deployment',
        'k8s.workload.name': 'landflow-host',
        'k8s.container.name': 'host',
      },
      cpuCoreHours: '1.000000',
      cpuAllocatedCoreHours: cpuAllocated,
      memoryGiBHours: '1.000000',
      memoryAllocatedGiBHours: '2.000000',
    },
    {
      start: `${day}T00:00:00Z`,
      end: `${day}T00:00:00Z`,
      source: 'docker',
      group: { 'compose.project': 'mystery', 'compose.service': 'thing', 'container.name': 'mystery-thing-1' },
      cpuCoreHours: '1.000000',
      cpuAllocatedCoreHours: '1.000000',
      memoryGiBHours: '0.000000',
      memoryAllocatedGiBHours: '0.000000',
    },
  ],
  capacity: [
    {
      start: `${day}T00:00:00Z`,
      end: `${day}T00:00:00Z`,
      cluster: 'orbstack',
      node: 'orbstack',
      cpuAllocatableCoreHours: '24.000000',
      memoryAllocatableGiBHours: '48.000000',
    },
  ],
  volumes: [],
  coverage: {
    sources: [
      { source: 'kubernetes', firstSample: `${day}T00:00:00Z`, lastSample: `${day}T23:59:00Z`, missingBuckets: [] },
    ],
    missing: [],
  },
});
const fetchImpl: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  const json = (b: unknown) =>
    new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.host === 'clickland.test') return json(rollup(JSON.parse(init!.body as string).from.slice(0, 10)));
  if (url.pathname === '/api/usage/events') {
    const from = url.searchParams.get('from')!;
    const to = url.searchParams.get('to')!;
    return json({ events: events.filter((e) => (e as { at: string }).at >= from && (e as { at: string }).at <= to) });
  }
  if (url.pathname === '/api/usage')
    return json({
      rows: [],
      totals: {
        count: events.filter(
          (e) =>
            (e as { at: string }).at >= url.searchParams.get('from')! &&
            (e as { at: string }).at <= url.searchParams.get('to')!,
        ).length,
        tokens: 0,
      },
    });
  if (url.pathname === '/api/agents') return json({ agents: [{ id: 'ag_1', name: 'Triage lead' }] });
  if (url.pathname === '/api/workflows') return json({ workflows: [] });
  if (url.pathname === '/api/settings/ai-prices')
    return json({
      defaults: [
        { provider: 'anthropic', model: 'claude-sonnet-4-5', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      ],
      overrides: [],
    });
  if (url.pathname === '/api/insights/ai-usage') return json({ models: [] });
  return new Response('not found', { status: 404 });
};

const call = (at: string, input: number, output: number, extra: Record<string, number> = {}) => ({
  id: `ev_${at}_${input}`,
  at,
  kind: 'ai.call',
  agentId: 'ag_1',
  workflowId: null,
  actorId: 'usr_x',
  cost: 0,
  attrs: { provider: 'anthropic', model: 'claude-sonnet-4-5', input, output, ...extra },
});

describe.skipIf(!integrationEnabled('db'))('wave 1 against Postgres', () => {
  let db: TestDatabase;
  let sql: Sql;
  let services: Services;
  let app: FastifyInstance;
  let now = new Date('2026-11-14T12:00:00Z');

  beforeAll(async () => {
    db = await createTestDatabase();
    sql = createSql(db.url);
    services = createServices({ ...config, postgresUrl: db.url }, sql, fetchImpl, undefined, () => now);
    app = await buildApp(services);
    expect(await seed(sql)).toBe(11);
    for (const p of [YOAV, DANA, TAL])
      await sql`INSERT INTO users (id, issuer, subject, email, name, roles) VALUES (${p.id}, 'test', ${p.id}, ${p.email}, ${p.name}, ${p.roles})`;
  });
  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
  });

  it('refuses cluster ingest until a rate card is approved, and records the failed run', async () => {
    const run = await services.ingest.run('clickland', '2026-11-13', 'manual', 'test');
    expect(run.outcome).toBe('failed');
    expect(run.error).toMatch(/No approved rate card/);
  });

  it('approves a rate card only by a finance person who did not propose it', async () => {
    expect(await services.rateCards.importAiLines(RATE_CARD_V1, await services.landflow!.prices(), 'test')).toBe(6); // four meters of the model, two of local Ollama
    await expect(services.rateCards.approve(RATE_CARD_V1, KEY)).rejects.toThrow(/API key never does/);
    await expect(services.rateCards.approve(RATE_CARD_V1, TAL)).rejects.toThrow(/controller or the CFO/);
    // The database refuses requester = approver, whatever the API says.
    await expect(
      sql`UPDATE rate_card_versions SET approved_by = 'usr_yoav', approved_at = now(), proposed_by = 'usr_yoav' WHERE id = ${RATE_CARD_V1}`,
    ).rejects.toThrow();
    const ok = await services.rateCards.approve(RATE_CARD_V1, YOAV);
    expect(ok.approvedBy).toBe('yoav.bendavid@landbright.test');
    await expect(services.rateCards.approve(RATE_CARD_V1, DANA)).rejects.toThrow(/already approved/);
    const [audit] = await sql`SELECT actor, data FROM audit_log WHERE action = 'rate_card.version_approved'`;
    expect(audit!.actor).toBe('yoav.bendavid@landbright.test');
    // Lines of an approved version never change.
    await expect(
      services.rateCards.importAiLines(RATE_CARD_V1, await services.landflow!.prices(), 'test'),
    ).rejects.toThrow(/approved/);
  });

  it('ingests a complete day once: a second run appends nothing', async () => {
    events = [call('2026-11-13T10:00:00.000Z', 1_000_000, 100_000, { cacheRead: 400_000, cacheWrite: 0 })];
    const first = await services.ingest.run('landflow', '2026-11-13', 'manual', 'test');
    expect(first).toMatchObject({ outcome: 'succeeded', provisional: false, newCount: 3, correctedCount: 0 });
    const again = await services.ingest.run('landflow', '2026-11-13', 'manual', 'test');
    expect(again).toMatchObject({ newCount: 0, correctedCount: 0, unchangedCount: 3 });
    const ck = await services.ingest.run('clickland', '2026-11-13', 'manual', 'test');
    expect(ck).toMatchObject({ outcome: 'succeeded', newCount: 5 }); // workload CPU and memory, Docker CPU, idle CPU and memory
    expect((await services.ingest.run('clickland', '2026-11-13', 'manual', 'test')).unchangedCount).toBe(5);
  });

  it('corrects a changed figure by reversal and re-entry, and reverses one that vanished', async () => {
    cpuAllocated = '3.000000';
    const run = await services.ingest.run('clickland', '2026-11-13', 'manual', 'test');
    // The workload's CPU and the idle CPU both changed.
    expect(run).toMatchObject({ newCount: 0, correctedCount: 2, unchangedCount: 3 });
    events = [];
    const lf = await services.ingest.run('landflow', '2026-11-13', 'manual', 'test');
    expect(lf.correctedCount).toBe(3);
    const [{ net }] =
      await sql`SELECT coalesce(sum(effective_cost_micros), 0)::text AS net FROM cost_records WHERE source = 'landflow'`;
    expect(net).toBe('0');
    // Capacity × rate still adds up exactly after the correction: 24 × 0.034 + 48 × 0.0045 = 1.032 (+ Docker 0.034).
    const [{ total }] =
      await sql`SELECT sum(effective_cost_micros)::text AS total FROM cost_records WHERE source = 'clickland'`;
    expect(total).toBe('1066000');
  });

  it('keeps today provisional and replaces it on every run', async () => {
    events = [call('2026-11-14T09:00:00.000Z', 1000, 10)];
    const a = await services.ingest.run('landflow', '2026-11-14', 'hourly', 'test');
    expect(a.provisional).toBe(true);
    events.push(call('2026-11-14T10:00:00.000Z', 2000, 20));
    await services.ingest.run('landflow', '2026-11-14', 'hourly', 'test');
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM provisional_usage WHERE source = 'landflow'`;
    expect(n).toBe(2); // input and output rows, the two calls summed
    // Once the day is complete it enters the ledger and leaves the provisional table.
    now = new Date('2026-11-15T03:00:00Z');
    const done = await services.ingest.run('landflow', '2026-11-14', 'daily', 'test');
    expect(done).toMatchObject({ provisional: false, newCount: 2 });
    const [{ m }] = await sql`SELECT count(*)::int AS m FROM provisional_usage WHERE source = 'landflow'`;
    expect(m).toBe(0);
    now = new Date('2026-11-14T12:00:00Z');
  });

  it('allocates under approved rules only, in generations; the shared pool and unallocated are their own lines', async () => {
    let spend = await services.spend.spend({
      by: 'costCenter',
      month: '2026-11',
      layer: 'direct',
      provisional: 'true',
    });
    expect(spend.groups.map((g) => g.key).sort()).toEqual(['SHARED-POOL', 'UNALLOCATED']); // no rules approved yet: idle is shared, the rest unallocated
    await expect(services.allocation.approve('rsv_main_1', KEY)).rejects.toThrow(/API key never does/);
    const { rebuilt } = await services.allocation.approve('rsv_main_1', DANA);
    // Generation 1 was built by the first ingest, under no rules; approval starts generation 2.
    expect(rebuilt.map((r) => [r.month, r.number])).toEqual([['2026-11', 2]]);
    spend = await services.spend.spend({ by: 'costCenter', month: '2026-11', layer: 'direct', provisional: 'true' });
    const by = Object.fromEntries(spend.groups.map((g) => [g.key, g.total]));
    expect(by['ENG-PLATFORM']).toBe('0.111000'); // landflow-host: 3 core-hours × 0.034 + 2 GiB-hours × 0.0045
    expect(by['UNALLOCATED']).toBe('0.034000'); // the compose project no rule names
    expect(Object.keys(by)).toContain('SHARED-POOL');
    // The spread layer shares the pool out and keeps the total.
    const spread = await services.spend.spend({
      by: 'costCenter',
      month: '2026-11',
      layer: 'spread',
      provisional: 'true',
    });
    expect(spread.total.total).toBe(spend.total.total);
    expect(spread.groups.some((g) => g.key === 'SHARED-POOL')).toBe(false);
    // A rebuild is a new generation; a closing month takes none.
    expect((await services.allocation.rebuild('2026-11', 'test', 'usr_dana')).number).toBe(3);
  });

  it('imports budgets from a CSV, versioned, and says where each cost center stands', async () => {
    await expect(
      services.budgets.import({ csv: 'cost_center,month,amount,currency\nNOPE,2026-11,1,USD\n', note: '' }, YOAV),
    ).rejects.toThrow(/nothing was imported/);
    await expect(
      services.budgets.import(
        { csv: 'cost_center,month,amount,currency\nENG-PLATFORM,2026-11,1,USD\n', note: '' },
        KEY,
      ),
    ).rejects.toThrow(/API key never does/);
    const v = await services.budgets.import(
      { csv: 'cost_center,month,amount,currency\nENG-PLATFORM,2026-11,0.05,USD\n', fileName: 'nov.csv', note: 'test' },
      YOAV,
    );
    expect(v.version).toBe(2); // the dev seed is v1
    const view = await services.spend.budgetsView('2026-11');
    const platform = view.rows.find((r) => r.code === 'ENG-PLATFORM')!;
    expect(platform).toMatchObject({ budget: '0.050000', monthToDate: '0.111000', state: 'over' });
  });

  it('serves Overview, Explore, exports and MCP over HTTP', async () => {
    const ov = await app.inject({ method: 'GET', url: '/api/overview?month=2026-11' });
    expect(ov.statusCode).toBe(200);
    expect(ov.json()).toMatchObject({
      month: '2026-11',
      rateCard: { version: 1, status: 'approved', approvedBy: 'yoav.bendavid@landbright.test' },
    });
    const sp = await app.inject({
      method: 'GET',
      url: '/api/spend?by=service&month=2026-11&filter=costCenter:ENG-PLATFORM',
    });
    expect(sp.json().groups.map((g: { key: string }) => g.key)).toEqual(['landflow-host']);
    expect(sp.json().groups[0].clicklandUrl).toBe('http://localhost:4711/services/landflow-host');
    const x = await app.inject({ method: 'GET', url: '/api/spend/export?by=costCenter&month=2026-11&format=xlsx' });
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const csv = await app.inject({ method: 'GET', url: '/api/spend/export?by=costCenter&month=2026-11' });
    expect(csv.body).toContain('Cost center,Detail,Estimated (USD)');
    const mcp = (body: object) =>
      app.inject({
        method: 'POST',
        url: '/api/mcp',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        payload: body as Record<string, unknown>,
      });
    const list = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(
      list
        .json()
        .result.tools.map((t: { name: string }) => t.name)
        .sort(),
    ).toEqual(['budget_status', 'spend_by']);
    const res = await mcp({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'spend_by', arguments: { by: 'costCenter', month: '2026-11' } },
    });
    expect(res.json().result.content[0].text).toMatch(/^Spend by cost center, 2026-11-01 to 2026-11-14/);
    const bs = await mcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'budget_status', arguments: { costCenter: 'ENG-PLATFORM' } },
    });
    expect(bs.json().result.content[0].text).toMatch(/Platform \(ENG-PLATFORM\): over budget/);
    expect((await app.inject({ method: 'GET', url: '/api/mcp' })).statusCode).toBe(405);
  });

  it('books a change to a locked month in the open month as a Correction', async () => {
    // October: one AI call, entered, then the month is closed and locked by a person.
    events = [call('2026-10-31T10:00:00.000Z', 1_000_000, 0)];
    now = new Date('2026-11-14T12:00:00Z');
    const oct = await services.ingest.run('landflow', '2026-10-31', 'manual', 'test');
    expect(oct.newCount).toBe(1);
    await services.periods.advance('2026-10', 'closing', YOAV);
    await services.periods.advance('2026-10', 'locked', YOAV);
    events = [call('2026-10-31T10:00:00.000Z', 2_000_000, 0)];
    const late = await services.ingest.run('landflow', '2026-10-31', 'manual', 'test');
    expect(late.correctedCount).toBe(1);
    const rows = await sql`
      SELECT charge_class, to_char(billing_period_start AT TIME ZONE 'UTC', 'YYYY-MM') AS month, effective_cost_micros::text AS c
      FROM cost_records WHERE source = 'landflow' AND charge_period_start = '2026-10-31' ORDER BY seq`;
    expect(rows.map((r) => [r.month, r.charge_class, r.c])).toEqual(
      [
        ['2026-10', null, '0'], // Oct 31: no rate card yet, Landflow's estimate (0 here)
        ['2026-11', 'Correction', '-0'],
        ['2026-11', 'Correction', '0'],
      ].map(([m, c, v]) => [m, c, v === '-0' ? '0' : v]),
    );
  });
});
