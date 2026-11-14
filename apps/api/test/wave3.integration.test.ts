/**
 * Wave 3 against Postgres (LANDLEDGER_INTEGRATION=db), "Plan and reconcile": invoices posted beside the estimates they
 * replace and reconciled, corrected by reversal and voided whole, a locked month's true-up; the year ahead; anomalies;
 * agents; contracts and seats; the access review. People sign in through a fake Landbright with their groups.
 */
import { readFileSync } from 'node:fs';
import { createTestDatabase, integrationEnabled, type TestDatabase } from '@landledger/schema/testing';
import { Money } from '@landledger/money';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
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
  // Monday 16 November 2026, 10:00 UTC.
  const now = new Date('2026-11-16T10:00:00Z');
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
        origin: 'dev-fixture',
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
      const csv = [
        'provider,invoice_number,period,model,sku,quantity,unit,amount,currency',
        'Anthropic,DEV-ANT-2026-10,2026-10,claude-sonnet-4-5,input-tokens,1000000,Tokens,4.80,USD',
      ].join('\n');
      const res = (await as('yoav', 'POST', '/api/invoices/import', { csv })).json();
      expect(res.invoices[0]).toMatchObject({ correction: true, posted: { added: 1, linkedEstimates: 0 } });
      const [trueUp] = await sql`
        SELECT effective_cost_micros::text AS m, charge_class, charge_period_start, billing_period_start
        FROM cost_records WHERE source_key LIKE 'invoice:anthropic:DEV-ANT-2026-10:trueup:%'`;
      expect(trueUp).toMatchObject({ m: '300000', charge_class: 'Correction' }); // $4.80 − $4.50
      expect(trueUp!.billing_period_start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
      expect((await total('2026-10')).toString()).toBe(octBefore.toString());
      expect((await total('2026-11')).toString()).toBe(novNow.plus(usd('0.3')).toString());
      const oct = (await services.invoices.reconciliation('2026-10')).rows[0]!;
      expect(oct).toMatchObject({ estimated: '4.500000', invoiced: '4.800000', status: 'outside', variancePct: '6.7' });
    });

    it('imports the Ollama fixture at $0: matched against no estimates here, and nothing moves', async () => {
      const before = await total('2026-11');
      const res = (await as('yoav', 'POST', '/api/invoices/import', { csv: fixture('ollama-2026-11.csv') })).json();
      expect(res.invoices[0]).toMatchObject({ provider: 'Ollama', total: '0.000000' });
      expect((await total('2026-11')).toString()).toBe(before.toString());
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
      expect(Number(f.annualised.commitments)).toBeGreaterThanOrEqual(600);
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
      // Overview carries the committed figure and P10 ≤ P50 ≤ P90 when it has a band.
      const ov = (await as('avi', 'GET', '/api/overview?month=2026-11')).json();
      expect(ov.forecast.committed).toBe('0.000000');
      if (ov.forecast.p50) {
        expect(Number(ov.forecast.p10)).toBeLessThanOrEqual(Number(ov.forecast.p50));
        expect(Number(ov.forecast.p50)).toBeLessThanOrEqual(Number(ov.forecast.p90));
        expect(Number(ov.forecast.p10)).toBeGreaterThanOrEqual(Number(ov.monthToDate.total));
      }
      expect((await as('avi', 'GET', '/api/forecast?months=0')).statusCode).toBe(400);
    });
  });
});
