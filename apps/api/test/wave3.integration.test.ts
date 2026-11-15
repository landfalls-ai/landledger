/**
 * Wave 3 against Postgres (LANDLEDGER_INTEGRATION=db), "Plan and reconcile": invoices posted beside the estimates they
 * replace and reconciled, corrected by reversal and voided whole, a locked month's true-up; the year ahead; anomalies;
 * agents; contracts and seats; the access review. People sign in through a fake Landbright with their groups.
 */
import { readFileSync } from 'node:fs';
import { createTestDatabase, integrationEnabled, type TestDatabase } from '@landledger/schema/testing';
import { Money } from '@landledger/money';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agents, AgentValueClient } from '../src/agents.js';
import { DEV_SPIKE_SERVICE, devReverse, devSpike } from '../src/anomalies.js';
import { buildApp } from '../src/app.js';
import { commitmentsIn, reservedIn, runningIncrements } from '../src/forecast.js';
import { Invoices } from '../src/invoices.js';
import { createSql, type Sql } from '../src/db.js';
import type { Principal } from '../src/principal.js';
import { RATE_CARD_V1, seed } from '../src/seed.js';
import { createServices, type Services } from '../src/services.js';
import { fakeLandbright, ISSUER, oidcConfig, type Person } from './fake-oidc.js';
import { call, fakeSources, testConfig } from './fakes.js';

const people = {
  tal: { sub: 'sub-tal', email: 'tal.levi@landbright.test', name: 'Tal Levi', roles: ['Engineering'] },
  shira: { sub: 'sub-shira', email: 'shira.navon@landbright.test', name: 'Shira Navon', roles: ['Budget Owners'] },
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
const fixture = (name: string) => readFileSync(new URL(`../fixtures/invoices/${name}`, import.meta.url), 'utf8');
const usd = (amount: string) => Money.parse(amount, 'USD');

describe.skipIf(!integrationEnabled('db'))('wave 3: plan and reconcile', () => {
  let db: TestDatabase;
  let sql: Sql;
  let services: Services;
  let app: FastifyInstance;
  let fake: Awaited<ReturnType<typeof fakeLandbright>>;
  // Monday 16 November 2026, 10:00 UTC; invoices come in once November is over (B1), on 2 December.
  const NOV_16 = new Date('2026-11-16T10:00:00Z');
  const DEC_2 = new Date('2026-12-02T10:00:00Z');
  let now = NOV_16;
  const cookie: Record<Who, string> = {} as Record<Who, string>;
  const userId: Record<Who, string> = {} as Record<Who, string>;
  const principal = (who: Who): Principal => ({
    kind: 'person',
    id: userId[who],
    name: people[who].name,
    email: people[who].email,
    roles:
      who === 'dana'
        ? ['cfo']
        : who === 'yoav' || who === 'roni'
          ? ['controller']
          : who === 'avi'
            ? ['auditor']
            : who === 'shira'
              ? ['budget_owner']
              : ['engineer'],
    groups: people[who].roles,
    scopes: ['read', 'requests:write', 'admin'],
  });
  let readKey = '';

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
    await services.rateCards.importAiLines(RATE_CARD_V1, await services.landflow!.prices(), principal('roni'));
    await services.rateCards.approve(RATE_CARD_V1, principal('yoav'));
    await services.allocation.approve('rsv_main_1', principal('dana'));
    // AI estimates: Claude Sonnet on 10–12 November ($4.50 a day in two meters: 1M input at $3, 100k output at $15),
    // and on 20 October, before the rate card's first day, at Landflow's own estimate of $4.50.
    for (const d of ['2026-10-20', '2026-11-10', '2026-11-11', '2026-11-12']) {
      sources.state.events = [call(`${d}T10:00:00.000Z`, 1_000_000, 100_000, {}, d < '2026-11' ? 4.5 : 0)];
      await services.ingest.run('landflow', d, 'manual', 'test');
    }
    sources.state.events = [];
    await services.ingest.run('clickland', '2026-11-12', 'manual', 'test');
    await services.allocation.allocatePending('2026-10');
    await services.allocation.allocatePending('2026-11');
    // Ingest's own history the anomaly scan reads; the services keep their clock.
    readKey = (await services.keys.create({ name: 'reader', scopes: ['read', 'admin'] }, principal('dana'))).key;
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
  const total = async (month: string) => usd((await services.spend.overview(month)).monthToDate.total);
  const aiEstimates = async (month: string) =>
    usd(
      (
        await sql<{ s: string }[]>`
          SELECT (coalesce(sum(effective_cost_micros), 0) / 1e6)::numeric(20,6)::text AS s FROM cost_records
          WHERE basis = 'estimated' AND tags->>'model' = 'claude-sonnet-4-5'
            AND billing_period_start = ${`${month}-01T00:00:00Z`}::timestamptz`
      )[0]!.s,
    );

  // 005 Invoices -------------------------------------------------------------------------------------------------------

  describe('invoices (spec 005)', () => {
    let novBefore: Money;
    let invoiceId = '';
    beforeAll(() => {
      now = DEC_2;
    });
    afterAll(() => {
      now = NOV_16;
      services.config.devAuth = false;
    });

    it('imports only for the controller or the CFO, signed in; a non-USD file is 422 and a bad file imports nothing', async () => {
      novBefore = await total('2026-11');
      expect(novBefore.isZero()).toBe(false);
      expect(
        (await as('tal', 'POST', '/api/invoices/import', { csv: fixture('anthropic-2026-11.csv') })).statusCode,
      ).toBe(403);
      const key = await app.inject({
        method: 'POST',
        url: '/api/invoices/import',
        headers: { authorization: `Bearer ${readKey}` },
        payload: { csv: fixture('anthropic-2026-11.csv') },
      });
      expect(key.statusCode).toBe(403);
      expect(key.json().error.message).toMatch(/key never does/);
      const eur = await as('yoav', 'POST', '/api/invoices/import', {
        csv: fixture('anthropic-2026-11.csv').replace(/,USD,Credit/, ',EUR,Credit'),
      });
      expect(eur.statusCode).toBe(422);
      const bad = await as('yoav', 'POST', '/api/invoices/import', {
        csv: fixture('anthropic-2026-11.csv').replace('12.600000', '12.6000001'),
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.details.problems[0]).toMatch(/^Line 2: amount/);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM invoices`;
      expect(n).toBe(0);
    });

    it('posts each line beside the estimates it replaces, and every figure counts each charge once', async () => {
      const sonnetEstimates = await aiEstimates('2026-11');
      expect(sonnetEstimates.toString()).toBe(usd('13.5').toString()); // three days at $4.50
      const res = await as('yoav', 'POST', '/api/invoices/import', {
        csv: fixture('anthropic-2026-11.csv'),
        fileName: 'anthropic-2026-11.csv',
      });
      expect(res.statusCode).toBe(201);
      const inv = res.json().invoices[0];
      invoiceId = inv.id;
      expect(inv).toMatchObject({
        provider: 'Anthropic',
        month: '2026-11',
        version: 1,
        status: 'posted',
        total: '23.500000',
      });
      // Sonnet's three lines split over its six estimates (three days, input and output; linked); Haiku's two lines
      // and the credit post on their own.
      expect(inv.posted).toEqual({ added: 9, reversed: 0, unchanged: 0, linkedEstimates: 6 });
      const records = await sql`
        SELECT source_key, effective_cost_micros::text AS m, billed_cost_micros::text AS b, invoice_id, charge_class,
               charge_category, tags FROM cost_records WHERE source = 'invoice' ORDER BY source_key`;
      expect(records).toHaveLength(9);
      for (const r of records) {
        expect(r.m).toBe(r.b); // invoiced: BilledCost = EffectiveCost
        expect(r.invoice_id).toBe('DEV-ANT-2026-11-0042');
        expect(r.charge_class).toBeNull();
      }
      const sonnet = records.filter((r) => r.tags.model === 'claude-sonnet-4-5');
      // $22.50 split by estimate: $5 for each day's input ($3 estimated), $2.50 for each day's output ($1.50).
      expect(sonnet.map((r) => r.m).sort()).toEqual(['2500000', '2500000', '2500000', '5000000', '5000000', '5000000']);
      expect(sonnet[0]!.tags).toMatchObject({ agent: 'ag_1', invoice: 'DEV-ANT-2026-11-0042' }); // the estimate's tags
      // Shown = before − the estimates replaced + the invoice.
      const after = await total('2026-11');
      expect(after.toString()).toBe(novBefore.minus(sonnetEstimates).plus(usd('23.5')).toString());
      const ov = await services.spend.overview('2026-11');
      expect(usd(ov.monthToDate.invoiced).toString()).toBe(usd('23.5').toString());
      const audit = await sql`SELECT actor, data FROM audit_log WHERE action = 'invoice.imported'`;
      expect(audit[0]).toMatchObject({ actor: 'yoav.bendavid@landbright.test', data: { added: 9, linked: 6 } });
    });

    it('reconciles per provider and model against every live estimate, within ±2%', async () => {
      const r = (await as('avi', 'GET', '/api/reconciliation?month=2026-11')).json();
      expect(r.tolerancePct).toBe('2');
      const row = (model: string) => r.rows.find((x: { model: string }) => x.model === model);
      expect(row('claude-sonnet-4-5')).toMatchObject({
        provider: 'anthropic',
        estimated: '13.500000',
        invoiced: '22.500000',
        variance: '9.000000',
        variancePct: '66.7',
        status: 'outside',
      });
      expect(row('claude-haiku-4-5')).toMatchObject({
        estimated: '0.000000',
        invoiced: '3.000000',
        status: 'no_estimate',
      });
      expect(row('(other charges)')).toMatchObject({ invoiced: '-2.000000', status: 'no_estimate' });
      expect(r.invoices).toHaveLength(1);
      expect(Number(r.totals.invoicedShare)).toBe(100); // every AI charge this month is now invoiced
      const snaps = await sql`SELECT status, model FROM reconciliations ORDER BY model`;
      expect(snaps.map((s) => s.status)).toEqual(['no_estimate', 'no_estimate', 'outside']);
    });

    it('re-importing corrects by reversal and re-entry: unchanged lines are skipped', async () => {
      const again = (
        await as('yoav', 'POST', '/api/invoices/import', { csv: fixture('anthropic-2026-11.csv') })
      ).json();
      expect(again.invoices[0]).toMatchObject({ version: 2, posted: { added: 0, reversed: 0, unchanged: 9 } });
      const changed = fixture('anthropic-2026-11.csv')
        .replace('9.150000', '0.150000')
        .replace(/\n[^\n]*Credit[^\n]*\n?$/, '\n');
      const raw = await as('yoav', 'POST', '/api/invoices/import', { csv: changed });
      expect(raw.statusCode, raw.body).toBe(201);
      const res = raw.json();
      // Sonnet's six parts change ($13.50 now): reversed and re-entered; the credit vanished: reversed.
      expect(res.invoices[0]).toMatchObject({ version: 3, posted: { added: 6, reversed: 7, unchanged: 2 } });
      expect((await total('2026-11')).toString()).toBe(
        novBefore.minus(usd('13.5')).plus(usd('13.5')).plus(usd('3')).toString(),
      );
      const row = (await services.invoices.reconciliation('2026-11')).rows.find((x) => x.model === 'claude-sonnet-4-5');
      expect(row).toMatchObject({
        estimated: '13.500000',
        invoiced: '13.500000',
        variance: '0.000000',
        status: 'matched',
      });
      // Nothing was edited: every change is a reversal.
      const [{ n }] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM cost_records WHERE source = 'invoice' AND correction_of_id IS NOT NULL`;
      expect(n).toBe(7);
    });

    it('voiding reverses the invoice whole and gives the estimates back', async () => {
      expect((await as('tal', 'POST', `/api/invoices/${invoiceId}/void`, { reason: 'wrong file' })).statusCode).toBe(
        403,
      );
      const res = await as('dana', 'POST', `/api/invoices/${invoiceId}/void`, { reason: 'Re-issued by the provider' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'voided', version: 4 });
      expect((await total('2026-11')).toString()).toBe(novBefore.toString());
      expect((await as('dana', 'POST', `/api/invoices/${invoiceId}/void`, { reason: 'again' })).statusCode).toBe(409);
      // Imported again after a void: posted afresh, linked again.
      const back = (await as('yoav', 'POST', '/api/invoices/import', { csv: fixture('anthropic-2026-11.csv') })).json();
      expect(back.invoices[0]).toMatchObject({
        version: 5,
        status: 'posted',
        posted: { added: 9, linkedEstimates: 6 },
      });
      expect((await total('2026-11')).toString()).toBe(novBefore.minus(usd('13.5')).plus(usd('23.5')).toString());
    });

    it('books a locked month’s true-up in the open month as a Correction; the locked month never moves', async () => {
      await services.periods.advance('2026-10', 'closing', principal('yoav'));
      await services.periods.advance('2026-10', 'locked', principal('yoav'), { reason: 'test: lock October' });
      const octBefore = await total('2026-10');
      const novNow = await total('2026-11');
      const decBefore = await total('2026-12');
      const csv = [
        'provider,invoice_number,period,model,sku,quantity,unit,amount,currency',
        'Anthropic,DEV-ANT-2026-10,2026-10,claude-sonnet-4-5,input-tokens,1000000,Tokens,4.80,USD',
      ].join('\n');
      const res = (await as('yoav', 'POST', '/api/invoices/import', { csv })).json();
      // B2: the true-up links the estimate it trued up (`trued_up`), so no later invoice subtracts it again.
      expect(res.invoices[0]).toMatchObject({ correction: true, posted: { added: 1, linkedEstimates: 1 } });
      const links = await sql`SELECT kind FROM invoice_estimate_links WHERE month = '2026-10-01'`;
      expect(links.map((l) => l.kind)).toEqual(['trued_up']);
      const [trueUp] = await sql`
        SELECT effective_cost_micros::text AS m, charge_class, charge_period_start, billing_period_start
        FROM cost_records WHERE source_key LIKE 'invoice:anthropic:DEV-ANT-2026-10:trueup:%'`;
      expect(trueUp).toMatchObject({ m: '300000', charge_class: 'Correction' }); // $4.80 − $4.50
      // Booked in the open month: December, as November is over (B1) and only October is locked.
      expect(trueUp!.billing_period_start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
      expect((await total('2026-10')).toString()).toBe(octBefore.toString());
      expect((await total('2026-11')).toString()).toBe(novNow.toString());
      expect((await total('2026-12')).toString()).toBe(decBefore.plus(usd('0.3')).toString());
      const oct = (await services.invoices.reconciliation('2026-10')).rows[0]!;
      // 6.7% is over the 5% tolerance, but $0.30 is under the $0.50 floor (review nit): cents never read as outside.
      expect(oct).toMatchObject({ estimated: '4.500000', invoiced: '4.800000', status: 'matched', variancePct: '6.7' });
    });

    it('imports the Ollama fixture at $0: matched against no estimates here, and nothing moves', async () => {
      const before = await total('2026-11');
      const res = (await as('yoav', 'POST', '/api/invoices/import', { csv: fixture('ollama-2026-11.csv') })).json();
      expect(res.invoices[0]).toMatchObject({ provider: 'Ollama', total: '0.000000' });
      expect((await total('2026-11')).toString()).toBe(before.toString());
    });

    it('refuses an invoice for a month that is not over in LANDLEDGER_TZ (B1)', async () => {
      now = NOV_16;
      const res = await as('yoav', 'POST', '/api/invoices/import', {
        csv: fixture('anthropic-2026-11.csv').replaceAll('DEV-ANT-2026-11-0042', 'EARLY-1'),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.problems[0]).toMatch(/period 2026-11 hasn't ended yet \(UTC\)/);
      now = DEC_2;
    });

    it('takes a dev fixture only on a dev API, tags it, and counts it nowhere but Reconciliation (B4)', async () => {
      const csv = fixture('anthropic-2026-11.csv').replaceAll('DEV-ANT-2026-11-0042', 'DEV-FIX-1');
      const refused = await as('yoav', 'POST', '/api/invoices/import', { csv, origin: 'dev-fixture' });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.message).toMatch(/development API only/);
      const before = await services.spend.overview('2026-11');
      services.config.devAuth = true;
      const res = await as('yoav', 'POST', '/api/invoices/import', { csv, origin: 'dev-fixture' });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().invoices[0]).toMatchObject({ origin: 'dev-fixture', posted: { linkedEstimates: 0 } });
      const tags = await sql`SELECT DISTINCT tags->>'origin' AS o FROM cost_records WHERE invoice_id = 'DEV-FIX-1'`;
      expect(tags.map((t) => t.o)).toEqual(['dev-fixture']);
      // Not in month to date, the invoiced share, budgets or exports (every figure reads Spend.lines).
      const after = await services.spend.overview('2026-11');
      expect(after.monthToDate).toEqual(before.monthToDate);
      // On Reconciliation only, badged; never in its totals.
      const r = await services.invoices.reconciliation('2026-11');
      const dev = r.rows.filter((x) => x.devFixture);
      expect(dev.length).toBeGreaterThan(0);
      expect(usd(r.totals.invoiced).toString()).toBe(
        r.rows
          .filter((x) => !x.devFixture)
          .reduce((a, x) => a.plus(usd(x.invoiced)), usd('0'))
          .toString(),
      );
      // Voiding one is taking test data out: it works once the API has left dev sign-in too.
      services.config.devAuth = false;
      const id = res.json().invoices[0].id;
      expect((await as('avi', 'POST', `/api/invoices/${id}/void`, { reason: 'dev fixture' })).statusCode).toBe(403);
      expect((await as('dana', 'POST', `/api/invoices/${id}/void`, { reason: 'dev fixture' })).statusCode).toBe(200);
      expect((await services.spend.overview('2026-11')).monthToDate).toEqual(before.monthToDate);
    });

    it('refuses to move a posted invoice to another month: void it first (should-fix 8)', async () => {
      const moved = fixture('ollama-2026-11.csv').replaceAll(',2026-11,', ',2026-10,');
      const res = await as('yoav', 'POST', '/api/invoices/import', { csv: moved });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/is posted for 2026-11: void it before importing it for 2026-10/);
    });
  });
  // 006 Forecasts ------------------------------------------------------------------------------------------------------

  describe('forecasts (spec 006)', () => {
    const raise = async (body: Record<string, unknown>) => {
      const res = await as('tal', 'POST', '/api/requests', {
        kind: 'infra_change',
        recurrence: 'monthly',
        start: '2026-11-16',
        ...body,
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().request;
    };

    it('sends a request whose first full month has no budget to Finance, never automatically, and says why (decision 8)', async () => {
      await services.budgets.import(
        { csv: 'cost_center,month,amount,currency\nRND-DATA,2026-11,5000.00,USD\n', note: 'test: room in November' },
        principal('dana'),
      );
      const r = await raise({
        title: 'A data node',
        costCenter: 'RND-DATA',
        amount: { amount: '50.00', currency: 'USD' },
      });
      expect(r.automatic).toBe(false);
      expect(r.status).toBe('pending');
      expect(r.steps.map((s: { key: string }) => s.key)).toContain('finance');
      expect(r.policy.reason).toMatch(/Nothing is automatic where there is no budget/);
      const shown = (await as('shira', 'GET', `/api/requests/${r.id}`)).json();
      expect(shown.evidence.firstFullMonth).toMatchObject({ month: '2026-12', budget: null });
      expect(shown.evidence.budgetMissing).toMatch(/decision 8/);
      // With December's budget too, the same request is automatic again.
      await services.budgets.import(
        { csv: 'cost_center,month,amount,currency\nRND-DATA,2026-12,5000.00,USD\n', note: 'test: December' },
        principal('dana'),
      );
      const again = await raise({
        title: 'A data node again',
        costCenter: 'RND-DATA',
        amount: { amount: '50.00', currency: 'USD' },
      });
      expect(again).toMatchObject({ status: 'approved', automatic: true });
      expect((await as('shira', 'GET', `/api/requests/${again.id}`)).json().evidence.budgetMissing).toBeNull();
    });

    it('counts an approved open-ended request beyond its reserved months as committed, month by month', async () => {
      const f = (await as('avi', 'GET', '/api/forecast?months=6')).json();
      expect(f.months.map((m: { month: string }) => m.month)).toEqual([
        '2026-11',
        '2026-12',
        '2027-01',
        '2027-02',
        '2027-03',
        '2027-04',
      ]);
      // "A data node again": $50 a month, reserved 16 November to January; from February it is committed.
      const by = Object.fromEntries(f.months.map((m: { month: string }) => [m.month, m]));
      expect(by['2026-12'].reserved).toBe('50.000000');
      expect(by['2026-12'].committed).toBe('0.000000');
      expect(by['2027-02'].committed).toBe('50.000000');
      expect(by['2027-02'].reserved).toBe('0.000000');
      // February has no budget: "no budget", never on track.
      expect(by['2027-02']).toMatchObject({ budget: null, state: 'none' });
      expect(f.commitments.find((c: { title: string }) => c.title === 'A data node again')).toMatchObject({
        costCenter: 'RND-DATA',
        monthly: '50.000000',
        reservedThrough: '2027-01',
      });
      // The next 12 months from tomorrow, bounded by end dates (review of wave 3, nit): 17–30 November (14/30 of $50)
      // and eleven full months, not monthly × 12.
      expect(f.annualised.commitments).toBe('573.333333');
      expect(by['2027-02'].contracted).toBe('0.000000');
      // Two days of Clickland data are not enough for a band: the forecast says so instead of guessing.
      if (f.status === 'insufficient') {
        expect(f.basis).toMatch(/Not enough data yet/);
        expect(by['2027-02'].runRate).toBeNull();
        expect(f.annualised.total).toBeNull();
      } else {
        for (const m of f.months) {
          expect(Number(m.runRate.p10)).toBeLessThanOrEqual(Number(m.runRate.p50));
          expect(Number(m.runRate.p50)).toBeLessThanOrEqual(Number(m.runRate.p90));
        }
      }
      // Overview carries the committed figure and P10 ≤ P50 ≤ P90 when it has a band; one formula with the year ahead.
      const ov = (await as('avi', 'GET', '/api/overview?month=2026-11')).json();
      expect(ov.forecast.committed).toBe('0.000000');
      expect(by['2026-11'].total).toBe(ov.forecast.amount);
      expect(by['2026-11'].reserved).toBe(ov.forecast.reserved);
      if (ov.forecast.p50) {
        expect(Number(ov.forecast.p10)).toBeLessThanOrEqual(Number(ov.forecast.p50));
        expect(Number(ov.forecast.p50)).toBeLessThanOrEqual(Number(ov.forecast.p90));
        expect(Number(ov.forecast.p10)).toBeGreaterThanOrEqual(Number(ov.monthToDate.total));
      }
      expect((await as('avi', 'GET', '/api/forecast?months=0')).statusCode).toBe(400);
    });

    it('nets what a running request already adds to the run rate out of its reservation and commitment (should-fix 1)', async () => {
      const res = await as('shira', 'POST', '/api/requests', {
        kind: 'infra_change',
        title: 'Matched runner',
        costCenter: 'RND-DATA',
        amount: { amount: '60.00', currency: 'USD' },
        recurrence: 'monthly',
        start: '2026-11-16',
        evidence: { match: { service: 'Runner API' } },
      });
      expect(res.statusCode, res.body).toBe(201);
      const r = res.json().request;
      expect(r.status).toBe('approved');
      // Its matched cost over the last seven full days: $70, $10 a day above its $0 baseline.
      const line = (d: string, amt: string) => ({
        day: d,
        amount: usd(amt),
        costCenter: 'RND-DATA',
        source: 'clickland',
        tags: {},
        serviceName: 'Runner API',
        correction: false,
      });
      const fakeSpend = {
        lines: async (sel: { from: string; to: string }) => {
          expect(sel).toEqual({ from: '2026-11-09', to: '2026-11-15' });
          return { lines: [line('2026-11-09', '30'), line('2026-11-14', '40')] };
        },
      } as unknown as Services['spend'];
      const running = await runningIncrements(sql, fakeSpend, '2026-11-16');
      expect(running.get(r.id)?.toString()).toBe('USD 10.000000');
      // February is beyond its reservations: $60 gross, but 28 days × $10 already in the run rate, so nothing more.
      const feb = (await commitmentsIn(sql, '2027-02', '2027-02-01', running)).find((c) => c.requestId === r.id)!;
      expect(feb.gross.toString()).toBe('USD 60.000000');
      expect(feb.amount.toString()).toBe('USD 0.000000');
      // At $1 a day, $32 is left to ramp to; a reservation nets the same way.
      const slow = new Map([[r.id, usd('1')]]);
      const feb1 = (await commitmentsIn(sql, '2027-02', '2027-02-01', slow)).find((c) => c.requestId === r.id)!;
      expect(feb1.amount.toString()).toBe('USD 32.000000');
      const dec = await reservedIn(sql, '2026-12', '2026-12-01', slow);
      expect(dec.gross.get('RND-DATA')!.minus(dec.net.get('RND-DATA')!).toString()).toBe('USD 31.000000');
    });

    it('reads a request from approval to bill on one basis: consumed above the baseline, invoiced a share of it (should-fix 7)', async () => {
      const [r] = await sql<Parameters<Invoices['lifecycle']>[0][]>`
        SELECT id, title, status, amount_micros::text AS amount_micros, currency, recurrence, start_day, end_day,
               decided_at, closed_by, cost_center, evidence, automatic
        FROM requests WHERE title = 'Matched runner'`;
      const line = (d: string, amt: string, basis: 'estimated' | 'invoiced') => ({
        day: d,
        amount: usd(amt),
        basis,
        costCenter: 'RND-DATA',
        source: 'clickland',
        tags: {},
        serviceName: 'Runner API',
        correction: false,
      });
      // 16 November: $90 estimated and $30 invoiced of it matched; nothing before its first day counts.
      const fakeSpend = {
        lines: async () => ({
          lines: [
            line('2026-11-15', '500', 'estimated'),
            line('2026-11-16', '90', 'estimated'),
            line('2026-11-16', '30', 'invoiced'),
          ],
        }),
      } as unknown as Services['spend'];
      const lc = (await new Invoices(sql, services.audit, fakeSpend, {}, () => now).lifecycle(r!))!;
      const stage = Object.fromEntries(lc.stages.map((x) => [x.key, x.amount]));
      // Approved to date: $60 a month from the 16th, 15 of 30 days. Consumed $120, uncapped, so the overrun shows.
      expect(lc.approvedToDate).toBe('30.000000');
      expect(stage).toMatchObject({ consumed: '120.000000', invoiced: '30.000000' });
      expect(lc).toMatchObject({
        actualToDate: '120.000000',
        variance: '90.000000',
        variancePct: '300.0',
        invoicedShare: '25',
      });
    });

    it("reads a cost center's reservations into its state when there is no run rate yet (should-fix 3)", async () => {
      await services.budgets.import(
        {
          csv: 'cost_center,month,amount,currency\nGA-IT,2026-11,40.00,USD\nGA-IT,2026-12,100.00,USD\n',
          note: 'test: GA-IT',
        },
        principal('dana'),
      );
      const res = await as('shira', 'POST', '/api/requests', {
        kind: 'infra_change',
        title: 'IT runner',
        costCenter: 'GA-IT',
        amount: { amount: '60.00', currency: 'USD' },
        recurrence: 'monthly',
        start: '2026-11-16',
      });
      expect(res.statusCode, res.body).toBe(201);
      const ov = await services.spend.overview('2026-11');
      const it = ov.costCenters.find((c) => c.code === 'GA-IT')!;
      expect(usd(it.monthToDate).isZero()).toBe(true);
      // Reserved 16–30 November: $30 of a $40 budget; nothing spent yet, so not at risk.
      expect(it.reserved).toBe('30.000000');
      expect(['early', 'ok']).toContain(it.state);
      await services.budgets.import(
        { csv: 'cost_center,month,amount,currency\nGA-IT,2026-11,20.00,USD\n', note: 'test: GA-IT cut' },
        principal('dana'),
      );
      const cut = (await services.spend.overview('2026-11')).costCenters.find((c) => c.code === 'GA-IT')!;
      expect(['risk', 'over']).toContain(cut.state);
    });
  });
  // 007 Anomalies ------------------------------------------------------------------------------------------------------

  describe('anomalies (spec 007)', () => {
    const outbox = async (type: string) =>
      (
        await sql<{ data: Record<string, unknown> }[]>`
          SELECT payload->'data' AS data FROM outbox WHERE event_type = ${type} ORDER BY created_at, id`
      ).map((r) => r.data);
    let agentAnomaly = '';

    it('flags today’s agent and model cost against a quiet fortnight, once, with a webhook and an audit entry', async () => {
      await services.webhooks.create(
        {
          url: 'https://receiver.test/hook',
          events: ['cost.anomaly', 'approval.anomaly'],
          description: 'test',
        } as never,
        principal('dana'),
      );
      // Observed days: Landflow read with no calls on 2–9 November (10–12 November had $4.50 a day).
      sources.state.events = [];
      for (let d = 2; d <= 9; d++) await services.ingest.run('landflow', `2026-11-0${d}`, 'manual', 'test');
      // Today so far: one $45 call (10M input at $3, 1M output at $15).
      sources.state.events = [call('2026-11-16T09:00:00.000Z', 10_000_000, 1_000_000)];
      await services.ingest.run('landflow', '2026-11-16', 'manual', 'test');
      sources.state.events = [];
      const r = await services.anomalies.scanCost('2026-11-16');
      expect(r.observedDays).toBeGreaterThanOrEqual(7);
      expect(r.found).toBeGreaterThanOrEqual(2);
      const list = (await as('avi', 'GET', '/api/anomalies?kind=cost')).json().anomalies;
      const agent = list.find((a: { dimension: string; key: string }) => a.dimension === 'agent' && a.key === 'ag_1');
      expect(agent).toMatchObject({
        rule: 'cost_jump',
        observed: '45.000000',
        baseline: '0.000000',
        acknowledged: null,
      });
      expect(agent.summary).toMatch(/Triage lead cost \$45\.00 so far today/);
      agentAnomaly = agent.id;
      expect(
        list.find((a: { dimension: string; key: string }) => a.dimension === 'model' && a.key === 'claude-sonnet-4-5'),
      ).toBeTruthy();
      // Stored once: the next hour's scan finds nothing new.
      expect((await services.anomalies.scanCost('2026-11-16')).found).toBe(0);
      const sent = await outbox('cost.anomaly');
      expect(sent.length).toBe(r.found);
      expect(sent.map((d) => (d.anomaly as { id: string }).id)).toContain(agentAnomaly);
      expect(String(sent[0]!.url)).toMatch(/\/anomalies\?id=anm_/);
      const [{ n }] =
        (await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'anomaly.cost'`) as unknown as [
          { n: number },
        ];
      expect(n).toBe(r.found);
    });

    it('is acknowledged by a person with a note, audited; auditors and keys cannot; it stays open until closed', async () => {
      const url = `/api/anomalies/${agentAnomaly}/acknowledge`;
      expect((await as('avi', 'POST', url, { note: 'Seen it' })).statusCode).toBe(403);
      const key = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${readKey}` },
        payload: { note: 'Seen it' },
      });
      expect(key.statusCode).toBe(403);
      const ok = await as('shira', 'POST', url, { note: 'The triage agent’s backfill; expected once' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().acknowledged).toMatchObject({ by: people.shira.email, note: expect.stringMatching(/backfill/) });
      expect((await as('shira', 'POST', url, { note: 'Again' })).statusCode).toBe(409);
      // Should-fix 13: acknowledged is seen, not settled; it stays on the open list until closed with an outcome.
      const open = (await as('avi', 'GET', '/api/anomalies')).json().anomalies;
      expect(open.find((a: { id: string }) => a.id === agentAnomaly)).toMatchObject({ status: 'acknowledged' });
      const [audit] = await sql`SELECT actor, data FROM audit_log WHERE action = 'anomaly.acknowledged'`;
      expect(audit).toMatchObject({ actor: people.shira.email });
    });

    it('takes the higher figure, alerts again at twice it, and logs cost anomalies only to Clickland, with ids (should-fix 13, 10)', async () => {
      const log = (services.anomalies as unknown as { log: { warn: (o: Record<string, unknown>, m: string) => void } })
        .log;
      const logged: Record<string, unknown>[] = [];
      const warn = log.warn;
      log.warn = (o) => void logged.push(o);
      const ingestTo = async (calls: number) => {
        sources.state.events = Array.from({ length: calls }, (_, i) =>
          call(`2026-11-16T09:${String(i * 10).padStart(2, '0')}:00.000Z`, 10_000_000, 1_000_000),
        );
        await services.ingest.run('landflow', '2026-11-16', 'manual', 'test');
        sources.state.events = [];
        await services.anomalies.scanCost('2026-11-16');
        return (await as('avi', 'GET', '/api/anomalies?status=all'))
          .json()
          .anomalies.find((a: { id: string }) => a.id === agentAnomaly);
      };
      try {
        // $45 → $67.50 a day so far... not yet double: the figure moves, no second alert.
        const before = (await outbox('cost.anomaly')).length;
        const a3 = await ingestTo(1);
        expect(a3).toMatchObject({ observed: '45.000000', current: '45.000000', alerts: 1 });
        const a4 = await ingestTo(2);
        expect(a4).toMatchObject({ observed: '45.000000', current: '90.000000', alerts: 2 });
        const sent = await outbox('cost.anomaly');
        const again = sent.slice(before).filter((d) => (d.anomaly as { id: string }).id === agentAnomaly);
        expect(again).toHaveLength(1);
        expect(again[0]).toMatchObject({ escalation: true });
        const a5 = await ingestTo(3);
        expect(a5).toMatchObject({ current: '135.000000', alerts: 2 });
        const [esc] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'anomaly.escalated'
                                  AND subject_id = ${agentAnomaly}`;
        expect(esc!.n).toBe(1);
        // To Clickland: ids and figures, never a summary or a name; approval patterns never.
        const mine = logged.filter((o) => o['landledger.anomaly.id'] === agentAnomaly);
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({ 'landledger.event': 'cost.anomaly', 'landledger.anomaly.escalation': 'true' });
        expect(JSON.stringify(logged)).not.toMatch(/Triage lead|@landbright|summary/);
      } finally {
        log.warn = warn;
        // Back to the one call, so the agents' figures below read the day as before (the anomaly keeps its high).
        await ingestTo(1);
      }
    });

    it('is assigned and closed with an outcome by a person, audited; then it leaves the open list (should-fix 13)', async () => {
      const url = (what: string) => `/api/anomalies/${agentAnomaly}/${what}`;
      expect(
        (await as('avi', 'POST', url('assign'), { assignee: { email: people.roni.email }, note: 'x' })).statusCode,
      ).toBe(403);
      const assigned = await as('shira', 'POST', url('assign'), {
        assignee: { email: people.roni.email },
        note: 'Roni checks the backfill',
      });
      expect(assigned.statusCode, assigned.body).toBe(200);
      expect(assigned.json().assignee).toMatchObject({ name: people.roni.email, by: people.shira.email });
      expect((await as('roni', 'POST', url('close'), { outcome: 'resolved', note: 'Backfill' })).statusCode).toBe(400);
      const closed = await as('roni', 'POST', url('close'), { outcome: 'expected', note: 'The backfill, once' });
      expect(closed.statusCode, closed.body).toBe(200);
      expect(closed.json()).toMatchObject({
        status: 'closed',
        closed: { by: people.roni.email, outcome: 'expected', note: 'The backfill, once' },
      });
      expect((await as('shira', 'POST', url('close'), { outcome: 'fixed', note: 'Again' })).statusCode).toBe(409);
      const open = (await as('avi', 'GET', '/api/anomalies')).json().anomalies;
      expect(open.map((a: { id: string }) => a.id)).not.toContain(agentAnomaly);
      const all = (await as('avi', 'GET', '/api/anomalies?status=all')).json().anomalies;
      expect(all.map((a: { id: string }) => a.id)).toContain(agentAnomaly);
      const actions = await sql<{ action: string; actor: string }[]>`
        SELECT action, actor FROM audit_log WHERE subject_id = ${agentAnomaly}
          AND action IN ('anomaly.assigned', 'anomaly.closed') ORDER BY seq`;
      expect(actions.map((a) => [a.action, a.actor])).toEqual([
        ['anomaly.assigned', people.shira.email],
        ['anomaly.closed', people.roni.email],
      ]);
    });

    it('finds a spend split under the automatic threshold and automatic approvals raised again and again', async () => {
      await services.budgets.import(
        {
          csv: 'cost_center,month,amount,currency\nENG-AGENTS,2026-11,5000.00,USD\nENG-AGENTS,2026-12,5000.00,USD\n',
          note: 'test: room for automatic approvals',
        },
        principal('dana'),
      );
      // Three under the threshold go through by policy; the fourth reaches it (the month's automatic total counts), so a
      // person decides it. Together they are a split; the three automatic ones a ratchet.
      const ids: string[] = [];
      for (const [title, amt, automatic] of [
        ['Runner node A', '150.00', true],
        ['Runner node B', '150.00', true],
        ['Runner node C', '150.00', true],
        ['Runner node D', '120.00', false],
      ] as const) {
        const res = await as('tal', 'POST', '/api/requests', {
          kind: 'infra_change',
          title,
          costCenter: 'ENG-AGENTS',
          amount: { amount: amt, currency: 'USD' },
          recurrence: 'monthly',
          start: '2026-11-16',
        });
        expect(res.statusCode, res.body).toBe(201);
        expect(res.json().request.automatic, res.json().request.policy?.reason).toBe(automatic);
        ids.push(res.json().request.id);
      }
      const scan = await as('dana', 'POST', '/api/anomalies/scan');
      expect(scan.statusCode, scan.body).toBe(200);
      expect(scan.json().approval).toBeGreaterThanOrEqual(2);
      const list = (await as('avi', 'GET', '/api/anomalies?kind=approval')).json().anomalies;
      const split = list.find((a: { rule: string }) => a.rule === 'split');
      // Across cost centers (review of wave 3): Tal's two $50 data nodes on RND-DATA from the forecast tests count too.
      expect(split).toMatchObject({ dimension: 'requester', costCenter: null, observed: '670.000000' });
      expect(split.requests.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(ids));
      expect(split.requests).toHaveLength(6);
      expect(split.summary).toMatch(
        /Tal Levi raised or sponsored 6 infra change requests on ENG-AGENTS, RND-DATA within 72 hours, each under the \$500\.00 line/,
      );
      const ratchet = list.find((a: { rule: string }) => a.rule === 'automatic_ratchet');
      expect(ratchet.summary).toMatch(
        /3 requests raised or sponsored by Tal Levi on ENG-AGENTS were approved automatically in 2026-11/,
      );
      expect((await outbox('approval.anomaly')).length).toBeGreaterThanOrEqual(2);
      // Once: scanning again adds nothing.
      expect((await as('dana', 'POST', '/api/anomalies/scan')).json().approval).toBe(0);
    });

    it('never lets the people a pattern names act on it, and never ages one out (should-fix 13)', async () => {
      const list = (await as('avi', 'GET', '/api/anomalies?kind=approval')).json().anomalies;
      const split = list.find((a: { rule: string }) => a.rule === 'split');
      expect(split.named).toEqual([userId.tal]);
      for (const what of ['acknowledge', 'close'] as const)
        expect(
          (await as('tal', 'POST', `/api/anomalies/${split.id}/${what}`, { note: 'mine', outcome: 'expected' }))
            .statusCode,
        ).toBe(403);
      const toTal = await as('shira', 'POST', `/api/anomalies/${split.id}/assign`, {
        assignee: { email: people.tal.email },
        note: 'x',
      });
      expect(toTal.statusCode).toBe(400);
      expect(toTal.json().error.message).toMatch(/names that person/);
      // Ninety days on, unacknowledged, it is still open.
      now = new Date('2027-02-16T10:00:00Z');
      try {
        const later = (await as('avi', 'GET', '/api/anomalies')).json().anomalies;
        expect(later.map((a: { id: string }) => a.id)).toContain(split.id);
      } finally {
        now = NOV_16;
      }
    });

    it('finds a split under each policy line, not only the automatic one (should-fix 16)', async () => {
      // Three $1,800 requests by Yoav: each above the automatic $500 and under the $5,000 Finance line, $5,400 together.
      const ids: string[] = [];
      for (const t of ['Cluster A', 'Cluster B', 'Cluster C']) {
        const res = await as('yoav', 'POST', '/api/requests', {
          kind: 'infra_change',
          title: t,
          costCenter: 'RND-DATA',
          amount: { amount: '1800.00', currency: 'USD' },
          recurrence: 'monthly',
          start: '2026-11-16',
        });
        expect(res.statusCode, res.body).toBe(201);
        ids.push(res.json().request.id);
      }
      await services.anomalies.scanApprovals();
      const list = (await as('avi', 'GET', '/api/anomalies?kind=approval')).json().anomalies;
      const split = list.find(
        (a: { rule: string; key: string }) => a.rule === 'split' && a.key === `${userId.yoav}:5000000000`,
      );
      expect(split).toMatchObject({ observed: '5400.000000', costCenter: 'RND-DATA' });
      expect(split.summary).toMatch(
        /Yoav Ben David raised or sponsored 3 infra change requests on RND-DATA .* under the \$5000\.00 line and \$5400\.00 together/,
      );
      expect(split.requests.map((r: { id: string }) => r.id)).toEqual(ids);
      // A cancelled request splits nothing.
      for (const id of ids) await as('yoav', 'POST', `/api/requests/${id}/cancel`, { reason: 'test' });
    });

    it('flags one approver for one requester per step, only where someone else could decide too (should-fix 17)', async () => {
      await services.budgets.import(
        {
          csv: 'cost_center,month,amount,currency\nENG-PLATFORM,2026-11,50000.00,USD\nENG-PLATFORM,2026-12,50000.00,USD\n',
          note: 'test: room on ENG-PLATFORM',
        },
        principal('dana'),
      );
      const decideAll = async (costCenter: string) => {
        for (let i = 0; i < 5; i++) {
          const res = await as('tal', 'POST', '/api/requests', {
            kind: 'infra_change',
            title: `${costCenter} box ${i}`,
            costCenter,
            amount: { amount: '600.00', currency: 'USD' },
            recurrence: 'once',
            start: '2026-11-16',
          });
          expect(res.statusCode, res.body).toBe(201);
          const id = res.json().request.id;
          for (let k = 0; k < 4; k++) {
            const shown = (await as('dana', 'GET', `/api/requests/${id}`)).json();
            if (shown.request.status !== 'pending') break;
            const step = shown.request.steps.find((x: { status: string }) => x.status === 'pending');
            // Shira decides every budget owner step; Finance, whoever is first.
            const who: Who = step.key === 'budget_owner' ? 'shira' : 'yoav';
            const mine = (await as(who, 'GET', `/api/requests/${id}`)).json();
            const d = await as(who, 'POST', `/api/requests/${id}/decisions`, {
              outcome: 'approve',
              evidenceSha256: mine.evidenceSha256,
              step: mine.request.currentStep,
            });
            expect(d.statusCode, d.body).toBe(201);
          }
        }
      };
      const pairsNow = async () =>
        (await as('avi', 'GET', '/api/anomalies?kind=approval'))
          .json()
          .anomalies.filter((a: { rule: string }) => a.rule === 'same_pair');
      // ENG-AGENTS: Shira is the only budget owner who could decide; one approver there is no pattern.
      await decideAll('ENG-AGENTS');
      await services.anomalies.scanApprovals();
      expect((await pairsNow()).filter((a: { key: string }) => a.key.endsWith(':budget_owner'))).toEqual([]);
      // ENG-PLATFORM: Shira owns it and Roni deputises, so two could decide.
      await services.owners.set(
        'ENG-PLATFORM',
        { owner: { email: people.shira.email }, deputies: [{ email: people.roni.email }] } as never,
        principal('dana'),
      );
      await decideAll('ENG-PLATFORM');
      await services.anomalies.scanApprovals();
      const pairs = (await as('avi', 'GET', '/api/anomalies?kind=approval'))
        .json()
        .anomalies.filter((a: { rule: string }) => a.rule === 'same_pair');
      const owner = pairs.find((a: { key: string }) => a.key === `${userId.shira}:${userId.tal}:budget_owner`);
      expect(owner).toMatchObject({ dimension: 'approver', windowStart: '2026-10-01T00:00:00.000Z' });
      expect(owner.summary).toMatch(/Shira Navon made 5 of the 5 budget_owner decisions on Tal Levi's requests/);
      expect(owner.named.sort()).toEqual([userId.shira, userId.tal].sort());
      // Scanning again (a later hour) raises nothing new: the key and the quarter are stable.
      now = new Date('2026-11-16T13:00:00Z');
      try {
        expect(await services.anomalies.scanApprovals()).toBe(0);
      } finally {
        now = NOV_16;
      }
    });

    it('takes a dev spike only when LANDLEDGER_DEV_ANOMALY=on, flags it, and reverses it with nothing in the ledger', async () => {
      const opts = { amount: '25', day: '2026-11-16', startedBy: 'test' };
      await expect(devSpike(sql, services.audit, { ...opts, enabled: false, postgresUrl: db.appUrl })).rejects.toThrow(
        /LANDLEDGER_DEV_ANOMALY/,
      );
      await expect(
        devReverse(sql, services.audit, { enabled: false, startedBy: 'test', postgresUrl: db.appUrl }),
      ).rejects.toThrow(/off/);
      const before = await total('2026-11');
      await devSpike(sql, services.audit, { ...opts, enabled: true, postgresUrl: db.appUrl });
      // B4: the spike is never in a total; only the anomaly scan sees it, and flags what it finds as dev only.
      expect((await total('2026-11')).toString()).toBe(before.toString());
      await services.anomalies.scanCost('2026-11-16');
      const list = (await as('avi', 'GET', '/api/anomalies?kind=cost')).json().anomalies;
      const spike = list.find(
        (a: { dimension: string; key: string }) => a.dimension === 'service' && a.key === DEV_SPIKE_SERVICE,
      );
      expect(spike).toMatchObject({ observed: '25.000000' });
      const [stored] = await sql`SELECT details FROM anomalies WHERE id = ${spike.id}`;
      expect(stored!.details).toMatchObject({ sources: ['dev-anomaly'], devOnly: true });
      expect(
        await devReverse(sql, services.audit, { enabled: true, startedBy: 'test', postgresUrl: db.appUrl }),
      ).toEqual({
        removed: 1,
        ledger: 0,
      });
      expect((await total('2026-11')).toString()).toBe(before.toString());
      const [{ n }] = (await sql`
        SELECT count(*)::int AS n FROM cost_records WHERE source = 'dev-anomaly'`) as unknown as [{ n: number }];
      expect(n).toBe(0);
      // Should-fix 11: left alone, the hourly scan takes it out two hours on; and never against a remote database.
      await devSpike(sql, services.audit, { ...opts, enabled: true, postgresUrl: db.appUrl });
      await expect(
        devSpike(sql, services.audit, { ...opts, enabled: true, postgresUrl: 'postgres://u:p@db.example.com:5432/x' }),
      ).rejects.toThrow(/this machine|loopback|localhost/i);
      now = new Date(NOV_16.getTime() + 3 * 3_600_000);
      try {
        await services.anomalies.scan({ days: [] });
      } finally {
        now = NOV_16;
      }
      const [{ left }] = (await sql`
        SELECT count(*)::int AS left FROM provisional_usage WHERE source = 'dev-anomaly'`) as unknown as [
        { left: number },
      ];
      expect(left).toBe(0);
      const [exp] = await sql`SELECT actor_kind FROM audit_log WHERE action = 'dev_anomaly.expired'`;
      expect(exp).toMatchObject({ actor_kind: 'system' });
    });
  });
  // 008 Agents ---------------------------------------------------------------------------------------------------------

  describe("agents' unit economics (spec 008)", () => {
    const report = {
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-16T10:00:00.000Z',
      currency: 'USD',
      hourlyRate: 60,
      agents: [
        {
          key: 'landflow-host/Triage lead',
          name: 'Triage lead',
          service: 'landflow-host',
          family: 'landflow',
          value: 600,
          cost: 1.5,
          outcomes: 12,
          adoption: { runs: 12 },
          quality: { successRate: 1 },
        },
        {
          key: 'landflow-host/Night digest',
          name: 'Night digest',
          service: 'landflow-host',
          family: 'landflow',
          value: 0,
          cost: 0,
          outcomes: 0,
          adoption: { runs: 14 },
          quality: { successRate: 1 },
        },
        {
          key: 'demo-landflow-host/Support triage',
          name: 'Support triage',
          service: 'demo-landflow-host',
          value: 25,
          outcomes: 5,
          adoption: { runs: 5 },
          quality: { successRate: 1 },
        },
      ],
    };
    const asked: string[] = [];
    const clickland: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response(JSON.stringify(report), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const withValue = () =>
      new Agents(
        services.spend,
        new AgentValueClient('http://clickland.test', 'ck_test', clickland),
        'landflow-host',
        () => now,
      );

    it('shows each agent’s month: ledger cost, Clickland’s outcomes, cost per outcome, capacity, owner and a suggestion', async () => {
      const v = await withValue().view('2026-11');
      expect(asked[0]).toMatch(
        /^http:\/\/clickland\.test\/api\/agents\/value\?from=2026-11-01T00%3A00%3A00\.000Z&to=2026-11-16T10/,
      );
      expect(v.clickland).toMatchObject({ status: 'ok', hourlyRate: '60.00' });
      const lead = v.agents.find((a) => a.id === 'ag_1')!;
      expect(lead).toMatchObject({
        name: 'Triage lead',
        value: { runs: 12, outcomes: 12, value: '600.000000', hoursSaved: '10.00' },
      });
      const cost = usd(lead.cost.total);
      expect(cost.isZero()).toBe(false);
      expect(lead.cost.models).toBe(lead.cost.total);
      expect(lead.cost.compute).toBeNull(); // not attributable, said rather than zero
      expect(lead.costPerOutcome).toBe(
        Money.fromDecimal(cost.toDecimal().divide('12', 6, 'halfEven'), 'USD')
          .toDecimal()
          .toFixed(6, 'halfEven'),
      );
      expect(lead.valuePerOutcome).toBe('50.000000');
      expect(lead.suggestion).toBe('scale');
      expect(lead.why).toMatch(/rule: 10 or more outcomes, value ≥ 5 × cost/);
      expect(lead.costCenter).not.toBeNull();
      // Only Clickland knows the night digest: no cost here, 14 runs and no outcome.
      const digest = v.agents.find((a) => a.name === 'Night digest')!;
      // Should-fix 14: no outcome and not instrumented is "Outcomes not measured", never Retire; nor under $10 a month.
      expect(digest).toMatchObject({
        id: 'landflow-host/Night digest',
        suggestion: 'not_measured',
        measured: false,
        costPerOutcome: null,
        cost: { total: '0.000000' },
      });
      expect(digest.why).toMatch(/Outcomes not measured/);
      expect(lead).toMatchObject({ measured: true, value: { outcomesSource: 'self-reported' } });
      // Demo services aren't Landflow's.
      expect(v.agents.find((a) => a.name === 'Support triage')).toBeUndefined();
      expect(v.totals.outcomes).toBe(12);
      expect(v.computeNote).toMatch(/not attributed/);
    });

    it('says so without a key or when Clickland is down, and still shows the cost', async () => {
      const res = await as('avi', 'GET', '/api/agents?month=2026-11');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().clickland.status).toBe('unconfigured');
      expect(res.json().agents.find((a: { id: string }) => a.id === 'ag_1').value).toBeNull();
      const down = new Agents(
        services.spend,
        new AgentValueClient('http://clickland.test', 'ck_test', async () => new Response('no', { status: 502 })),
        'landflow-host',
        () => now,
      );
      const v = await down.view('2026-11');
      expect(v.clickland).toMatchObject({ status: 'unavailable', note: expect.stringMatching(/answered 502/) });
      expect(v.agents.find((a) => a.id === 'ag_1')!.suggestion).toBe('keep');
    });

    it('shows an AI budget request’s agent cost per outcome, and what the raise buys at that rate', async () => {
      const agents = withValue();
      services.requests.agentEconomics = (id, month, monthly) => agents.economics(id, month, monthly);
      try {
        const writeKey = (
          await services.keys.create(
            { name: 'landflow requests', scopes: ['read', 'requests:write'] },
            principal('dana'),
          )
        ).key;
        const res = await app.inject({
          method: 'POST',
          url: '/api/requests',
          headers: { authorization: `Bearer ${writeKey}` },
          payload: {
            kind: 'ai_budget',
            title: 'More tokens for the triage lead',
            costCenter: 'ENG-AGENTS',
            amount: { amount: '120.00', currency: 'USD' },
            recurrence: 'monthly',
            start: '2026-11-16',
            origin: { type: 'landflow_run', workflowId: 'wf_triage', executionId: 'ex_8' },
            requester: {
              kind: 'agent',
              agent: { id: 'ag_1', name: 'Triage lead' },
              sponsor: { email: people.tal.email },
            },
          },
        });
        expect(res.statusCode, res.body).toBe(201);
        const shown = (await as('shira', 'GET', `/api/requests/${res.json().request.id}`)).json();
        const e = shown.evidence.agentEconomics;
        expect(e).toMatchObject({
          agentId: 'ag_1',
          name: 'Triage lead',
          month: '2026-11',
          outcomes: 12,
          suggestion: 'scale',
        });
        expect(e.buys).toBe(Money.parse('120', 'USD').toDecimal().divide(e.costPerOutcome, 1, 'halfEven').toString());
      } finally {
        services.requests.agentEconomics = (id, month, monthly) => services.agents.economics(id, month, monthly);
      }
    });
  });
  // 009 Contracts and 010 seats ------------------------------------------------------------------------------------------

  describe('contracts and seats (specs 009, 010)', () => {
    const contractsCsv = readFileSync(new URL('../fixtures/contracts/contracts-2026.dev.csv', import.meta.url), 'utf8');
    const outbox = async (type: string) =>
      (
        await sql<{ data: Record<string, unknown> }[]>`
          SELECT payload->'data' AS data FROM outbox WHERE event_type = ${type} ORDER BY created_at, id`
      ).map((r) => r.data);
    /** People approve each pending step in turn, each on the evidence they were shown. */
    const approveThrough = async (id: string) => {
      for (let i = 0; i < 5; i++) {
        const shown = (await as('dana', 'GET', `/api/requests/${id}`)).json();
        if (shown.request.status !== 'pending') return shown.request;
        const step = shown.request.steps.find((x: { status: string }) => x.status === 'pending');
        const emails: string[] = step.approvers.people.map((p: { email: string }) => p.email);
        const who = (Object.keys(people) as Who[]).find((w) => w !== 'tal' && emails.includes(people[w].email))!;
        const mine = (await as(who, 'GET', `/api/requests/${id}`)).json();
        const res = await as(who, 'POST', `/api/requests/${id}/decisions`, {
          outcome: 'approve',
          evidenceSha256: mine.evidenceSha256,
          step: mine.request.currentStep,
        });
        expect(res.statusCode, res.body).toBe(201);
      }
      return (await as('dana', 'GET', `/api/requests/${id}`)).json().request;
    };
    let linear = '';

    it('imports contracts by a controller, renewals inside the notice window first; a key, an auditor and EUR are refused', async () => {
      await services.webhooks.create(
        {
          url: 'https://receiver.test/hook',
          events: ['contract.renewal_due', 'request.decided'],
          description: 'test',
        } as never,
        principal('dana'),
      );
      expect((await as('avi', 'POST', '/api/contracts/import', { csv: contractsCsv })).statusCode).toBe(403);
      const key = await app.inject({
        method: 'POST',
        url: '/api/contracts/import',
        headers: { authorization: `Bearer ${readKey}` },
        payload: { csv: contractsCsv },
      });
      expect(key.statusCode).toBe(403);
      const eur = await as('yoav', 'POST', '/api/contracts/import', {
        csv: contractsCsv.replace(',USD,2026-06-01', ',EUR,2026-06-01'),
      });
      expect(eur.statusCode).toBe(422);
      // B4: a dev fixture is for a dev API only (this one is not).
      const dev = await as('yoav', 'POST', '/api/contracts/import', { csv: contractsCsv, origin: 'dev-fixture' });
      expect(dev.statusCode).toBe(403);
      const res = await as('yoav', 'POST', '/api/contracts/import', { csv: contractsCsv });
      expect(res.statusCode, res.body).toBe(201);
      const list = res.json();
      expect(
        list.contracts.map((c: { vendor: string; inNoticeWindow: boolean }) => [c.vendor, c.inNoticeWindow]),
      ).toEqual([
        ['Linear', true],
        ['Notion', false],
      ]);
      const l = list.contracts[0];
      linear = l.id;
      expect(l).toMatchObject({
        version: 1,
        annualValue: '9600.000000',
        seats: { paid: 40, used: 34, reserved: 0, left: 6 },
        seatPrice: '20.000000',
        noticeDate: '2026-12-02',
        noticeCalendarDate: '2026-12-02',
        daysToNotice: 16,
        origin: 'entered',
        covered: false,
        importedBy: people.yoav.email,
      });
      // Imported again: a new version, the same contract.
      const again = (await as('yoav', 'POST', '/api/contracts/import', { csv: contractsCsv })).json();
      expect(again.contracts[0]).toMatchObject({ id: linear, version: 2 });
      expect(again.held).toEqual([]);
      // Should-fix 2: contracts are in the forecast, annual value ÷ 12 a month over the term (Linear ends in December).
      const f = (await as('avi', 'GET', '/api/forecast?months=3')).json();
      const byM = Object.fromEntries(
        f.months.map((m: { month: string; contracted: string }) => [m.month, m.contracted]),
      );
      expect(byM).toMatchObject({ '2026-12': '1200.000000', '2027-01': '400.000000' });
      // From tomorrow in the current month: 14 of November's 30 days.
      expect(byM['2026-11']).toBe('560.000000');
      expect((await services.spend.overview('2026-11')).forecast.contracted).toBe('560.000000');
      // Should-fix 6: under the line, an entered contract no approved request covers is on the exceptions report.
      const ex = (await as('avi', 'GET', '/api/exceptions?month=2026-11')).json();
      expect(ex.contracts.map((c: { vendor: string }) => c.vendor).sort()).toEqual(['Linear', 'Notion']);
      expect(await services.contracts.renewalAlerts()).toBe(1);
      expect(await services.contracts.renewalAlerts()).toBe(0);
      const due = await outbox('contract.renewal_due');
      expect(due.map((d) => (d.contract as { vendor: string }).vendor)).toEqual(['Linear']);
    });

    it('holds a new contract or a TCV raise above $25,000 for a second person, and enters nothing (should-fix 6)', async () => {
      const header = contractsCsv.split('\n')[0]!;
      const csv = [
        header,
        'Snowflake,Enterprise,ENG-PLATFORM,60000.00,USD,2026-12-01,2027-11-30,,,2027-12-01,60,false,',
        'Linear,Business,ENG-PRODUCT,36000.00,USD,2026-01-01,2026-12-31,40,34,2027-01-01,30,true,linear',
      ].join('\n');
      const before = (await services.contracts.list()).contracts.map((c) => [c.vendor, c.version, c.tcv]);
      const res = await as('yoav', 'POST', '/api/contracts/import', { csv, fileName: 'big.csv' });
      expect(res.statusCode, res.body).toBe(201);
      const v = res.json();
      expect(
        v.contracts.map((c: { vendor: string; version: number; tcv: string }) => [c.vendor, c.version, c.tcv]),
      ).toEqual(before);
      expect(v.held).toHaveLength(2);
      const [snow, lin] = v.held;
      expect(snow).toMatchObject({ vendor: 'Snowflake', tcv: '60000.000000', previousTcv: null, status: 'pending' });
      expect(lin).toMatchObject({ vendor: 'Linear', tcv: '36000.000000', previousTcv: '9600.000000' });
      const req = (await as('dana', 'GET', `/api/requests/${snow.requestId}`)).json().request;
      expect(req).toMatchObject({
        kind: 'contract',
        origin: { type: 'contract_import', fileName: 'big.csv', line: 2 },
      });
      expect(req.steps.map((s: { key: string }) => s.key)).toEqual(['budget_owner', 'finance', 'cfo']);
      // The importer can't be its second person, and a caller can't claim the import origin.
      const forged = await as('tal', 'POST', '/api/requests', {
        kind: 'contract',
        title: 'Forged',
        costCenter: 'ENG-PLATFORM',
        recurrence: 'once',
        amount: { amount: '30000', currency: 'USD' },
        contract: { vendor: 'X', product: 'Y', tcv: '30000', termMonths: 12, start: '2026-12-01' },
        origin: { type: 'contract_import', line: 2 },
      });
      expect(forged.statusCode).toBe(400);
      const [audit] = await sql`SELECT actor FROM audit_log WHERE action = 'contract.import_held' LIMIT 1`;
      expect(audit).toMatchObject({ actor: people.yoav.email });
      // Withdrawn here so the seats below read the 9,600 contract (the people decide it, not the test).
      for (const h of v.held)
        expect(
          (await as('yoav', 'POST', `/api/requests/${h.requestId}/cancel`, { reason: 'test: not deciding it here' }))
            .statusCode,
        ).toBe(200);
      expect((await services.contracts.list()).held).toEqual([]);
    });

    it('gives Landflow a Landbright app’s contract, its seat price and seats left', async () => {
      const res = await as('avi', 'GET', '/api/contracts/seats?landbrightApp=linear');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ seatPrice: '20.000000', left: 6, contract: { id: linear } });
      expect((await as('avi', 'GET', '/api/contracts/seats?landbrightApp=figma')).statusCode).toBe(404);
    });

    it('reserves a seat at approval, moves it to used when applied, and says what is left', async () => {
      const body = {
        kind: 'tool_or_seat',
        title: 'Linear seat for Tal',
        costCenter: 'ENG-PRODUCT',
        recurrence: 'monthly',
        start: '2026-11-16',
        seat: { contractId: linear, seats: 1, seatPrice: '20' },
      };
      const wrong = await as('tal', 'POST', '/api/requests', { ...body, amount: { amount: '25.00', currency: 'USD' } });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error.message).toMatch(/seats × seat price a month: 1 × 20 = 20\.000000/);
      const res = await as('tal', 'POST', '/api/requests', { ...body, amount: { amount: '20.00', currency: 'USD' } });
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json().request.id;
      const shown = (await as('shira', 'GET', `/api/requests/${id}`)).json();
      expect(shown.evidence.seat).toMatchObject({
        paid: 40,
        used: 34,
        reserved: 0,
        leftNow: 6,
        leftAfter: 5,
        note: null,
      });
      const r = await approveThrough(id);
      expect(r.status).toBe('approved');
      expect(r.seat).toMatchObject({ contractId: linear, seats: 1, status: 'reserved', vendor: 'Linear' });
      const decided = (await outbox('request.decided')).find((d) => (d.request as { id: string }).id === id)!;
      expect((decided.request as { seat: { status: string } }).seat.status).toBe('reserved');
      expect((await services.contracts.view(linear)).seats).toMatchObject({ used: 34, reserved: 1, left: 5 });
      const applied = await as('tal', 'POST', `/api/requests/${id}/applied`, { note: 'Landbright granted' });
      expect(applied.statusCode, applied.body).toBe(200);
      expect(applied.json().request.seat.status).toBe('applied');
      expect((await services.contracts.view(linear)).seats).toMatchObject({ used: 35, reserved: 0, left: 5 });
    });

    it("refuses a seat below the contract's price, and never approves a seat no contract has left (should-fix 4)", async () => {
      const seat = (contractId: string, seatPrice: string, amt: string, title = 'A seat') => ({
        kind: 'tool_or_seat',
        title,
        costCenter: 'ENG-PRODUCT',
        recurrence: 'monthly',
        start: '2026-11-16',
        amount: { amount: amt, currency: 'USD' },
        seat: { contractId, seats: 1, seatPrice },
      });
      // A cost center's own policy that does approve seats automatically under $500 (the default never does).
      const owner = postgres(db.url, { max: 1, onnotice: () => {} });
      try {
        await owner`
          INSERT INTO policies (id, kind, cost_center, version, definition, note, origin, status, proposed_by, approved_at)
          VALUES ('pol_seat_rnd', 'tool_or_seat', 'RND-DATA', 1,
                  ${owner.json({
                    automaticBelow: '500',
                    steps: [
                      {
                        key: 'budget_owner',
                        label: 'Budget owner',
                        approvers: { groups: ['Budget Owners'], costCenterOwner: true },
                        when: { amountAtLeast: '500' },
                      },
                    ],
                  } as never)},
                  'test: seats under $500 are automatic on RND-DATA', 'decision', 'approved', ${userId.dana}, now())`;
      } finally {
        await owner.end();
      }
      const cheap = await as('tal', 'POST', '/api/requests', seat(linear, '0.01', '0.01'));
      expect(cheap.statusCode).toBe(400);
      expect(cheap.json().error.message).toMatch(/costs 20\.000000 a month .*not less/);
      // A full contract: 10 paid, 10 used. $20 is under the automatic threshold, but a person decides it.
      const header = contractsCsv.split('\n')[0]!;
      const full = await as('yoav', 'POST', '/api/contracts/import', {
        csv: `${header}\nFigma,Organization,ENG-PRODUCT,2400.00,USD,2026-01-01,2026-12-31,10,10,2027-01-01,30,true,figma`,
      });
      expect(full.statusCode, full.body).toBe(201);
      const figma = full.json().contracts.find((c: { vendor: string }) => c.vendor === 'Figma');
      const onRnd = (b: ReturnType<typeof seat>) => ({ ...b, costCenter: 'RND-DATA' });
      // With a seat left, the policy approves it; with none, a person decides, whatever the amount.
      const left = await as(
        'tal',
        'POST',
        '/api/requests',
        onRnd(seat(linear, '20', '20.00', 'Linear seat, automatic')),
      );
      expect(left.statusCode, left.body).toBe(201);
      expect(left.json().request).toMatchObject({ automatic: true, status: 'approved' });
      const back = await as('tal', 'POST', `/api/requests/${left.json().request.id}/seats/release`, {
        reason: 'not_needed',
      });
      expect(back.statusCode, back.body).toBe(200);
      const res = await as('tal', 'POST', '/api/requests', onRnd(seat(figma.id, '20', '20.00', 'Figma seat')));
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().request).toMatchObject({ automatic: false, status: 'pending' });
      expect(res.json().request.policy.reason).toMatch(/beyond the contract|No seat is left/);
      expect(
        (await as('tal', 'POST', `/api/requests/${res.json().request.id}/cancel`, { reason: 'test' })).statusCode,
      ).toBe(200);
    });

    it('releases a seat on a release call, expires one unapplied after 30 days, and counts seats as of the file (should-fix 5)', async () => {
      const ask = async (title: string) => {
        const res = await as('tal', 'POST', '/api/requests', {
          kind: 'tool_or_seat',
          title,
          costCenter: 'ENG-PRODUCT',
          recurrence: 'monthly',
          start: '2026-11-16',
          amount: { amount: '20.00', currency: 'USD' },
          seat: { contractId: linear, seats: 1, seatPrice: '20' },
        });
        expect(res.statusCode, res.body).toBe(201);
        const r = await approveThrough(res.json().request.id);
        expect(r.seat.status).toBe('reserved');
        return r.id as string;
      };
      await services.webhooks.create(
        { url: 'https://receiver.test/seats', events: ['seat.released'], description: 'test' } as never,
        principal('dana'),
      );
      const denied = await ask('Linear seat, denied');
      expect((await services.contracts.view(linear)).seats).toMatchObject({ used: 35, reserved: 1, left: 4 });
      const release = `/api/requests/${denied}/seats/release`;
      expect((await as('avi', 'POST', release, { reason: 'access_denied' })).statusCode).toBe(403);
      const ok = await as('tal', 'POST', release, { reason: 'access_denied', note: 'Landbright denied the grant' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().request.seat.status).toBe('released');
      expect((await as('tal', 'POST', release, { reason: 'access_denied' })).statusCode).toBe(409);
      expect((await services.contracts.view(linear)).seats).toMatchObject({ used: 35, reserved: 0, left: 5 });
      const [{ n: live }] = (await sql`
        SELECT count(*)::int AS n FROM reservations WHERE request_id = ${denied} AND status = 'reserved'`) as unknown as [
        { n: number },
      ];
      expect(live).toBe(0);
      expect((await outbox('seat.released')).at(-1)).toMatchObject({
        requestId: denied,
        reason: 'access_denied',
        from: 'reserved',
        seats: 1,
      });
      // Approved and never applied: back to the contract 30 days on.
      const idle = await ask('Linear seat, never applied');
      expect(await services.requests.expireSeats()).toBe(0);
      now = new Date('2026-12-17T10:00:00Z');
      try {
        expect(await services.requests.expireSeats()).toBe(1);
      } finally {
        now = NOV_16;
      }
      const [s] = await sql`SELECT status, close_reason FROM seat_reservations WHERE request_id = ${idle}`;
      expect(s).toMatchObject({ status: 'released', close_reason: 'expired' });
      // Seats used as of a date: the grant applied on 16 November is in a file as of that day, not counted again;
      // in a file as of the 15th, it is.
      const header = `${contractsCsv.split('\n')[0]!},seats_used_as_of`;
      const linearRow = contractsCsv.split('\n')[1]!;
      const asOf = (used: number, d: string) =>
        as('yoav', 'POST', '/api/contracts/import', {
          csv: `${header}\n${linearRow.replace(',40,34,', `,40,${used},`)},${d}`,
        });
      expect((await asOf(35, '2026-11-16')).statusCode).toBe(201);
      expect((await services.contracts.view(linear)).seats).toMatchObject({ used: 35, left: 5 });
      expect((await asOf(34, '2026-11-15')).statusCode).toBe(201);
      expect(await services.contracts.view(linear)).toMatchObject({
        seats: { used: 35, left: 5 },
        seatsUsedAsOf: '2026-11-15',
      });
      expect((await asOf(34, '2026-11-17')).statusCode).toBe(400);
    });

    it('approves a contract for its TCV and term (owner, Finance, CFO above $25,000), reserving seats, not money', async () => {
      const terms = { vendor: 'Datadog', product: 'Pro', tcv: '30000', termMonths: 12, start: '2026-12-01', seats: 10 };
      const base = { kind: 'contract', title: 'Datadog Pro, one year', costCenter: 'ENG-PLATFORM', contract: terms };
      expect(
        (
          await as('tal', 'POST', '/api/requests', {
            ...base,
            recurrence: 'once',
            amount: { amount: '2500', currency: 'USD' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await as('tal', 'POST', '/api/requests', {
            ...base,
            recurrence: 'monthly',
            amount: { amount: '30000', currency: 'USD' },
          })
        ).statusCode,
      ).toBe(400);
      const res = await as('tal', 'POST', '/api/requests', {
        ...base,
        recurrence: 'once',
        amount: { amount: '30000', currency: 'USD' },
      });
      expect(res.statusCode, res.body).toBe(201);
      const created = res.json().request;
      expect(created).toMatchObject({ automatic: false, contract: { vendor: 'Datadog', termMonths: 12 } });
      expect(created.steps.map((s: { key: string }) => s.key)).toEqual(['budget_owner', 'finance', 'cfo']);
      const r = await approveThrough(created.id);
      expect(r.status).toBe('approved');
      const [{ n }] =
        (await sql`SELECT count(*)::int AS n FROM reservations WHERE request_id = ${created.id}`) as unknown as [
          { n: number },
        ];
      expect(n).toBe(0);
      const dd = (await services.contracts.list()).contracts.find((c) => c.vendor === 'Datadog')!;
      expect(dd).toMatchObject({
        origin: 'request',
        requestId: created.id,
        tcv: '30000.000000',
        termStart: '2026-12-01',
        termEnd: '2027-11-30',
        renewalDate: '2027-12-01',
        seats: { paid: 10, used: 0, reserved: 0, left: 10 },
      });
    });
  });

  describe('contract notices (should-fix 15)', () => {
    const sent = async (type: string) =>
      (
        await sql<{ vendor: string }[]>`
          SELECT payload->'data'->'contract'->>'vendor' AS vendor FROM outbox WHERE event_type = ${type}
          ORDER BY created_at, id`
      ).map((r) => r.vendor);
    const at = async (iso: string) => {
      now = new Date(iso);
      try {
        return await services.contracts.renewalAlerts();
      } finally {
        now = NOV_16;
      }
    };

    it('reminds a week and a day before the notice date, and says when it was missed', async () => {
      await services.webhooks.create(
        {
          url: 'https://receiver.test/notices',
          events: ['contract.notice_reminder', 'contract.notice_missed'],
          description: 'test',
        } as never,
        principal('dana'),
      );
      // Linear and Figma: renewal 1 January, 30 days' notice: 2 December, a Wednesday.
      await at('2026-11-25T10:00:00Z');
      expect((await sent('contract.notice_reminder')).sort()).toEqual(['Figma', 'Linear']);
      expect(await at('2026-11-26T10:00:00Z')).toBe(0);
      await at('2026-12-01T10:00:00Z');
      expect((await sent('contract.notice_reminder')).sort()).toEqual(['Figma', 'Figma', 'Linear', 'Linear']);
      // The day after, with no contracts file since: missed, once.
      await at('2026-12-03T10:00:00Z');
      expect((await sent('contract.notice_missed')).sort()).toEqual(['Figma', 'Linear']);
      expect(await at('2026-12-04T10:00:00Z')).toBe(0);
    });
  });

  // 011 Access review --------------------------------------------------------------------------------------------------

  describe('access review (spec 011)', () => {
    let reviewId = '';
    type Item = { id: string; kind: string; subjectId: string; label: string; attestation: unknown };

    it('sends access_review.due once for the quarter, before any review', async () => {
      await services.webhooks.create(
        { url: 'https://receiver.test/hook', events: ['access_review.due'], description: 'test' } as never,
        principal('dana'),
      );
      expect(await services.accessReviews.dueNotice()).toBe(true);
      expect(await services.accessReviews.dueNotice()).toBe(false);
      const due = await sql<{ data: { quarter: string; reviewId: string | null; url: string } }[]>`
        SELECT payload->'data' AS data FROM outbox WHERE event_type = 'access_review.due'`;
      expect(due.map((d) => d.data)).toEqual([
        { quarter: '2026-Q4', reviewId: null, url: expect.stringMatching(/\/access-review$/) },
      ]);
      const listed = await as('avi', 'GET', '/api/access-reviews');
      expect(listed.json()).toMatchObject({ quarter: '2026-Q4', due: true, reviews: [] });
    });

    it('is opened by the controller or the CFO only, once a quarter, with every holder of access', async () => {
      expect((await as('tal', 'POST', '/api/access-reviews')).statusCode).toBe(403);
      expect((await as('avi', 'POST', '/api/access-reviews')).statusCode).toBe(403);
      const key = await app.inject({
        method: 'POST',
        url: '/api/access-reviews',
        headers: { authorization: `Bearer ${readKey}` },
      });
      expect(key.statusCode).toBe(403);
      await services.owners.set(
        'ENG-AGENTS',
        { owner: { email: people.shira.email }, deputies: [{ email: people.roni.email }] } as never,
        principal('dana'),
      );
      await services.links.create(
        { kind: 'slack', externalId: 'U_SHIRA' },
        { ...principal('shira'), sessionId: 'test' },
      );
      await services.relayChannels.create(
        { kind: 'slack', name: 'Finance approvals', signingSecret: 'x'.repeat(32), teamId: 'T_DEV', appId: 'A_DEV' },
        principal('yoav'),
      );
      const res = await as('yoav', 'POST', '/api/access-reviews');
      expect(res.statusCode, res.body).toBe(201);
      const v = res.json();
      reviewId = v.id;
      expect(v).toMatchObject({ quarter: '2026-Q4', status: 'open', openedBy: 'Yoav Ben David' });
      const kinds = new Set(v.items.map((i: Item) => i.kind));
      // Webhooks too (should-fix 9); sessions when someone is signed in (the test's sessions expired on its clock).
      expect([...kinds].sort()).toEqual(['key', 'link', 'owner', 'person', 'relay_channel', 'webhook']);
      expect(v.items.find((i: Item) => i.kind === 'webhook')).toMatchObject({ cfoOnly: false, addedAt: null });
      const labels = v.items.map((i: Item) => i.label);
      expect(labels).toEqual(expect.arrayContaining(['Tal Levi', 'Avi Auditor', 'reader', 'Shira Navon · slack']));
      const reader = v.items.find((i: Item) => i.kind === 'key' && i.label === 'reader');
      expect(reader.detail).toMatch(/read, admin/);
      expect((await as('dana', 'POST', '/api/access-reviews')).statusCode).toBe(409);
    });

    it('takes keep or revoke per item from another controller or the CFO, audited, and completes on the last', async () => {
      const url = (itemId: string) => `/api/access-reviews/${reviewId}/items/${itemId}/attest`;
      const v = (await as('avi', 'GET', `/api/access-reviews/${reviewId}`)).json();
      const items: Item[] = v.items;
      const item = (kind: string, label: string) => items.find((i) => i.kind === kind && i.label === label)!;
      // Nobody attests their own: Yoav's person row, Dana's key, Shira's link, Yoav's relay channel.
      expect(
        (await as('yoav', 'POST', url(item('person', 'Yoav Ben David').id), { decision: 'keep' })).statusCode,
      ).toBe(403);
      expect((await as('dana', 'POST', url(item('key', 'reader').id), { decision: 'keep' })).statusCode).toBe(403);
      expect(
        (await as('yoav', 'POST', url(item('relay_channel', 'Finance approvals').id), { decision: 'keep' })).statusCode,
      ).toBe(403);
      // An auditor reads and never attests; a key never does; revoking needs a reason.
      expect((await as('avi', 'POST', url(item('person', 'Tal Levi').id), { decision: 'keep' })).statusCode).toBe(403);
      expect((await as('shira', 'POST', url(item('person', 'Tal Levi').id), { decision: 'keep' })).statusCode).toBe(
        403,
      );
      const key = await app.inject({
        method: 'POST',
        url: url(item('person', 'Tal Levi').id),
        headers: { authorization: `Bearer ${readKey}` },
        payload: { decision: 'keep' },
      });
      expect(key.statusCode).toBe(403);
      expect((await as('yoav', 'POST', url(item('key', 'reader').id), { decision: 'revoke' })).statusCode).toBe(400);
      // Should-fix 9: a key's revoke ends it now, so the attester confirms it first.
      const unconfirmed = await as('yoav', 'POST', url(item('key', 'reader').id), {
        decision: 'revoke',
        comment: 'A test key with admin: revoke it',
      });
      expect(unconfirmed.statusCode).toBe(400);
      expect(unconfirmed.json().error.message).toMatch(/confirm/);
      const revoked = await as('yoav', 'POST', url(item('key', 'reader').id), {
        decision: 'revoke',
        comment: 'A test key with admin: revoke it',
        confirm: true,
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      const [k] = await sql`SELECT revoked_at FROM api_keys WHERE name = 'reader'`;
      expect(k!.revoked_at).not.toBeNull();
      expect(
        (revoked.json().items as (Item & { revocation: unknown; outstanding: boolean })[]).find(
          (i) => i.id === item('key', 'reader').id,
        ),
      ).toMatchObject({ outstanding: false, revocation: { how: expect.stringMatching(/revoked/) } });
      const gone = await app.inject({
        method: 'GET',
        url: '/api/overview',
        headers: { authorization: `Bearer ${readKey}` },
      });
      expect(gone.statusCode).toBe(401);
      expect(
        (await as('roni', 'POST', url(item('key', 'reader').id), { decision: 'keep' })).statusCode,
        'attested once',
      ).toBe(409);
      // A revoke Landledger can't do itself (a cost center's owners) is outstanding until the access is gone.
      const owner = item('owner', 'ENG-AGENTS');
      const r2 = await as('yoav', 'POST', url(owner.id), { decision: 'revoke', comment: 'Roni no longer deputises' });
      expect(r2.statusCode, r2.body).toBe(200);
      expect(r2.json().counts).toMatchObject({ outstanding: 1 });
      // Granted after the review opened: joins it (should-fix 9).
      await services.keys.create({ name: 'late key', scopes: ['read'] }, principal('dana'));
      const synced = (await as('avi', 'GET', `/api/access-reviews/${reviewId}`)).json();
      const late = synced.items.find((i: Item) => i.kind === 'key' && i.label === 'late key');
      expect(late).toMatchObject({ addedAt: expect.any(String) });
      expect(synced.counts).toMatchObject({ added: 1 });
      // The rest, each by someone it is not about.
      let last: {
        status: string;
        counts: { total: number; attested: number; revoke: number; outstanding: number };
      } | null = null;
      for (const i of synced.items as Item[]) {
        if ((i.kind === 'key' && i.label === 'reader') || i.id === owner.id) continue;
        for (const who of ['yoav', 'roni', 'dana'] as const) {
          const res = await as(who, 'POST', url(i.id), { decision: 'keep' });
          if (res.statusCode === 403) continue;
          expect(res.statusCode, res.body).toBe(200);
          last = res.json();
          break;
        }
      }
      const total = synced.items.length;
      // Every item attested, but a revoke is outstanding: the review stays open.
      expect(last).toMatchObject({ status: 'open', counts: { total, attested: total, revoke: 2, outstanding: 1 } });
      // The owners map changes (by Dana, in the console); the next read sees the access gone and completes the review.
      await services.owners.set(
        'ENG-AGENTS',
        { owner: { email: people.shira.email }, deputies: [] } as never,
        principal('dana'),
      );
      const done = (await as('avi', 'GET', `/api/access-reviews/${reviewId}`)).json();
      expect(done).toMatchObject({
        status: 'completed',
        counts: { total, attested: total, revoke: 2, outstanding: 0 },
      });
      const audit = await sql<{ action: string; actor: string }[]>`
        SELECT action, actor FROM audit_log WHERE subject_id = ${reviewId} ORDER BY seq`;
      expect(audit[0]).toMatchObject({ action: 'access_review.opened', actor: people.yoav.email });
      expect(audit.filter((a) => a.action === 'access_review.attested')).toHaveLength(total);
      expect(audit.at(-1)!.action).toBe('access_review.completed');
      expect((await as('dana', 'POST', url(item('person', 'Tal Levi').id), { decision: 'keep' })).statusCode).toBe(409);
      expect((await as('avi', 'GET', '/api/access-reviews')).json()).toMatchObject({ due: false });
      // Attestations are append only, in the database too.
      await expect(
        sql`UPDATE access_review_attestations SET decision = 'revoke' WHERE item_id = ${items[0]!.id}`,
      ).rejects.toThrow();
    });

    it('reminds weekly, records a missed quarter, and leaves a key no person minted to the CFO (should-fix 9)', async () => {
      const due = async () =>
        (
          await sql<{ data: { quarter: string; reminder?: boolean; missed?: boolean } }[]>`
            SELECT payload->'data' AS data FROM outbox WHERE event_type IN ('access_review.due', 'access_review.missed')
            ORDER BY created_at, id`
        ).map((d) => d.data);
      const at = async <T>(iso: string, f: () => Promise<T>) => {
        now = new Date(iso);
        try {
          return await f();
        } finally {
          now = NOV_16;
        }
      };
      await services.webhooks.create(
        { url: 'https://receiver.test/review', events: ['access_review.missed'], description: 'test' } as never,
        principal('dana'),
      );
      // A key the CLI minted: nobody's own, so only the CFO attests it.
      const owner = postgres(db.url, { max: 1, onnotice: () => {} });
      try {
        await owner`
          INSERT INTO api_keys (id, name, prefix, hash, scopes, created_by)
          VALUES ('key_cli_test', 'cli key', 'llk_cli', ${'c'.repeat(64)}, ARRAY['read'], 'cli')`;
        // Tal, signed in on 2 January (its id is a stored hash; the value is never a cookie here).
        await owner`
          INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
          VALUES (${'s'.repeat(64)}, ${userId.tal}, '2027-01-02T08:00:00Z', '2027-02-02T08:00:00Z', '2027-01-02T08:00:00Z')`;
      } finally {
        await owner.end();
      }
      const before = (await due()).length;
      expect(await at('2027-01-05T08:00:00Z', () => services.accessReviews.dueNotice())).toBe(true);
      expect(await at('2027-01-08T08:00:00Z', () => services.accessReviews.dueNotice())).toBe(false);
      expect(await at('2027-01-12T08:00:00Z', () => services.accessReviews.dueNotice())).toBe(true);
      expect((await due()).slice(before)).toEqual([
        expect.objectContaining({ quarter: '2027-Q1' }),
        expect.objectContaining({ quarter: '2027-Q1', reminder: true }),
      ]);
      const opened = await at('2027-01-12T09:00:00Z', () => as('roni', 'POST', '/api/access-reviews'));
      expect(opened.statusCode, opened.body).toBe(201);
      const cli = opened.json().items.find((i: { label: string }) => i.label === 'cli key');
      expect(cli).toMatchObject({ cfoOnly: true });
      const url = `/api/access-reviews/${opened.json().id}/items/${cli.id}/attest`;
      expect((await at('2027-01-12T09:00:00Z', () => as('yoav', 'POST', url, { decision: 'keep' }))).statusCode).toBe(
        403,
      );
      expect((await at('2027-01-12T09:00:00Z', () => as('dana', 'POST', url, { decision: 'keep' }))).statusCode).toBe(
        200,
      );
      // A person's sessions are reviewed too, and a confirmed revoke ends them at once.
      const tal = opened.json().items.find((i: { kind: string; label: string }) => i.kind === 'session')!;
      expect(tal).toMatchObject({ label: 'Tal Levi · signed in', subjectId: userId.tal });
      const ended = await at('2027-01-12T09:00:00Z', () =>
        as('yoav', 'POST', `/api/access-reviews/${opened.json().id}/items/${tal.id}/attest`, {
          decision: 'revoke',
          comment: 'Left the team',
          confirm: true,
        }),
      );
      expect(ended.statusCode, ended.body).toBe(200);
      const [sess] =
        await sql`SELECT revoked_at FROM sessions WHERE user_id = ${userId.tal} AND id = ${'s'.repeat(64)}`;
      expect(sess!.revoked_at).not.toBeNull();
      // The quarter ends with the review open: recorded as missed, once.
      await at('2027-04-02T08:00:00Z', () => services.accessReviews.dueNotice());
      await at('2027-04-03T08:00:00Z', () => services.accessReviews.dueNotice());
      expect((await due()).filter((d) => d.missed)).toEqual([
        expect.objectContaining({ quarter: '2027-Q1', missed: true }),
      ]);
      const listed = (await at('2027-04-03T09:00:00Z', () => as('avi', 'GET', '/api/access-reviews'))).json();
      expect(listed.missed).toEqual(['2027-Q1']);
    });
  });
});
