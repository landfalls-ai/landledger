/**
 * The review of wave 4 against Postgres (LANDLEDGER_INTEGRATION=db): one test per blocker (B2–B4; B1 is the invoices
 * property test) and per should-fix (1–14), the segregation-of-duties rule, and what a controller or auditor asked for:
 * the frozen journal with entry ids and a chart-of-accounts mapping, the accrual roll-forward with aging, the stored
 * package per lock round and the evidence of which snapshot each signer signed.
 *
 * World A closes October 2026 with contracts of each billing kind, re-accrues it once, locks it, reopens it on a late
 * invoice and relocks it, then accrues November (the reversals). World B has no CFO at first (B4), and explains steps
 * 7–9, so the first signature freezes the snapshot (should-fix 2).
 */
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccrualRollForward, CloseView, JournalView } from '@landledger/contracts';
import { FakeDatarails } from '@landledger/fake-datarails';
import { Money } from '@landledger/money';
import { createTestDatabase, integrationEnabled, type TestDatabase } from '@landledger/schema/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { isLoopbackUrl } from '../src/config.js';
import { Datarails } from '../src/datarails.js';
import { createSql, type Sql } from '../src/db.js';
import type { Principal } from '../src/principal.js';
import { addsInMonth, withinContract } from '../src/reservations.js';
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
  admin: { sub: 'sub-admin', email: 'admin@landbright.test', name: 'Administrator', roles: ['Finance Controllers'] },
} satisfies Record<string, Person>;
type Who = keyof typeof people;
const ROLE: Record<Who, Principal['roles']> = {
  tal: ['engineer'],
  yoav: ['controller'],
  roni: ['controller'],
  dana: ['cfo'],
  michal: ['fpa'],
  admin: ['controller'],
};
const OCT = '2026-10';
const NOV = '2026-11';
const USD = 'USD';
const m = (a: string) => Money.parse(a, USD);

/** A database, the services on a moving clock, a fake Landbright and fake-datarails, and people signed in on demand. */
async function world(opts: { contracts?: boolean } = {}) {
  const sources = fakeSources();
  const db: TestDatabase = await createTestDatabase();
  const sql: Sql = createSql(db.appUrl);
  const fake = await fakeLandbright();
  const drDir = mkdtempSync(join(tmpdir(), 'll-fdr-'));
  const drFake = new FakeDatarails({ mcpToken: 'test-token', user: 'sync', password: 'pw', dataDir: drDir });
  const dr = drFake.server();
  await new Promise<void>((r) => dr.listen(0, '127.0.0.1', () => r()));
  const drBase = `http://127.0.0.1:${(dr.address() as AddressInfo).port}`;
  const clock = { now: new Date('2026-11-02T10:00:00Z') };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(ISSUER)) return fake.fetchImpl(input, init);
    if (url.startsWith(drBase)) return fetch(input, init);
    return sources.fetchImpl(input, init);
  };
  const services: Services = createServices(
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
    () => clock.now,
  );
  const app: FastifyInstance = await buildApp(services);
  await seed(sql);
  const cookie = {} as Record<Who, string>;
  const userId = {} as Record<Who, string>;
  const login = async (who: Who) => {
    if (cookie[who]) return;
    const l = await app.inject({ method: 'GET', url: '/api/auth/login' });
    const state = l.cookies.find((c) => c.name === 'll_login')!.value;
    const q = fake.authorize(l.headers.location!, people[who]);
    const cb = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?${new URLSearchParams(q)}`,
      cookies: { ll_login: state },
    });
    cookie[who] = cb.cookies.find((c) => c.name === 'll_session')!.value;
    const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE subject = ${people[who].sub}`;
    userId[who] = u!.id;
  };
  const principal = (who: Who): Principal => ({
    kind: 'person',
    id: userId[who],
    name: people[who].name,
    email: people[who].email,
    roles: ROLE[who],
    groups: people[who].roles,
    scopes: who === 'tal' || who === 'michal' ? ['read', 'requests:write'] : ['read', 'requests:write', 'admin'],
  });
  const as = async (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) => {
    await login(who);
    return app.inject({
      method,
      url,
      cookies: { ll_session: cookie[who] },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  };
  for (const who of ['yoav', 'roni', 'michal', 'tal'] as Who[]) await login(who);
  await services.rateCards.importAiLines(RATE_CARD_V1, await services.landflow!.prices(), principal('roni'));
  await services.rateCards.approve(RATE_CARD_V1, principal('yoav'));
  await services.allocation.approve('rsv_main_1', principal('roni'));
  // Landflow answers a day with every call it holds for it: a later call joins the day's earlier ones.
  const byDay = new Map<string, unknown[]>();
  const ingestDay = async (d: string, input: number, hour = 10, cost = 4.5) => {
    const events = [
      ...(byDay.get(d) ?? []),
      call(`${d}T${String(hour).padStart(2, '0')}:00:00.000Z`, input, 100_000, {}, cost),
    ];
    byDay.set(d, events);
    sources.state.events = events;
    await services.ingest.run('landflow', d, 'manual', 'test');
    sources.state.events = [];
    await services.allocation.allocatePending(d.slice(0, 7));
  };
  for (const d of ['2026-10-30', '2026-10-31']) await ingestDay(d, 1_000_000);
  if (opts.contracts) {
    // One contract of each billing kind, and one whose vendor is also an AI provider (review of wave 4, should-fix 12).
    const csv = [
      'vendor,product,cost_center,tcv,currency,term_start,term_end,seats_paid,seats_used,renewal_date,notice_days,auto_renew,landbright_app,billing',
      'Anthropic,Enterprise,ENG-AGENTS,1200.00,USD,2026-01-01,2026-12-31,10,5,2027-01-01,30,true,,monthly_in_arrears',
      'Linear,Business,ENG-PRODUCT,1200.00,USD,2026-01-01,2026-12-31,10,10,2027-01-01,30,true,linear,monthly_in_arrears',
      'Figma,Organization,ENG-PRODUCT,3650.00,USD,2026-01-01,2026-12-31,5,5,2027-01-01,30,true,figma,prepaid_annual',
      'Slack,Business+,GA-IT,1200.00,USD,2026-01-01,2026-12-31,50,40,2027-01-01,30,true,slack,monthly_in_advance',
    ].join('\n');
    const res = await as('yoav', 'POST', '/api/contracts/import', { csv });
    expect(res.statusCode, res.body).toBe(201);
  }
  const closeOf = async (who: Who = 'yoav', month = OCT) =>
    (await as(who, 'GET', `/api/close?month=${month}`)).json() as CloseView;
  const step = (c: CloseView, key: string) => c.steps.find((s) => s.key === key)!;
  /** The signer opens the close (recording that they were shown its snapshot) and signs what it shows. */
  const sign = async (who: Who, month = OCT, body: Record<string, unknown> = {}) => {
    const c = await closeOf(who, month);
    return as(who, 'POST', `/api/close/${month}/lock`, { snapshotSha256: c.snapshot?.sha256 ?? null, ...body });
  };
  /** FP&A explains whatever of steps 1–6 (and of a reopened round's 2 and 5) is red, row by row for step 2. */
  const explainRed = async (month = OCT, why = 'Reviewed for the review of wave 4') => {
    const c = await closeOf('michal', month);
    for (const s of c.steps.slice(0, 6)) {
      if (s.state !== 'red' || !s.explainable) continue;
      if (s.key === 'reconciled') {
        for (const row of s.rows ?? [])
          if (!row.ok && !row.explained) {
            const r = await as('michal', 'POST', `/api/close/${month}/explain`, {
              step: 'reconciled',
              rowKey: row.key,
              note: why,
            });
            expect(r.statusCode, r.body).toBe(200);
          }
      } else {
        const r = await as('michal', 'POST', `/api/close/${month}/explain`, { step: s.key, note: why });
        expect(r.statusCode, r.body).toBe(200);
      }
    }
  };
  const importInvoice = async (number: string, month: string, amount: string) =>
    services.invoices.import(
      {
        csv: [
          'provider,invoice_number,period,model,sku,quantity,unit,amount,currency,charge_category,description',
          `anthropic,${number},${month},claude-sonnet-4-5,tokens,1000,Tokens,${amount},USD,Usage,`,
        ].join('\n'),
        note: '',
        origin: 'entered',
      },
      principal('yoav'),
    );
  const close = async () => {
    await app.close();
    await sql.end();
    await db.drop();
    await new Promise<void>((r) => dr.close(() => r()));
  };
  return {
    sources,
    db,
    sql,
    services,
    app,
    drFake,
    drDir,
    drBase,
    clock,
    login,
    principal,
    as,
    userId,
    closeOf,
    step,
    sign,
    explainRed,
    importInvoice,
    ingestDay,
    close,
  };
}
type World = Awaited<ReturnType<typeof world>>;

describe.skipIf(!integrationEnabled('db'))('review of wave 4: world A (October closed, reopened, November)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world({ contracts: true });
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  it('should-fix 6: a service-like account never starts a close (nor accepts or signs, below)', async () => {
    const r = await w.as('admin', 'POST', `/api/close/${OCT}/start`, {});
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toMatch(/service account/);
    // Yoav starts October's close (round 0).
    expect((await w.as('yoav', 'POST', `/api/close/${OCT}/start`, { note: 'October' })).statusCode).toBe(200);
  });

  let rowEstimated = '';
  it('should-fix 3: an explanation holds only while the problem it explained stands', async () => {
    let c = await w.closeOf();
    const row = w.step(c, 'reconciled').rows![0]!;
    rowEstimated = row.estimated;
    await w.explainRed();
    c = await w.closeOf();
    expect(w.step(c, 'reconciled').rows![0]).toMatchObject({ explained: true });
    const [e] = await w.sql<{ problems: string[]; problems_sha256: string }[]>`
      SELECT problems, problems_sha256 FROM close_explanations WHERE step = 'reconciled'`;
    expect(e!.problems[0]).toMatch(/not invoiced \(estimated /);
    expect(e!.problems_sha256).toMatch(/^[0-9a-f]{64}$/);
    // A late call moves the row: the explanation no longer covers it.
    await w.ingestDay('2026-10-31', 2_000_000, 18, 1.25);
    c = await w.closeOf();
    const moved = w.step(c, 'reconciled');
    expect(moved.rows![0]!.estimated).not.toBe(rowEstimated);
    expect(moved.rows![0]).toMatchObject({ explained: false });
    expect(moved.state).toBe('red');
    await w.explainRed();
    rowEstimated = w.step(await w.closeOf(), 'reconciled').rows![0]!.estimated;
    expect(w.step(await w.closeOf(), 'reconciled').state).toBe('explained');
  });

  let v1Id = '';
  it('should-fix 12: contracts accrue by billing terms; prepaid amortises apart; an AI vendor never accrues twice', async () => {
    const p = await w.as('michal', 'POST', `/api/accruals/${OCT}/propose`, { note: 'October' });
    expect(p.statusCode, p.body).toBe(201);
    const v = p.json();
    v1Id = v.id;
    const byItem = (provider: string) => v.lines.filter((l: { provider: string }) => l.provider === provider);
    const usage = v.lines.find((l: { kind: string }) => l.kind === 'usage');
    expect(usage).toMatchObject({ provider: 'Anthropic', item: 'claude-sonnet-4-5' });
    // October's value of a $1,200 year: 1,200 × (304 − 273) / 365, by days through the month's end less the day before.
    const linear = byItem('Linear')[0];
    expect(linear).toMatchObject({ kind: 'contract', amount: '101.917808' });
    // Anthropic's contract is net of Anthropic's own usage lines: never the same spend twice.
    const anthropic = byItem('Anthropic').find((l: { kind: string }) => l.kind === 'contract');
    expect(m(anthropic.amount).equals(m('101.917808').minus(m(usage.amount)))).toBe(true);
    // Prepaid: Figma amortised (3,650 × 31 / 365 = 310), a `prepaid` line outside the liability's total.
    expect(byItem('Figma')[0]).toMatchObject({ kind: 'prepaid', amount: '310.000000' });
    expect(v.prepaidTotal).toBe('310.000000');
    // Monthly in advance: invoiced before the month, so nothing.
    expect(byItem('Slack')).toEqual([]);
    const liability = v.lines
      .filter((l: { kind: string }) => l.kind !== 'prepaid')
      .reduce((t: Money, l: { amount: string }) => t.plus(m(l.amount)), Money.zero(USD));
    expect(m(v.total).equals(liability)).toBe(true);
    // A contract's months sum back to its value (nit): the first eleven months and December.
    const { valueThrough } = await import('../src/accruals.js');
    const tcv = m('1000.00');
    let sum = Money.zero(USD);
    let prev = '2025-12-31';
    for (let i = 1; i <= 12; i++) {
      const end = new Date(Date.UTC(2026, i, 0)).toISOString().slice(0, 10);
      sum = sum.plus(
        valueThrough(tcv, '2026-01-01', '2026-12-31', end).minus(valueThrough(tcv, '2026-01-01', '2026-12-31', prev)),
      );
      prev = end;
    }
    expect(sum.equals(tcv)).toBe(true);
  });

  it('B2: an accrual is never accepted on lines an invoice changed since it was proposed', async () => {
    // An invoice for October replaces the estimates (and invoices Anthropic's contract) after the proposal.
    const inv = await w.importInvoice('INV-OCT-B2', OCT, m(rowEstimated).posted().toCsv());
    const stale = await w.as('yoav', 'POST', `/api/accruals/${v1Id}/accept`, {
      sha256: (await w.as('yoav', 'GET', `/api/accruals?month=${OCT}`)).json().current.sha256,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.message).toMatch(/lines changed since v1 was proposed/);
    // Should-fix 10: the void gives the estimates back; a voided invoice reverses nothing.
    await w.services.invoices.void(inv.invoices[0]!.id, 'entered by mistake', w.principal('yoav'));
    const back = (await w.as('yoav', 'GET', `/api/accruals?month=${OCT}`)).json().current;
    expect(back.lines.every((l: { reversal: unknown }) => l.reversal === null)).toBe(true);
  });

  it('should-fix 6 and the duties rule: Administrator never accepts; the same person never starts, accepts and signs', async () => {
    const cur = (await w.as('yoav', 'GET', `/api/accruals?month=${OCT}`)).json().current;
    const adm = await w.as('admin', 'POST', `/api/accruals/${cur.id}/accept`, { sha256: cur.sha256 });
    expect(adm.statusCode).toBe(403);
    const ok = await w.as('yoav', 'POST', `/api/accruals/${cur.id}/accept`, { sha256: cur.sha256, note: 'v1' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'accepted', version: 1 });
  });

  it('should-fix 11: accepting freezes the journal: entry ids, the GL account by the mapping, the accepted total to the cent', async () => {
    const j = (await w.as('tal', 'GET', `/api/accruals/journal?month=${OCT}`)).json() as JournalView;
    expect(j).toMatchObject({ frozen: true, coaVersion: 1, frozenBy: people.yoav.email });
    const ids = [...new Set(j.lines.map((l) => l.entryId))];
    expect(ids).toEqual([`JE-${OCT}-0001`, `JE-${OCT}-0002`]);
    expect(m(j.debits).equals(m(j.credits))).toBe(true);
    const acc = (await w.as('tal', 'GET', `/api/accruals?month=${OCT}`)).json().current;
    const liability = j.lines
      .filter((l) => l.account === 'LIAB-ACCRUED')
      .reduce((t, l) => t.plus(m(l.credit)), Money.zero(USD));
    expect(liability.equals(m(acc.total).posted())).toBe(true);
    expect(j.lines.find((l) => l.account === 'LIAB-ACCRUED')).toMatchObject({ glAccount: '2150' });
    const prepaid = j.lines.filter((l) => l.kind === 'prepaid');
    expect(prepaid.find((l) => l.account === 'ASSET-PREPAID')).toMatchObject({
      credit: '310.000000',
      glAccount: '1450',
    });
    // Append only.
    await expect(w.sql`UPDATE journal_lines SET memo = 'x'`).rejects.toThrow();
  });

  let notesKey = '';
  it('B3: the key’s minter never decides its drafts, whatever sponsor a draft declares', async () => {
    const minted = await w.as('roni', 'POST', '/api/keys', { name: 'landflow notes', scopes: ['notes:draft'] });
    expect(minted.statusCode).toBe(201);
    notesKey = minted.json().key;
    const fig = await w.app.inject({
      method: 'GET',
      url: `/api/notes/${OCT}/figures`,
      headers: { authorization: `Bearer ${notesKey}` },
    });
    const { snapshotSha256, needed } = fig.json();
    const total = needed.find((n: { costCenter: string }) => n.costCenter === 'TOTAL');
    const d = await w.app.inject({
      method: 'POST',
      url: `/api/notes/${OCT}/drafts`,
      headers: { authorization: `Bearer ${notesKey}` },
      payload: {
        costCenter: 'TOTAL',
        snapshotSha256,
        text: `October came to ${m(total.actual).posted().toCsv()} USD.`,
        cites: [{ figure: 'actual', amount: total.actual }],
        sponsor: { email: people.michal.email },
      },
    });
    expect(d.statusCode, d.body).toBe(201);
    const note = d.json();
    const minter = await w.as('roni', 'POST', `/api/notes/${note.id}/accept`, { version: 1 });
    expect(minter.statusCode).toBe(403);
    expect(minter.json().error.message).toMatch(/minted the key/);
    expect((await w.as('michal', 'POST', `/api/notes/${note.id}/accept`, { version: 1 })).statusCode).toBe(403);
    expect((await w.as('admin', 'POST', `/api/notes/${note.id}/accept`, { version: 1 })).statusCode).toBe(403); // SF6
    expect((await w.as('yoav', 'POST', `/api/notes/${note.id}/accept`, { version: 1 })).statusCode).toBe(200);
  });

  it('should-fix 7: a note accepted on the current snapshot takes no new draft', async () => {
    const fig = (
      await w.app.inject({
        method: 'GET',
        url: `/api/notes/${OCT}/figures`,
        headers: { authorization: `Bearer ${notesKey}` },
      })
    ).json();
    const total = fig.needed.find((n: { costCenter: string }) => n.costCenter === 'TOTAL');
    const again = await w.app.inject({
      method: 'POST',
      url: `/api/notes/${OCT}/drafts`,
      headers: { authorization: `Bearer ${notesKey}` },
      payload: {
        costCenter: 'TOTAL',
        snapshotSha256: fig.snapshotSha256,
        text: 'Replaced by a second draft.',
        cites: [{ figure: 'actual', amount: total.actual }],
      },
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(w.step(await w.closeOf(), 'notes_accepted').problems.join(' ')).not.toMatch(/TOTAL/);
  });

  it('should-fix 8: every amount a note states must be one it cites, drafted or edited', async () => {
    const t = (await w.as('michal', 'POST', `/api/notes/${OCT}/template`, {})).json();
    const n = t.notes[0];
    const fig = (
      await w.app.inject({
        method: 'GET',
        url: `/api/notes/${OCT}/figures`,
        headers: { authorization: `Bearer ${notesKey}` },
      })
    ).json();
    const f = fig.needed.find((x: { costCenter: string }) => x.costCenter === n.costCenter);
    const draft = await w.app.inject({
      method: 'POST',
      url: `/api/notes/${OCT}/drafts`,
      headers: { authorization: `Bearer ${notesKey}` },
      payload: {
        costCenter: n.costCenter,
        snapshotSha256: fig.snapshotSha256,
        text: `Spend was ${m(f.actual).posted().toCsv()} USD, about $9,999.00 above plan.`,
        cites: [{ figure: 'actual', amount: f.actual }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(422);
    expect(draft.json().error.details.mismatches.join(' ')).toMatch(/\$9999\.00 is stated/);
    const empty = await w.app.inject({
      method: 'POST',
      url: `/api/notes/${OCT}/drafts`,
      headers: { authorization: `Bearer ${notesKey}` },
      payload: {
        costCenter: n.costCenter,
        snapshotSha256: fig.snapshotSha256,
        text: 'Spend is fine, nothing to add.',
        cites: [],
      },
    });
    expect(empty.statusCode, empty.body).toBe(422);
    const edited = await w.as('yoav', 'POST', `/api/notes/${n.id}/accept`, {
      version: n.versions.at(-1).version,
      text: 'It came to $12,345.67 in the end.',
    });
    expect(edited.statusCode, edited.body).toBe(422);
    for (const x of t.notes)
      expect(
        (await w.as('michal', 'POST', `/api/notes/${x.id}/accept`, { version: x.versions.at(-1).version })).statusCode,
      ).toBe(200);
  });

  it('should-fix 13: the upload books one figure, net of notional; the accrual and notional are memos', async () => {
    const up = await w.as('yoav', 'POST', '/api/datarails/uploads', { month: OCT });
    expect(up.statusCode, up.body).toBe(201);
    const actuals = w.drFake.uploads().at(-1)!.files[0]!;
    const body = readFileSync(join(w.drDir, actuals.path), 'utf8');
    const [head, ...rows] = body
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/);
    expect(head).toBe(
      'cost_center,cost_center_name,period,invoiced,estimated,total_excl_notional,memo_notional_not_booked,memo_accrual_in_total,memo_prepaid_amortised,budget,currency,snapshot_sha256',
    );
    expect(head).not.toMatch(/(^|,)total(,|$)/);
    for (const r of rows) {
      const c = r.split(',');
      expect(m(c[5]!).equals(m(c[3]!).plus(m(c[4]!)))).toBe(true);
    }
    const snap = (await w.as('tal', 'GET', `/api/close/${OCT}/snapshot`)).json();
    expect(snap.figures.notes[0].notional).toBeDefined();
    expect(snap.figures.notes[0].notional).toBe(snap.figures.total.notional);
  });

  it('should-fix 1: a signature is on one snapshot, by a signer who was shown it; a new snapshot needs both again', async () => {
    // Dana (CFO) signs snapshot A, as the close showed it to her.
    const a = (await w.closeOf('dana')).snapshot!.sha256;
    const wrong = await w.as('dana', 'POST', `/api/close/${OCT}/lock`, { snapshotSha256: 'f'.repeat(64) });
    expect(wrong.statusCode).toBe(409);
    const unseen = await w.as('roni', 'POST', `/api/close/${OCT}/lock`, { snapshotSha256: a });
    expect(unseen.statusCode).toBe(409);
    expect(unseen.json().error.message).toMatch(/haven't been shown this snapshot/);
    const cfo = await w.sign('dana');
    expect(cfo.statusCode, cfo.body).toBe(200);
    expect(cfo.json().close.signoffs[0]).toMatchObject({ role: 'cfo', snapshotSha256: a });
    expect(cfo.json().close.signoffs[0].seenAt).toBeTruthy();
    // A late call moves the figures: the accrual is accepted again on snapshot B.
    await w.ingestDay('2026-10-31', 3_000_000, 20, 2.5);
    await w.explainRed();
    expect((await w.sign('roni')).statusCode).toBe(409); // the figures moved since A
    const p = (await w.as('michal', 'POST', `/api/accruals/${OCT}/propose`, { note: 'late call' })).json();
    const acc = await w.as('yoav', 'POST', `/api/accruals/${p.id}/accept`, { sha256: p.sha256, note: 'v2' });
    expect(acc.statusCode, acc.body).toBe(200);
    const b = acc.json().snapshotSha256;
    expect(b).not.toBe(a);
    for (const x of (await w.as('michal', 'POST', `/api/notes/${OCT}/template`, {})).json().notes)
      expect(
        (await w.as('michal', 'POST', `/api/notes/${x.id}/accept`, { version: x.versions.at(-1).version })).statusCode,
      ).toBe(200);
    expect((await w.as('yoav', 'POST', '/api/datarails/uploads', { month: OCT })).statusCode).toBe(201);
    // Dana's signature on A no longer counts.
    const c = await w.closeOf('roni');
    expect(c.signoffs).toEqual([]);
  });

  it('the duties rule: the controller who started the close and accepted the accrual does not sign it alone', async () => {
    const self = await w.sign('yoav');
    expect(self.statusCode).toBe(409);
    expect(self.json().error.message).toMatch(/Segregation of duties/);
    expect((await w.sign('admin')).statusCode).toBe(403); // should-fix 6
    const ctl = await w.sign('roni');
    expect(ctl.statusCode, ctl.body).toBe(200);
    expect(ctl.json()).toMatchObject({ locked: false, waitingFor: ['cfo'] });
    expect(ctl.json().close.duties).toEqual({
      startedBy: people.yoav.email,
      accrualAcceptedBy: people.yoav.email,
      controllerSignedBy: people.roni.email,
    });
  });

  let packageSha = '';
  it('should-fix 5: the lock stores the round’s package; its manifest’s sha256 is in the lock and its audit entry', async () => {
    const l = await w.sign('dana');
    expect(l.statusCode, l.body).toBe(200);
    expect(l.json().locked).toBe(true);
    const lock = l.json().close.locks[0];
    packageSha = lock.packageSha256;
    expect(packageSha).toMatch(/^[0-9a-f]{64}$/);
    const snapshot = l.json().close.snapshot.sha256;
    expect(lock.signoffs.map((s: { snapshotSha256: string }) => s.snapshotSha256)).toEqual([snapshot, snapshot]);
    const [entry] = await w.sql<{ data: { packageSha256: string } }[]>`
      SELECT data FROM audit_log WHERE action = 'period.locked' ORDER BY seq DESC LIMIT 1`;
    expect(entry!.data.packageSha256).toBe(packageSha);
    const [stored] = await w.sql<{ manifest: string; sha256: string }[]>`SELECT manifest, sha256 FROM close_packages`;
    expect(stored!.sha256).toBe(packageSha);
    const pkg = (await w.as('tal', 'GET', `/api/close/${OCT}/package`)).json();
    expect(pkg.stored).toMatchObject({ round: 0, sha256: packageSha });
    expect(pkg.files.map((f: { name: string }) => f.name)).toEqual(
      expect.arrayContaining([
        `${OCT}/accrual-journal-entry.csv`,
        `${OCT}/accrual-roll-forward.csv`,
        `${OCT}/lock-signatures.csv`,
        `${OCT}/package.json`,
      ]),
    );
    // Served as stored: later facts do not move it.
    w.clock.now = new Date('2026-11-05T10:00:00Z');
    const again = (await w.as('tal', 'GET', `/api/close/${OCT}/package`)).json();
    expect(again.generatedAt).toBe(pkg.generatedAt);
    expect(again.files).toEqual(pkg.files);
    await expect(w.sql`UPDATE close_packages SET manifest = ''`).rejects.toThrow();
  });

  it('should-fix 11: a re-accrual reverses the version a controller booked; the roll-forward shows it', async () => {
    const j = (await w.as('tal', 'GET', `/api/accruals/journal?month=${OCT}`)).json() as JournalView;
    const kinds = [...new Map(j.lines.map((l) => [l.entryId, l.kind])).entries()];
    expect(kinds).toEqual([
      [`JE-${OCT}-0001`, 'accrual'],
      [`JE-${OCT}-0002`, 'prepaid'],
      [`JE-${OCT}-0003`, 'supersede'],
      [`JE-${OCT}-0004`, 'supersede'],
      [`JE-${OCT}-0005`, 'accrual'],
      [`JE-${OCT}-0006`, 'prepaid'],
    ]);
    const rf = (await w.as('tal', 'GET', `/api/accruals/roll-forward?month=${OCT}`)).json() as AccrualRollForward;
    const v2 = (await w.as('tal', 'GET', `/api/accruals?month=${OCT}`)).json().current;
    expect(rf).toMatchObject({ opening: '0.000000', reversals: '0.000000', frozen: true });
    expect(m(rf.additions).minus(m(rf.superseded)).equals(m(rf.closing))).toBe(true);
    expect(m(rf.closing).equals(m(v2.total).posted())).toBe(true);
    expect(rf.aging.find((a) => a.bucket === '0')!.amount).toBe(rf.closing);
    expect(rf.prepaidAmortised).toBe('310.000000');
  });

  it('should-fix 10: a voided invoice reverses nothing; the real one reverses the invoiced lines', async () => {
    w.clock.now = new Date('2026-11-10T10:00:00Z');
    // An October invoice posted after the lock, voided the same day: the lines stay unreversed.
    const wrong = await w.importInvoice('INV-OCT-WRONG', OCT, '1.00');
    await w.services.invoices.void(wrong.invoices[0]!.id, 'wrong file', w.principal('yoav'));
    let cur = (await w.as('tal', 'GET', `/api/accruals?month=${OCT}`)).json().current;
    expect(cur.lines.filter((l: { reversal: unknown }) => l.reversal !== null)).toEqual([]);
    // The real one, well off the estimate: it reverses the usage line and Anthropic's contract line in November.
    await w.importInvoice('INV-OCT-REAL', OCT, m(rowEstimated).plus(m('40')).posted().toCsv());
    cur = (await w.as('tal', 'GET', `/api/accruals?month=${OCT}`)).json().current;
    const reversed = cur.lines.filter((l: { reversal: unknown }) => l.reversal !== null);
    expect(reversed.map((l: { provider: string; kind: string }) => `${l.provider}:${l.kind}`).sort()).toEqual([
      'Anthropic:contract',
      'Anthropic:usage',
    ]);
    expect(reversed[0].reversal).toMatchObject({ invoice: 'INV-OCT-REAL', month: NOV, day: '2026-11-10' });
  });

  it('a chart-of-accounts mapping changes by a request its proposer never decides', async () => {
    const coa = (await w.as('tal', 'GET', '/api/coa')).json();
    expect(coa.current).toMatchObject({ version: 1, status: 'approved' });
    const mapping = { ...coa.current.mapping, 'LIAB-ACCRUED': { gl: '2155', name: 'Accrued technology costs' } };
    expect((await w.as('michal', 'POST', '/api/coa/proposals', { mapping, note: 'New GL' })).statusCode).toBe(403);
    const p = await w.as('yoav', 'POST', '/api/coa/proposals', { mapping, note: 'The GL moved accrued tech to 2155' });
    expect(p.statusCode, p.body).toBe(201);
    const req = p.json().request;
    expect(req.kind).toBe('coa_mapping_change');
    const shown = async (who: 'yoav' | 'roni') =>
      (await w.as(who, 'GET', `/api/requests/${req.id}`)).json().evidenceSha256 as string;
    const self = await w.as('yoav', 'POST', `/api/requests/${req.id}/decisions`, {
      outcome: 'approve',
      evidenceSha256: await shown('yoav'),
    });
    expect(self.statusCode).toBe(403);
    const ok = await w.as('roni', 'POST', `/api/requests/${req.id}/decisions`, {
      outcome: 'approve',
      evidenceSha256: await shown('roni'),
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await w.as('tal', 'GET', '/api/coa')).json().current).toMatchObject({ version: 2 });
    // October's frozen journal keeps the mapping it was frozen with.
    const oct = (await w.as('tal', 'GET', `/api/accruals/journal?month=${OCT}`)).json() as JournalView;
    expect(oct.lines.find((l) => l.account === 'LIAB-ACCRUED')).toMatchObject({ glAccount: '2150' });
  });

  it('the roll-forward: November reverses October’s invoiced lines; the rest age a month', async () => {
    w.clock.now = new Date('2026-12-02T10:00:00Z');
    expect((await w.as('michal', 'POST', `/api/close/${NOV}/start`, {})).statusCode).toBe(200);
    await w.explainRed(NOV);
    const p = (await w.as('michal', 'POST', `/api/accruals/${NOV}/propose`, {})).json();
    expect(p.lines.map((l: { provider: string }) => l.provider)).toEqual(expect.arrayContaining(['Linear', 'Figma']));
    const acc = await w.as('roni', 'POST', `/api/accruals/${p.id}/accept`, { sha256: p.sha256 });
    expect(acc.statusCode, acc.body).toBe(200);
    const j = (await w.as('tal', 'GET', `/api/accruals/journal?month=${NOV}`)).json() as JournalView;
    expect(j).toMatchObject({ frozen: true, coaVersion: 2 });
    expect(j.lines.find((l) => l.account === 'LIAB-ACCRUED')).toMatchObject({ glAccount: '2155' });
    const rev = j.lines.filter((l) => l.kind === 'reversal');
    expect(rev.length).toBe(4); // October's usage and Anthropic contract lines, two sides each
    expect(rev.every((l) => l.journalDate === '2026-11-10')).toBe(true);
    const oct = (await w.as('tal', 'GET', `/api/accruals/roll-forward?month=${OCT}`)).json() as AccrualRollForward;
    const rf = (await w.as('tal', 'GET', `/api/accruals/roll-forward?month=${NOV}`)).json() as AccrualRollForward;
    expect(rf.opening).toBe(oct.closing);
    expect(
      m(rf.opening).plus(m(rf.additions)).minus(m(rf.superseded)).minus(m(rf.reversals)).equals(m(rf.closing)),
    ).toBe(true);
    expect(m(rf.reversals).isZero()).toBe(false);
    const aged = rf.aging.find((a) => a.bucket === '1')!;
    expect(aged.lines).toBe(1); // October's Linear line, still waiting for a SaaS invoice
    expect(rf.open.find((o) => o.ageMonths === 1)).toMatchObject({ provider: 'Linear', accrualMonth: OCT });
  });

  it('should-fix 4: a reopened round waits to be started, re-runs steps 2 and 5, and relocks by two people', async () => {
    w.clock.now = new Date('2026-12-03T10:00:00Z');
    // October reopens (Yoav asks, Dana decides); its round waits to be started; then step 2 runs live again.
    const r = await w.as('yoav', 'POST', `/api/close/${OCT}/reopen`, {
      reason: 'A late Anthropic invoice, off by $40',
    });
    expect(r.statusCode, r.body).toBe(201);
    const req = r.json().request;
    const ev = (await w.as('dana', 'GET', `/api/requests/${req.id}`)).json().evidenceSha256;
    const d = await w.as('dana', 'POST', `/api/requests/${req.id}/decisions`, {
      outcome: 'approve',
      evidenceSha256: ev,
    });
    expect(d.statusCode, d.body).toBe(201);
    let c = await w.closeOf();
    expect(c).toMatchObject({ reopened: true, round: 1, roundStarted: false });
    expect((await w.sign('roni')).statusCode).toBe(409); // not started
    expect((await w.as('admin', 'POST', `/api/close/${OCT}/start`, {})).statusCode).toBe(403);
    expect((await w.as('michal', 'POST', `/api/close/${OCT}/start`, { note: 'round 1' })).statusCode).toBe(200);
    c = await w.closeOf();
    const rec = w.step(c, 'reconciled');
    expect(rec.summary).not.toMatch(/as locked in round 0/);
    expect(rec.state).toBe('red');
    expect(rec.rows![0]!.status).not.toBe('not_invoiced');
    expect(w.step(c, 'no_dev_rows').summary).toMatch(/as locked in round 0/);
    expect(w.step(c, 'no_open_anomalies').summary).not.toMatch(/as locked in round 0/);
    // Explained in this round. The invoice moved the figures, so the accrual is taken again (v3): the invoiced lines
    // leave it, and its supersede of v2 skips the lines November's frozen journal reversed already.
    await w.explainRed(OCT, 'The invoice is $40 over the estimate: Anthropic billed a late batch');
    expect(w.step(await w.closeOf(), 'accrual_accepted').state).toBe('red');
    const p = (await w.as('michal', 'POST', `/api/accruals/${OCT}/propose`, { note: 'round 1' })).json();
    // October's figures still hold the usage estimate (a locked month's invoice trues up in the open one), so v3 keeps
    // the line; November reversed it already, so the journal carries it as v2 booked it.
    expect(p.lines.map((l: { provider: string; kind: string }) => `${l.provider}:${l.kind}`).sort()).toEqual([
      'Anthropic:usage',
      'Figma:prepaid',
      'Linear:contract',
    ]);
    const acc = await w.as('yoav', 'POST', `/api/accruals/${p.id}/accept`, { sha256: p.sha256, note: 'v3' });
    expect(acc.statusCode, acc.body).toBe(200);
    const sup = ((await w.as('tal', 'GET', `/api/accruals/journal?month=${OCT}`)).json() as JournalView).lines.filter(
      (l) => l.kind === 'supersede' && l.memo.includes(' v2 '),
    );
    expect(new Set(sup.map((l) => l.memo.split(': ').at(-1))).size).toBe(2); // Linear and Figma only
    const v3 = ((await w.as('tal', 'GET', `/api/accruals/journal?month=${OCT}`)).json() as JournalView).lines.filter(
      (l) => l.accrualId === p.id && l.kind === 'accrual',
    );
    // v3's accrual entry holds Linear only: its usage line is carried as v2 booked it (November reversed it).
    expect(v3.length).toBe(2);
    expect(v3.every((l) => l.memo.includes('Linear'))).toBe(true);
    for (const x of (await w.as('michal', 'POST', `/api/notes/${OCT}/template`, {})).json().notes)
      expect(
        (await w.as('michal', 'POST', `/api/notes/${x.id}/accept`, { version: x.versions.at(-1).version })).statusCode,
      ).toBe(200);
    expect((await w.as('yoav', 'POST', '/api/datarails/uploads', { month: OCT })).statusCode).toBe(201);
    // Relocked by Yoav and Dana: Michal started the round, so the controller who accepted it doesn't sign alone.
    c = await w.closeOf();
    expect(
      c.steps.slice(0, 9).filter((s) => s.state !== 'done' && s.state !== 'explained'),
      JSON.stringify(c.steps.map((s) => [s.key, s.state, s.summary, s.problems])),
    ).toEqual([]);
    expect((await w.sign('yoav')).statusCode).toBe(200);
    const relock = await w.sign('dana');
    expect(relock.json()).toMatchObject({ locked: true, close: { round: 1, reopened: false } });
    expect(relock.json().close.locks.map((l: { round: number }) => l.round)).toEqual([0, 1]);
    const pk = await w.sql<{ round: number }[]>`SELECT round FROM close_packages ORDER BY round`;
    expect(pk.map((x) => x.round)).toEqual([0, 1]);
    // The round's roll-forward still ties to November's opening.
    const oct = (await w.as('tal', 'GET', `/api/accruals/roll-forward?month=${OCT}`)).json() as AccrualRollForward;
    const nov = (await w.as('tal', 'GET', `/api/accruals/roll-forward?month=${NOV}`)).json() as AccrualRollForward;
    expect(nov.opening).toBe(oct.closing);
  });

  it('should-fix 14: seats beyond the contract reserve money at the seat price', async () => {
    const [c] = await w.sql<{ id: string }[]>`SELECT DISTINCT id FROM contract_versions WHERE vendor = 'Linear'`;
    const res = await w.as('tal', 'POST', '/api/requests', {
      kind: 'tool_or_seat',
      title: 'Two Linear seats',
      costCenter: 'ENG-PRODUCT',
      recurrence: 'monthly',
      start: '2026-12-02',
      amount: { amount: '20.00', currency: 'USD' },
      seat: { contractId: c!.id, seats: 2, seatPrice: '10', beyond: 0 },
    });
    expect(res.statusCode, res.body).toBe(201);
    const [r] = await w.sql<{ seat: { beyond: number }; kind: string; amount_micros: string; currency: string }[]>`
      SELECT * FROM requests WHERE id = ${res.json().request?.id ?? res.json().id}`;
    expect(r!.seat.beyond).toBe(2); // Linear has no seat left: both are beyond it
    expect(withinContract(r!)).toBe(false);
    const adds = addsInMonth(
      {
        ...(r as never as Parameters<typeof addsInMonth>[0]),
        recurrence: 'monthly',
        start_day: new Date('2027-01-01T00:00:00Z'),
        end_day: null,
      },
      '2027-01',
    );
    expect(adds.toDecimal().toString()).toBe('20.000000');
  });

  it('should-fix 9: Datarails calls refuse redirects, and only 127.0.0.1 and ::1 count as this machine', async () => {
    expect(isLoopbackUrl('http://localhost:4819/mcp')).toBe(false);
    expect(isLoopbackUrl('http://127.0.0.1:4819/mcp')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:4819/mcp')).toBe(true);
    let hits = 0;
    const target: Server = createServer((_q, s) => {
      hits++;
      s.end('{}');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const to = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    const redirector: Server = createServer((_q, s) => {
      s.writeHead(307, { location: `${to}/mcp` });
      s.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', () => r()));
    const from = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`;
    try {
      const d = new Datarails(
        w.sql,
        w.services.audit,
        w.services.webhooks,
        w.services.budgets,
        w.services.snapshots,
        w.services.notes,
        (mo) => w.services.close.period(mo),
        {
          mcpUrl: `${from}/mcp`,
          uploadUrl: `${from}/upload`,
          mcpToken: 't',
          user: 'u',
          password: 'p',
          filebox: 'f',
          real: false,
        },
        fetch,
      );
      await expect(d.pull({ dataModel: 'Budget', note: '' }, w.principal('dana'))).rejects.toThrow(/did not answer/);
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((r) => target.close(() => r()));
      await new Promise<void>((r) => redirector.close(() => r()));
    }
  });
});

describe.skipIf(!integrationEnabled('db'))('review of wave 4: world B (no CFO yet; steps 7–9 explained)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  it('B4: a reopen never escalates outside Finance CFO; with nobody eligible it waits and alerts', async () => {
    await w.login('admin'); // a service-like controller: never an approver
    // A subscriber to the alert: the outbox carries one delivery per subscription.
    await w.services.webhooks.create(
      { url: 'http://receiver.test/hook', events: ['request.no_approver'], description: '' },
      w.principal('yoav'),
    );
    const id = await w.sql.begin((tx) =>
      w.services.requests.raiseChange(
        tx,
        {
          kind: 'period_reopen',
          title: 'Reopen August 2026',
          note: 'A test of B4',
          change: { type: 'period_reopen', month: '2026-08' },
          evidence: {},
          start: '2026-11-02',
        },
        w.principal('yoav'),
      ),
    );
    await w.services.requests.submitById(id, { actor: people.yoav.email, actorKind: 'person' });
    const [r] = await w.sql<{ status: string }[]>`SELECT status FROM requests WHERE id = ${id}`;
    expect(r!.status).toBe('pending');
    const steps = await w.sql<{ groups: string[]; escalated_at: Date | null; note: string | null }[]>`
      SELECT groups, escalated_at, note FROM request_steps WHERE request_id = ${id}`;
    expect(steps.every((s) => s.groups.every((g) => g === 'Finance CFO'))).toBe(true);
    expect(steps.every((s) => s.escalated_at === null)).toBe(true);
    expect(steps[0]!.note).toMatch(/waits for the CFO/);
    const alerts = async () =>
      (await w.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'request.no_approver'`)[0]!
        .n;
    expect(await alerts()).toBe(1);
    const [hook] = await w.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbox WHERE event_type = 'request.no_approver'`;
    expect(hook!.n).toBe(1);
    // A controller (and Administrator) can't decide it; past every deadline it still waits for the CFO.
    const ev = (await w.as('roni', 'GET', `/api/requests/${id}`)).json().evidenceSha256;
    expect(
      (await w.as('roni', 'POST', `/api/requests/${id}/decisions`, { outcome: 'approve', evidenceSha256: ev }))
        .statusCode,
    ).toBe(403);
    w.clock.now = new Date('2026-11-20T10:00:00Z');
    await w.services.requests.expireDue();
    const after = await w.sql<{ status: string }[]>`SELECT status FROM requests WHERE id = ${id}`;
    expect(after[0]!.status).toBe('pending');
    const st = await w.sql<{ escalated_at: Date | null; groups: string[] }[]>`
      SELECT escalated_at, groups FROM request_steps WHERE request_id = ${id}`;
    expect(st.every((s) => s.escalated_at === null && s.groups.every((g) => g === 'Finance CFO'))).toBe(true);
    expect(await alerts()).toBe(2);
    w.clock.now = new Date('2026-11-02T10:00:00Z');
  });

  it('should-fix 2: with steps 7–9 explained, the first signature freezes a snapshot, so a lock always has one', async () => {
    expect((await w.as('michal', 'POST', `/api/close/${OCT}/start`, {})).statusCode).toBe(200);
    await w.explainRed();
    for (const key of ['accrual_accepted', 'notes_accepted', 'datarails_uploaded']) {
      const r = await w.as('michal', 'POST', `/api/close/${OCT}/explain`, {
        step: key,
        note: 'No accrual this month: the estimate is immaterial',
      });
      expect(r.statusCode, r.body).toBe(200);
    }
    const before = await w.closeOf();
    expect(before.snapshot).toBeNull();
    const first = await w.sign('yoav');
    expect(first.statusCode, first.body).toBe(200);
    const frozen = first.json().close.snapshot;
    expect(frozen.sha256).toMatch(/^[0-9a-f]{64}$/);
    const [s] = await w.sql<
      { reason: string; accrual_id: string | null }[]
    >`SELECT reason, accrual_id FROM close_snapshots`;
    expect(s).toMatchObject({ reason: 'lock', accrual_id: null });
    expect(first.json().close.signoffs[0]).toMatchObject({ snapshotSha256: frozen.sha256, seenAt: null });
    const second = await w.sign('dana');
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().locked).toBe(true);
    const [l] = await w.sql<{ snapshot_id: string | null }[]>`SELECT snapshot_id FROM close_locks`;
    expect(l!.snapshot_id).not.toBeNull();
  });
});

describe.skipIf(!integrationEnabled('db'))(
  'review of wave 4: world C (an accrual accepted before should-fix 6)',
  () => {
    let w: World;
    beforeAll(async () => {
      w = await world();
    }, 180_000);
    afterAll(async () => {
      await w?.close();
    });

    it('should-fix 6: an acceptance by an account that looks like a service, made before the rule, does not count', async () => {
      await w.login('admin');
      expect((await w.as('michal', 'POST', `/api/close/${OCT}/start`, {})).statusCode).toBe(200);
      await w.explainRed();
      const p = (await w.as('michal', 'POST', `/api/accruals/${OCT}/propose`, {})).json();
      // As October's was: Administrator's acceptance, recorded before the rule (the check is on the name, so a disguise
      // gets past it here, and the decision row still names the Administrator account).
      const disguised = { ...w.principal('admin'), name: 'Ada Admin', email: 'ada@landbright.test' };
      await w.services.accruals.accept(p.id, { sha256: p.sha256, note: 'before the rule' }, disguised);
      const step = w.step(await w.closeOf(), 'accrual_accepted');
      expect(step.state).toBe('red');
      expect(step.problems.join(' ')).toMatch(/Administrator .*not a named person/);
      // A named controller proposes and accepts it again.
      const again = await w.as('michal', 'POST', `/api/accruals/${OCT}/propose`, {});
      expect(again.statusCode, again.body).toBe(201);
      const ok = await w.as('yoav', 'POST', `/api/accruals/${again.json().id}/accept`, { sha256: again.json().sha256 });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(w.step(await w.closeOf(), 'accrual_accepted').state).toBe('done');
    });
  },
);
