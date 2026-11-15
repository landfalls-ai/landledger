/**
 * Wave 4 against Postgres (LANDLEDGER_INTEGRATION=db), "Month-end": October 2026 closed end to end. The checklist's
 * computed gates and explanations, the accrual and its journal entry, the frozen snapshot, variance notes (an agent's
 * key drafts, its cites checked; an analyst accepts), the upload to an in-process fake-datarails and a budget pulled
 * as a pending change, the four-eyes lock and its anchor, the package, a reopen by the CFO's request and the relock;
 * and a property: once locked, October's totals never move under late ingest, invoice imports, voids or
 * reopen-and-relock.
 */
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloseView, NoteFigures } from '@landledger/contracts';
import { FakeDatarails } from '@landledger/fake-datarails';
import { Money } from '@landledger/money';
import { createTestDatabase, integrationEnabled, type TestDatabase } from '@landledger/schema/testing';
import fc from 'fast-check';
import type { FastifyInstance } from 'fastify';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { canonicalJson } from '../src/canonical.js';
import { Datarails } from '../src/datarails.js';
import { createSql, type Sql } from '../src/db.js';
import type { Principal } from '../src/principal.js';
import { RATE_CARD_V1, seed } from '../src/seed.js';
import { createServices, type Services } from '../src/services.js';
import { fakeLandbright, ISSUER, oidcConfig, type Person } from './fake-oidc.js';
import { call, fakeSources, testConfig } from './fakes.js';

const people = {
  tal: { sub: 'sub-tal', email: 'tal.levi@landbright.test', name: 'Tal Levi', roles: ['Engineering'] },
  yoav: {
    sub: 'sub-yoav',
    email: 'yoav.bendavid@landbright.test',
    name: 'Yoav Ben David',
    roles: ['Finance Controllers'],
  },
  roni: { sub: 'sub-roni', email: 'roni.amar@landbright.test', name: 'Roni Amar', roles: ['Finance Controllers'] },
  dana: { sub: 'sub-dana', email: 'dana.shalev@landbright.test', name: 'Dana Shalev', roles: ['Finance CFO'] },
  michal: { sub: 'sub-michal', email: 'michal.oren@landbright.test', name: 'Michal Oren', roles: ['Finance FP&A'] },
} satisfies Record<string, Person>;
type Who = keyof typeof people;
const ROLE: Record<Who, Principal['roles']> = {
  tal: ['engineer'],
  yoav: ['controller'],
  roni: ['controller'],
  dana: ['cfo'],
  michal: ['fpa'],
};

const sources = fakeSources();
const OCT = '2026-10';

describe.skipIf(!integrationEnabled('db'))('wave 4: month-end', () => {
  let db: TestDatabase;
  let sql: Sql;
  let services: Services;
  let app: FastifyInstance;
  let fake: Awaited<ReturnType<typeof fakeLandbright>>;
  let dr: Server;
  let drBase = '';
  let drFake: FakeDatarails;
  // Monday 2 November 2026: October has ended.
  let now = new Date('2026-11-02T10:00:00Z');
  const cookie = {} as Record<Who, string>;
  const userId = {} as Record<Who, string>;
  const principal = (who: Who): Principal => ({
    kind: 'person',
    id: userId[who],
    name: people[who].name,
    email: people[who].email,
    roles: ROLE[who],
    groups: people[who].roles,
    scopes: who === 'tal' || who === 'michal' ? ['read', 'requests:write'] : ['read', 'requests:write', 'admin'],
  });
  let notesKey = '';

  beforeAll(async () => {
    db = await createTestDatabase();
    sql = createSql(db.appUrl);
    fake = await fakeLandbright();
    drFake = new FakeDatarails({
      mcpToken: 'test-token',
      user: 'sync',
      password: 'pw',
      dataDir: mkdtempSync(join(tmpdir(), 'll-fdr-')),
    });
    dr = drFake.server();
    await new Promise<void>((r) => dr.listen(0, '127.0.0.1', () => r()));
    drBase = `http://127.0.0.1:${(dr.address() as AddressInfo).port}`;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(ISSUER)) return fake.fetchImpl(input, init);
      if (url.startsWith(drBase)) return fetch(input, init);
      return sources.fetchImpl(input, init);
    };
    services = createServices(
      testConfig({
        postgresUrl: db.appUrl,
        devAuth: false,
        oidc: oidcConfig,
        oidcProblem: null,
        datarails: {
          mcpUrl: `${drBase}/mcp`,
          uploadUrl: `${drBase}/api/v1/fileboxes/upload_file`,
          mcpToken: 'test-token',
          user: 'sync',
          password: 'pw',
          filebox: 'fb_technology_costs',
          real: false,
        },
      }),
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
    await services.rateCards.importAiLines(RATE_CARD_V1, await services.landflow!.prices(), principal('roni'));
    await services.rateCards.approve(RATE_CARD_V1, principal('yoav'));
    await services.allocation.approve('rsv_main_1', principal('dana'));
    // October: Landflow's AI calls on the 30th and the 31st (its first data on the 30th), nothing invoiced.
    for (const d of ['2026-10-30', '2026-10-31']) {
      sources.state.events = [call(`${d}T10:00:00.000Z`, 1_000_000, 100_000, {}, 4.5)];
      await services.ingest.run('landflow', d, 'manual', 'test');
    }
    sources.state.events = [];
    await services.allocation.allocatePending(OCT);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await sql?.end();
    await db?.drop();
    await new Promise<void>((r) => (dr ? dr.close(() => r()) : r()));
  });

  const as = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      cookies: { ll_session: cookie[who] },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const closeOf = async (month = OCT) => (await as('yoav', 'GET', `/api/close?month=${month}`)).json() as CloseView;
  const step = (c: CloseView, key: string) => c.steps.find((s) => s.key === key)!;

  it('shows an open month as a dry run, and a person starts its close once it ended (spec 012)', async () => {
    const dry = await closeOf();
    expect(dry).toMatchObject({ month: OCT, status: 'open', dryRun: true, ended: true, round: 0, reopened: false });
    expect(dry.steps.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(step(dry, 'usage_ingested').state).toBe('done');
    expect(step(dry, 'no_dev_rows').state).toBe('done');
    expect(step(dry, 'accrual_accepted').state).toBe('waiting');
    expect(step(dry, 'locked').state).toBe('waiting');
    // November is a dry run too: it hasn't ended.
    const nov = await closeOf('2026-11');
    expect(nov.dryRun).toBe(true);
    expect(step(nov, 'usage_ingested').problems[0]).toMatch(/hasn't ended yet/);
    expect((await as('yoav', 'POST', '/api/close/2026-11/start', {})).statusCode).toBe(409);
    expect(
      (await as('yoav', 'POST', `/api/close/${OCT}/explain`, { step: 'reconciled', rowKey: 'x|y', note: 'nope' }))
        .statusCode,
    ).toBe(409);
    expect((await as('tal', 'POST', `/api/close/${OCT}/start`, {})).statusCode).toBe(403);
    expect((await as('michal', 'POST', `/api/close/${OCT}/start`, {})).statusCode).toBe(403);
    const started = await as('yoav', 'POST', `/api/close/${OCT}/start`, { note: 'October close' });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: 'closing', dryRun: false });
  });

  it('computes the gates and takes explanations, never for step 4 or 10 (spec 012)', async () => {
    const c = await closeOf();
    const rec = step(c, 'reconciled');
    expect(rec.state).toBe('red');
    expect(rec.rows).toEqual([
      expect.objectContaining({
        key: 'anthropic|claude-sonnet-4-5',
        status: 'not_invoiced',
        ok: false,
        explained: false,
      }),
    ]);
    expect(
      (await as('michal', 'POST', `/api/close/${OCT}/explain`, { step: 'no_dev_rows', note: 'skip it' })).statusCode,
    ).toBe(400);
    expect(
      (await as('michal', 'POST', `/api/close/${OCT}/explain`, { step: 'locked', note: 'skip it' })).statusCode,
    ).toBe(400);
    expect(
      (await as('michal', 'POST', `/api/close/${OCT}/explain`, { step: 'reconciled', note: 'whole step' })).statusCode,
    ).toBe(400);
    expect(
      (
        await as('tal', 'POST', `/api/close/${OCT}/explain`, {
          step: 'reconciled',
          rowKey: rec.rows![0]!.key,
          note: 'x y z',
        })
      ).statusCode,
    ).toBe(403);
    const ex = await as('michal', 'POST', `/api/close/${OCT}/explain`, {
      step: 'reconciled',
      rowKey: 'anthropic|claude-sonnet-4-5',
      note: "Anthropic invoices October in November's first week; accrued at step 7",
    });
    expect(ex.statusCode).toBe(200);
    const after = ex.json() as CloseView;
    expect(step(after, 'reconciled')).toMatchObject({ state: 'explained', by: people.michal.email });
    for (const s of after.steps.slice(0, 6)) expect(['done', 'explained']).toContain(s.state);
    expect(step(after, 'unallocated').summary).toMatch(/% unallocated .* limit 5%/);
    expect(step(after, 'accrual_accepted').state).toBe('red');
    const [a] = await sql`SELECT data FROM audit_log WHERE action = 'close.explained'`;
    expect(a!.data).toMatchObject({ step: 'reconciled', rowKey: 'anthropic|claude-sonnet-4-5' });
  });

  let snapshotSha = '';
  it('proposes and accepts the accrual; acceptance freezes the snapshot and asks for notes (specs 013, 016)', async () => {
    const proposed = await as('michal', 'POST', `/api/accruals/${OCT}/propose`, { note: 'October' });
    expect(proposed.statusCode).toBe(201);
    const p = proposed.json();
    expect(p).toMatchObject({ month: OCT, version: 1, status: 'proposed' });
    expect(p.lines).toEqual([
      expect.objectContaining({
        kind: 'usage',
        provider: 'Anthropic',
        item: 'claude-sonnet-4-5',
        estimates: 2,
        costCenter: 'ENG-AGENTS',
      }),
    ]);
    expect(Money.parse(p.total, 'USD').isZero()).toBe(false);
    expect((await as('michal', 'POST', `/api/accruals/${p.id}/accept`, { sha256: p.sha256 })).statusCode).toBe(403);
    expect((await as('yoav', 'POST', `/api/accruals/${p.id}/accept`, { sha256: '0'.repeat(64) })).statusCode).toBe(409);
    const accepted = await as('yoav', 'POST', `/api/accruals/${p.id}/accept`, {
      sha256: p.sha256,
      note: 'as proposed',
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted', acceptedBy: people.yoav.email });
    snapshotSha = accepted.json().snapshotSha256;
    expect(snapshotSha).toMatch(/^[0-9a-f]{64}$/);
    const snap = (await as('tal', 'GET', `/api/close/${OCT}/snapshot`)).json();
    expect(snap).toMatchObject({ sha256: snapshotSha, current: true, version: 1 });
    expect(snap.figures.accrual).toMatchObject({ id: p.id, total: p.total });
    expect(snap.figures.notes[0]).toMatchObject({ costCenter: 'TOTAL' });
    const actions = (
      await sql`SELECT action FROM audit_log WHERE action LIKE 'accrual.%' OR action LIKE 'close.snapshot%' OR action = 'notes.draft_requested' ORDER BY seq`
    ).map((r) => r.action);
    expect(actions).toEqual(['accrual.proposed', 'close.snapshot_frozen', 'accrual.accepted', 'notes.draft_requested']);
    // The journal entry: balanced, debit expense by P&L class and cost center, credit accrued liabilities.
    const j = await as('tal', 'GET', `/api/accruals/journal.csv?month=${OCT}`);
    expect(j.headers['content-type']).toMatch(/text\/csv/);
    const rows = j.body.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    expect(rows[0]).toBe(
      'journal_date,entry,line,account,account_name,debit,credit,currency,cost_center,pl_class,memo',
    );
    const sum = (col: number) =>
      rows.slice(1).reduce((t, r) => t.plus(Money.parse(r.split(',')[col] || '0', 'USD')), Money.zero('USD'));
    expect(sum(5).equals(sum(6))).toBe(true);
    expect(rows.some((r) => r.includes('LIAB-ACCRUED'))).toBe(true);
    // Step 7 is done; a second proposal is refused while the snapshot holds.
    expect(step(await closeOf(), 'accrual_accepted').state).toBe('done');
    expect((await as('michal', 'POST', `/api/accruals/${OCT}/propose`, {})).statusCode).toBe(409);
  });

  let needed: NoteFigures[] = [];
  it('takes an agent key’s draft only when its cites match the snapshot; an analyst accepts, never the sponsor (spec 015)', async () => {
    const minted = await as('dana', 'POST', '/api/keys', { name: 'landflow notes', scopes: ['notes:draft'] });
    expect(minted.statusCode).toBe(201);
    notesKey = minted.json().key;
    const key = { authorization: `Bearer ${notesKey}` };
    expect((await app.inject({ method: 'GET', url: `/api/notes?month=${OCT}`, headers: key })).statusCode).toBe(403);
    const fig = await app.inject({ method: 'GET', url: `/api/notes/${OCT}/figures`, headers: key });
    expect(fig.statusCode).toBe(200);
    expect(fig.json().snapshotSha256).toBe(snapshotSha);
    needed = fig.json().needed;
    const total = needed.find((n) => n.costCenter === 'TOTAL')!;
    const draft = (amount: string) => ({
      costCenter: 'TOTAL',
      snapshotSha256: snapshotSha,
      text: `October's technology and AI spend came to ${amount}; no budget was set for the month.`,
      cites: [{ figure: 'actual', amount }],
      agent: { id: 'ag_notes', name: 'Variance notes agent', system: 'landflow' },
      sponsor: { email: people.michal.email },
      runId: 'run_42',
    });
    const wrong = await app.inject({
      method: 'POST',
      url: `/api/notes/${OCT}/drafts`,
      headers: key,
      payload: draft('1.00'),
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.details.mismatches[0]).toMatch(/actual: cited 1.00, the snapshot says/);
    const stale = await app.inject({
      method: 'POST',
      url: `/api/notes/${OCT}/drafts`,
      headers: key,
      payload: { ...draft(total.actual), snapshotSha256: 'a'.repeat(64) },
    });
    expect(stale.statusCode).toBe(409);
    const ok = await app.inject({
      method: 'POST',
      url: `/api/notes/${OCT}/drafts`,
      headers: key,
      payload: draft(total.actual),
    });
    expect(ok.statusCode).toBe(201);
    const note = ok.json();
    expect(note).toMatchObject({ costCenter: 'TOTAL', status: 'drafted', current: true });
    expect(note.versions[0]).toMatchObject({
      kind: 'draft',
      agent: { name: 'Variance notes agent' },
      sponsor: { email: people.michal.email },
    });
    // The sponsor never accepts; a key never accepts; an engineer is no analyst.
    expect((await as('michal', 'POST', `/api/notes/${note.id}/accept`, { version: 1 })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: `/api/notes/${note.id}/accept`, headers: key, payload: { version: 1 } }))
        .statusCode,
    ).toBe(403);
    expect((await as('tal', 'POST', `/api/notes/${note.id}/accept`, { version: 1 })).statusCode).toBe(403);
    // A controller accepts it edited: a new version, kept beside the draft.
    const edited = await as('yoav', 'POST', `/api/notes/${note.id}/accept`, {
      version: 1,
      text: `October's technology and AI spend came to ${total.actual} USD, all of it Anthropic usage still to be invoiced.`,
      comment: 'Named the provider',
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ status: 'accepted', accepted: 2 });
    expect(edited.json().versions.map((v: { kind: string }) => v.kind)).toEqual(['draft', 'edit']);
    // The other notes the month needs: drafted from the template, accepted by FP&A.
    const t = await as('michal', 'POST', `/api/notes/${OCT}/template`, {});
    expect(t.statusCode).toBe(201);
    for (const n of t.json().notes) {
      expect(n.versions.at(-1).text).toMatch(/Drafted from the template/);
      expect(
        (await as('michal', 'POST', `/api/notes/${n.id}/accept`, { version: n.versions.at(-1).version })).statusCode,
      ).toBe(200);
    }
    expect(step(await closeOf(), 'notes_accepted').state).toBe('done');
  });

  it('uploads the snapshot and the notes to fake-datarails, and pulls a budget as a pending change (spec 017)', async () => {
    expect((await as('michal', 'POST', '/api/datarails/uploads', { month: OCT })).statusCode).toBe(403);
    const up = await as('yoav', 'POST', '/api/datarails/uploads', { month: OCT });
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({
      ok: true,
      status: 201,
      snapshotSha256: snapshotSha,
      response: { status: 'uploaded' },
    });
    expect(up.json().files.map((f: { name: string }) => f.name)).toEqual([
      `landledger-actuals-${OCT}.csv`,
      `landledger-notes-${OCT}.csv`,
      `landledger-snapshot-${OCT}.json`,
    ]);
    const stored = drFake.uploads().at(-1)!;
    expect(stored.files.map((f) => f.sha256)).toEqual(up.json().files.map((f: { sha256: string }) => f.sha256));
    expect(step(await closeOf(), 'datarails_uploaded').state).toBe('done');

    const pull = await as('dana', 'POST', '/api/datarails/budgets/pull', {
      dataModel: 'Budget',
      scenario: 'Budget FY27',
      note: 'FY27 plan',
    });
    expect(pull.statusCode, pull.body).toBe(201);
    const p = pull.json();
    expect(p).toMatchObject({ status: 'pending', rows: 28, months: ['2026-12', '2027-01', '2027-02', '2027-03'] });
    expect((await services.budgets.forMonth('2026-12')).size).toBe(0); // nothing changes until a person accepts
    expect((await as('dana', 'POST', '/api/datarails/budgets/pull', { dataModel: 'Budget' })).statusCode).toBe(422); // two scenarios
    expect(
      (await as('tal', 'POST', `/api/datarails/budgets/pulls/${p.id}/accept`, { sha256: p.sha256 })).statusCode,
    ).toBe(403);
    const acc = await as('yoav', 'POST', `/api/datarails/budgets/pulls/${p.id}/accept`, { sha256: p.sha256 });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toMatchObject({ status: 'accepted', decidedBy: people.yoav.email });
    expect(acc.json().budgetVersion).toBeGreaterThan(0);
    expect((await services.budgets.forMonth('2026-12')).get('ENG-AGENTS')?.amount.toDecimal().toString()).toBe(
      '70.000000',
    );
    const [imp] = await sql`SELECT source FROM budget_imports WHERE version = ${acc.json().budgetVersion}`;
    expect(imp!.source).toBe('datarails');
    // A real tenant stays off: a host that isn't this machine is refused.
    const remote = new Datarails(
      sql,
      services.audit,
      services.webhooks,
      services.budgets,
      services.snapshots,
      services.notes,
      (m) => services.close.period(m),
      {
        mcpUrl: 'https://tenant.datarails.example/mcp',
        uploadUrl: 'https://tenant.datarails.example/upload',
        mcpToken: 't',
        user: 'u',
        password: 'p',
        filebox: 'f',
        real: false,
      },
    );
    await expect(remote.pull({ dataModel: 'Budget', note: '' }, principal('dana'))).rejects.toThrow(/wave 5/);
    await expect(remote.upload(OCT, principal('dana'))).rejects.toThrow(/wave 5/);
  });

  let lockAnchor: { seq: number; hash: string } | null = null;
  it('locks with two people, a controller and the CFO, and anchors the lock at once (spec 012)', async () => {
    const before = await closeOf();
    expect(before.next).toBe('locked');
    expect(step(before, 'locked').state).toBe('red');
    expect((await as('michal', 'POST', `/api/close/${OCT}/lock`, {})).statusCode).toBe(403);
    const first = await as('yoav', 'POST', `/api/close/${OCT}/lock`, { note: 'checked' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ locked: false, waitingFor: ['cfo'], anchor: null });
    expect((await as('yoav', 'POST', `/api/close/${OCT}/lock`, {})).statusCode).toBe(409); // same person
    expect((await as('roni', 'POST', `/api/close/${OCT}/lock`, {})).statusCode).toBe(409); // two controllers
    const second = await as('dana', 'POST', `/api/close/${OCT}/lock`, {});
    expect(second.statusCode).toBe(200);
    const r = second.json();
    expect(r.locked).toBe(true);
    expect(r.close).toMatchObject({ status: 'locked', done: 10, next: null });
    expect(r.close.locks[0].signoffs.map((s: { role: string }) => s.role)).toEqual(['controller', 'cfo']);
    expect(r.anchor.seq).toBeGreaterThanOrEqual(r.close.locks[0].auditSeq);
    lockAnchor = r.anchor;
    const [entry] = await sql`SELECT data FROM audit_log WHERE action = 'period.locked'`;
    expect(entry!.data).toMatchObject({ round: 0, checks: 'four-eyes', snapshotSha256: snapshotSha });
    const verify = (await as('tal', 'GET', '/api/audit/verify')).json();
    expect(verify).toMatchObject({ ok: true, truncated: false });
    // Locked: the checklist is as recorded; nothing more is explained, drafted or signed.
    expect((await as('yoav', 'POST', `/api/close/${OCT}/lock`, {})).statusCode).toBe(409);
    expect(
      (await as('michal', 'POST', `/api/close/${OCT}/explain`, { step: 'unallocated', note: 'late' })).statusCode,
    ).toBe(409);
    const periods = (await as('tal', 'GET', '/api/periods')).json().periods;
    expect(periods.find((p: { month: string }) => p.month === OCT)).toMatchObject({
      status: 'locked',
      round: 0,
      reopened: false,
    });
  });

  it('builds the month-end package: JSON, a printable page and a zip with a manifest (spec 018)', async () => {
    const pkg = (await as('tal', 'GET', `/api/close/${OCT}/package`)).json();
    expect(pkg).toMatchObject({ month: OCT, status: 'locked', snapshot: { sha256: snapshotSha } });
    expect(pkg.chain).toMatchObject({ ok: true, anchor: { seq: lockAnchor!.seq } });
    expect(pkg.notes.every((n: { status: string }) => n.status === 'accepted')).toBe(true);
    expect(pkg.uploads).toHaveLength(1);
    expect(pkg.files.map((f: { name: string }) => f.name)).toEqual(
      expect.arrayContaining([
        `${OCT}/checklist.csv`,
        `${OCT}/reconciliation.csv`,
        `${OCT}/accrual-journal-entry.csv`,
        `${OCT}/snapshot.json`,
      ]),
    );
    const html = await as('tal', 'GET', `/api/close/${OCT}/package?format=html`);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.body).toContain('October 2026: month-end package');
    expect(html.body).toContain(snapshotSha);
    const zip = await as('tal', 'GET', `/api/close/${OCT}/package.zip`);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(zip.rawPayload.includes(Buffer.from(`${OCT}/manifest.csv`))).toBe(true);
  });

  it('never moves a locked month: late ingest, imports, voids and reopen-and-relock (property)', async () => {
    const [lock] = await sql<{ snapshot_id: string }[]>`SELECT snapshot_id FROM close_locks WHERE month = '2026-10-01'`;
    const frozen = await services.snapshots.byId(lock!.snapshot_id);
    const totals = async () => {
      const f = await services.snapshots.ledgerFigures(OCT);
      return canonicalJson([f.total, f.byCostCenter, f.byPlClass, f.byProvider]);
    };
    const want = canonicalJson([
      frozen!.figures.total,
      frozen!.figures.byCostCenter,
      frozen!.figures.byPlClass,
      frozen!.figures.byProvider,
    ]);
    expect(await totals()).toBe(want);
    let invoice: string | null = null;
    let lateN = 0;
    const relock = async () => {
      const r = await as('yoav', 'POST', `/api/close/${OCT}/reopen`, {
        reason: 'A late Anthropic invoice to reflect in the notes',
      });
      expect(r.statusCode, r.body).toBe(201);
      const req = r.json().request;
      expect(req.kind).toBe('period_reopen');
      // Only the CFO decides, never the controller who asked.
      const shown = async (who: Who) =>
        (await as(who, 'GET', `/api/requests/${req.id}`)).json().evidenceSha256 as string;
      const self = await as('yoav', 'POST', `/api/requests/${req.id}/decisions`, {
        outcome: 'approve',
        evidenceSha256: await shown('yoav'),
      });
      expect(self.statusCode, self.body).toBe(403);
      const d = await as('dana', 'POST', `/api/requests/${req.id}/decisions`, {
        outcome: 'approve',
        evidenceSha256: await shown('dana'),
      });
      expect(d.statusCode, d.body).toBe(201);
      expect(d.json().request.status, d.body).toBe('applied');
      let c = await closeOf();
      expect(c).toMatchObject({ status: 'locked', reopened: true });
      if (step(c, 'accrual_accepted').state !== 'done') {
        // The reconciliation moved (an invoice came): the accrual is accepted again, the notes and the upload redone.
        const p = (await as('michal', 'POST', `/api/accruals/${OCT}/propose`, {})).json();
        expect((await as('yoav', 'POST', `/api/accruals/${p.id}/accept`, { sha256: p.sha256 })).statusCode).toBe(200);
        for (const n of (await as('michal', 'POST', `/api/notes/${OCT}/template`, {})).json().notes)
          expect(
            (await as('michal', 'POST', `/api/notes/${n.id}/accept`, { version: n.versions.at(-1).version }))
              .statusCode,
          ).toBe(200);
        expect((await as('yoav', 'POST', '/api/datarails/uploads', { month: OCT })).statusCode).toBe(201);
        c = await closeOf();
      }
      expect(c.steps.slice(0, 9).every((s) => s.state === 'done' || s.state === 'explained')).toBe(true);
      expect((await as('yoav', 'POST', `/api/close/${OCT}/lock`, {})).json().locked).toBe(false);
      const l = await as('dana', 'POST', `/api/close/${OCT}/lock`, {});
      expect(l.json()).toMatchObject({ locked: true, close: { round: c.round, reopened: false } });
    };
    type Op = { t: 'late' } | { t: 'import' } | { t: 'void' } | { t: 'relock' };
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.constant<Op>({ t: 'late' }),
            fc.constant<Op>({ t: 'import' }),
            fc.constant<Op>({ t: 'void' }),
            fc.constant<Op>({ t: 'relock' }),
          ),
          { minLength: 1, maxLength: 3 },
        ),
        async (ops) => {
          for (const o of ops) {
            if (o.t === 'late') {
              // A late call on 31 October: ingest books it in the open month, as a correction.
              sources.state.events = [call(`2026-10-31T2${lateN++ % 10}:00:00.000Z`, 10_000 + lateN, 1_000, {}, 0.05)];
              await services.ingest.run('landflow', '2026-10-31', 'manual', 'test');
              sources.state.events = [];
            } else if (o.t === 'import') {
              if (invoice) continue;
              const res = await services.invoices.import(
                {
                  csv: [
                    'provider,invoice_number,period,model,sku,quantity,unit,amount,currency,charge_category,description',
                    `anthropic,INV-OCT-${lateN}-${Date.now()},2026-10,claude-sonnet-4-5,tokens,1000,Tokens,9.40,USD,Usage,`,
                  ].join('\n'),
                  note: '',
                  origin: 'entered',
                },
                principal('yoav'),
              );
              invoice = res.invoices[0]!.id;
            } else if (o.t === 'void') {
              if (!invoice) continue;
              await services.invoices.void(invoice, 'property test', principal('yoav'));
              invoice = null;
            } else await relock();
            expect(await totals(), JSON.stringify(ops)).toBe(want);
          }
        },
      ),
      {
        numRuns: 6,
        // Always once: an invoice after the lock moves the reconciliation, so the relock redoes steps 7–9.
        examples: [[[{ t: 'late' }, { t: 'import' }, { t: 'relock' }, { t: 'void' }, { t: 'relock' }]]],
      },
    );
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM period_reopens`;
    expect(n).toBeGreaterThanOrEqual(2);
    const locks = await sql<
      { round: number }[]
    >`SELECT round FROM close_locks WHERE month = '2026-10-01' ORDER BY round`;
    expect(locks.map((l) => l.round)).toEqual(Array.from({ length: n + 1 }, (_, i) => i));
    expect((await as('tal', 'GET', '/api/audit/verify')).json().ok).toBe(true);
  }, 300_000);

  it('prices a window of services, estimated, for an incident (spec 019)', async () => {
    now = new Date('2026-11-02T10:00:00Z');
    const r = await as(
      'tal',
      'GET',
      '/api/cost/window?services=landflow-host,nope&from=2026-10-30T12:00:00Z&to=2026-10-31T12:00:00Z',
    );
    expect(r.statusCode).toBe(200);
    const w = r.json();
    expect(w).toMatchObject({ basis: 'estimated', currency: 'USD' });
    expect(w.services.find((s: { service: string }) => s.service === 'nope')).toMatchObject({
      known: false,
      amount: '0.000000',
    });
    expect(
      (await as('tal', 'GET', '/api/cost/window?services=a&from=2026-10-01T00:00:00Z&to=2026-11-02T01:00:00Z'))
        .statusCode,
    ).toBe(400);
    expect(
      (await as('tal', 'GET', '/api/cost/window?services=a&from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z'))
        .statusCode,
    ).toBe(400);
  });

  it('stores the forecast once a day and measures day 10 against the close (spec 014)', async () => {
    now = new Date('2026-11-10T08:00:00Z');
    const n = await services.forecastHistory.record();
    expect(n).toBeGreaterThan(0);
    expect(await services.forecastHistory.record()).toBe(0); // once a UTC day
    const v = (await as('tal', 'GET', '/api/forecast/history?month=2026-11')).json();
    expect(v).toMatchObject({ month: '2026-11', costCenter: 'TOTAL' });
    expect(v.days).toHaveLength(1);
    expect(v.day10).toMatchObject({ day: '2026-11-10' });
  });
});
