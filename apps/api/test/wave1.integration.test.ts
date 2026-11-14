/**
 * Wave 1 against Postgres (LANDLEDGER_INTEGRATION=db): rate card approval, ingest from fake Landflow and Clickland
 * (idempotent runs, corrections, a locked month), allocation generations, budgets, the read API, exports and MCP.
 */
import { createTestDatabase, integrationEnabled, type TestDatabase } from '@landledger/schema/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createSql, type Sql } from '../src/db.js';
import { RATE_CARD_V1, seed } from '../src/seed.js';
import { DEV_PRINCIPAL } from '../src/principal.js';
import { linesHash } from '../src/ratecards.js';
import { createServices, type Services } from '../src/services.js';
import { call, DANA, fakeSources, KEY, TAL, testConfig, YOAV } from './fakes.js';

// The Docker engine shares OrbStack's node, as it does on this machine.
const config = testConfig({ dockerSharesCluster: 'orbstack' });
const sources = fakeSources();
const { fetchImpl } = sources;

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

  it('approves a rate card only by a finance person who neither proposed it nor added a line', async () => {
    const prices = await services.landflow!.prices();
    // Lines have an author: a signed-in person. Not a key, not the local developer.
    await expect(services.rateCards.importAiLines(RATE_CARD_V1, prices, KEY)).rejects.toThrow(/signed in/);
    await expect(services.rateCards.importAiLines(RATE_CARD_V1, prices, DEV_PRINCIPAL)).rejects.toThrow(/signed in/);
    expect(await services.rateCards.importAiLines(RATE_CARD_V1, prices, DANA)).toBe(6); // four meters of the model, two of local Ollama
    const authors = await sql`SELECT DISTINCT added_by FROM rate_lines WHERE version_id = ${RATE_CARD_V1} ORDER BY 1`;
    expect(authors.map((a) => a.added_by)).toEqual(['seed', 'usr_dana']);
    const [proposer] =
      await sql`SELECT u.kind FROM rate_card_versions v JOIN users u ON u.id = v.proposed_by WHERE v.id = ${RATE_CARD_V1}`;
    expect(proposer!.kind).toBe('system'); // the seed proposes; it is a user, and never a person
    await expect(services.rateCards.approve(RATE_CARD_V1, KEY)).rejects.toThrow(/API key never does/);
    await expect(services.rateCards.approve(RATE_CARD_V1, TAL)).rejects.toThrow(/controller or the CFO/);
    // Dana added the AI lines, so she can't approve them.
    await expect(services.rateCards.approve(RATE_CARD_V1, DANA)).rejects.toThrow(/added lines/);
    // The database refuses the same, whatever the API says: an author, the proposer, or a system actor.
    await expect(
      sql`UPDATE rate_card_versions SET approved_by = 'usr_dana', approved_at = now() WHERE id = ${RATE_CARD_V1}`,
    ).rejects.toThrow(/added lines/);
    await expect(
      sql`UPDATE rate_card_versions SET approved_by = 'seed', approved_at = now() WHERE id = ${RATE_CARD_V1}`,
    ).rejects.toThrow(/proposed|system actor/);
    await expect(
      sql`UPDATE rate_card_versions SET approved_by = 'cli', approved_at = now() WHERE id = ${RATE_CARD_V1}`,
    ).rejects.toThrow(/system actor/);
    await expect(
      sql`UPDATE rate_card_versions SET proposed_by = 'nobody' WHERE id = ${RATE_CARD_V1}`,
    ).rejects.toThrow();
    const ok = await services.rateCards.approve(RATE_CARD_V1, YOAV);
    expect(ok.approvedBy).toBe('yoav.bendavid@landbright.test');
    await expect(services.rateCards.approve(RATE_CARD_V1, DANA)).rejects.toThrow(/already approved/);
    const [audit] = await sql`SELECT actor, data FROM audit_log WHERE action = 'rate_card.version_approved'`;
    expect(audit!.actor).toBe('yoav.bendavid@landbright.test');
    // The entry carries a hash of exactly the lines approved.
    const lines = await sql`SELECT * FROM rate_lines WHERE version_id = ${RATE_CARD_V1}`;
    expect(audit!.data.linesSha256).toBe(linesHash(lines as never));
    expect(audit!.data.linesAddedBy).toEqual(['seed', 'usr_dana']);
    const [imported] = await sql`SELECT actor, actor_kind FROM audit_log WHERE action = 'rate_card.lines_imported'`;
    expect(imported).toMatchObject({ actor: 'dana.shalev@landbright.test', actor_kind: 'person' });
    // Lines of an approved version never change.
    await expect(
      services.rateCards.importAiLines(RATE_CARD_V1, await services.landflow!.prices(), DANA),
    ).rejects.toThrow(/approved/);
  });

  it('ingests a complete day once: a second run appends nothing', async () => {
    sources.state.events = [
      call('2026-11-13T10:00:00.000Z', 1_000_000, 100_000, { cacheRead: 400_000, cacheWrite: 0 }),
    ];
    const first = await services.ingest.run('landflow', '2026-11-13', 'manual', 'test');
    expect(first).toMatchObject({ outcome: 'succeeded', provisional: false, newCount: 3, correctedCount: 0 });
    const again = await services.ingest.run('landflow', '2026-11-13', 'manual', 'test');
    expect(again).toMatchObject({ newCount: 0, correctedCount: 0, unchangedCount: 3 });
    const ck = await services.ingest.run('clickland', '2026-11-13', 'manual', 'test');
    expect(ck).toMatchObject({ outcome: 'succeeded', newCount: 5 }); // workload CPU and memory, Docker CPU, idle CPU and memory
    expect((await services.ingest.run('clickland', '2026-11-13', 'manual', 'test')).unchangedCount).toBe(5);
  });

  it('corrects a changed figure by reversal and re-entry, and reverses one that vanished', async () => {
    sources.state.cpuAllocated = '3.000000';
    const run = await services.ingest.run('clickland', '2026-11-13', 'manual', 'test');
    // The workload's CPU and the idle CPU both changed.
    expect(run).toMatchObject({ newCount: 0, correctedCount: 2, unchangedCount: 3 });
    sources.state.events = [];
    const lf = await services.ingest.run('landflow', '2026-11-13', 'manual', 'test');
    expect(lf.correctedCount).toBe(3);
    const [{ net }] =
      await sql`SELECT coalesce(sum(effective_cost_micros), 0)::text AS net FROM cost_records WHERE source = 'landflow'`;
    expect(net).toBe('0');
    // Capacity × rate still adds up exactly after the correction, Docker included (it shares the node, so it comes out
    // of idle): 24 × 0.034 + 48 × 0.0045 = 1.032.
    const [{ total }] =
      await sql`SELECT sum(effective_cost_micros)::text AS total FROM cost_records WHERE source = 'clickland'`;
    expect(total).toBe('1032000');
  });

  it('keeps today provisional and replaces it on every run', async () => {
    sources.state.events = [call('2026-11-14T09:00:00.000Z', 1000, 10)];
    const a = await services.ingest.run('landflow', '2026-11-14', 'hourly', 'test');
    expect(a.provisional).toBe(true);
    sources.state.events.push(call('2026-11-14T10:00:00.000Z', 2000, 20));
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
    expect(
      (await services.allocation.rebuild('2026-11', 'test', { actor: DANA.email!, actorKind: 'person' })).number,
    ).toBe(3);
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

  it('books a change to a locked month in the open month as a Correction, and month reads never move', async () => {
    // October: one AI call, entered, then the month is closed and locked by a person.
    sources.state.events = [call('2026-10-31T10:00:00.000Z', 1_000_000, 0, {}, 0.5)];
    now = new Date('2026-11-14T12:00:00Z');
    const oct = await services.ingest.run('landflow', '2026-10-31', 'manual', 'test');
    expect(oct.newCount).toBe(1);
    expect((await services.spend.overview('2026-10')).monthToDate.total).toBe('0.500000');
    await services.periods.advance('2026-10', 'closing', YOAV);
    await services.periods.advance('2026-10', 'locked', YOAV);
    sources.state.events = [call('2026-10-31T10:00:00.000Z', 2_000_000, 0, {}, 1.25)];
    const late = await services.ingest.run('landflow', '2026-10-31', 'manual', 'test');
    expect(late.correctedCount).toBe(1);
    const rows = await sql`
      SELECT charge_class, to_char(billing_period_start AT TIME ZONE 'UTC', 'YYYY-MM') AS month, effective_cost_micros::text AS c
      FROM cost_records WHERE source = 'landflow' AND charge_period_start = '2026-10-31' ORDER BY seq`;
    // Oct 31 had no rate card yet: Landflow's estimate.
    expect(rows.map((r) => [r.month, r.charge_class, r.c])).toEqual([
      ['2026-10', null, '500000'],
      ['2026-11', 'Correction', '-500000'],
      ['2026-11', 'Correction', '1250000'],
    ]);

    // October as booked never moves: Overview, Explore, Budgets' history, the exports and MCP read what was booked.
    expect((await services.spend.overview('2026-10')).monthToDate).toMatchObject({
      total: '0.500000',
      corrections: '0.000000',
    });
    const octSpend = await services.spend.spend({
      by: 'costCenter',
      month: '2026-10',
      layer: 'direct',
      provisional: 'true',
    });
    expect(octSpend).toMatchObject({ basis: 'billing', total: { total: '0.500000' } });
    const csv = await app.inject({ method: 'GET', url: '/api/spend/export?by=costCenter&month=2026-10' });
    expect(csv.body).toContain('AI Agents,ENG-AGENTS,0.500000,0.000000,0.500000');
    const nov = await services.spend.budgetsView('2026-11');
    expect(nov.rows.find((r) => r.code === 'ENG-AGENTS')?.months.find((m) => m.month === '2026-10')).toMatchObject({
      actual: '0.500000',
      locked: true,
    });

    // November carries the correction on its own line, never inside a cost center.
    const spend = await services.spend.spend({
      by: 'costCenter',
      month: '2026-11',
      layer: 'direct',
      provisional: 'true',
    });
    expect(spend.total.corrections).toBe('0.750000');
    expect(spend.groups.find((g) => g.key === 'CORRECTIONS')).toMatchObject({
      label: 'Corrections to locked months',
      total: '0.750000',
    });
    const ov = await services.spend.overview('2026-11');
    expect(ov.monthToDate.corrections).toBe('0.750000');
    expect(ov.costCenters.find((c) => c.code === 'CORRECTIONS')).toMatchObject({
      monthToDate: '0.750000',
      state: 'none',
    });
    expect(ov.byCategory.at(-1)).toMatchObject({ key: 'correction', amount: '0.750000' });
    // Opening the line shows whose it is.
    const drilled = await services.spend.spend({
      by: 'costCenter',
      month: '2026-11',
      filter: 'costCenter:CORRECTIONS',
      layer: 'direct',
      provisional: 'true',
    });
    expect(drilled.groups.map((g) => [g.key, g.total])).toEqual([['ENG-AGENTS', '0.750000']]);
    // The days it was charged: a range over 31 October shows the usage as corrected, wherever it was booked.
    const charged = await services.spend.spend({
      by: 'costCenter',
      from: '2026-10-31',
      to: '2026-10-31',
      layer: 'direct',
      provisional: 'true',
    });
    expect(charged).toMatchObject({ basis: 'charge', total: { total: '1.250000', corrections: '0.000000' } });
    // MCP reads October as booked too.
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'spend_by', arguments: { by: 'costCenter', month: '2026-10' } },
      },
    });
    expect(res.json().result.content[0].text).toMatch(/: USD 0\.500000,/);
  });
});
