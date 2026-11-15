/**
 * The review of wave 3's money properties, against Postgres (LANDLEDGER_INTEGRATION=db). Random sequences of estimates
 * arriving (before and after an invoice, and after the month locked), invoices imported, re-imported and voided (one or
 * two per provider and month), and the month locking at some point. After every step:
 *
 *  - nothing is double counted: across every month, a provider's figure is what its live invoices bill for each model
 *    they bill, plus every estimate of each model no live invoice bills (B1, B2);
 *  - once the month locks, its own figure never changes again, whatever is imported, re-imported, voided or ingested
 *    later (B3).
 *
 * Each run is one provider in a month of its own (2025 onwards), locked in order; corrections land in the open month.
 * Every fast-check seed runs 18 sequences in a database of its own. `LANDLEDGER_PROPERTY_SEEDS` names the seeds
 * (`1-3000`, `3,451`); unset, one random seed runs. The two classes of sequence the review of wave 4 found (B1) are
 * fixed regression cases below.
 */
import { billingPeriod, type CostRecord, monthStart, nextMonth } from '@landledger/focus';
import { Decimal, Money } from '@landledger/money';
import { createTestDatabase, integrationEnabled, type TestDatabase } from '@landledger/schema/testing';
import fc from 'fast-check';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/db.js';
import type { Principal } from '../src/principal.js';
import { seed } from '../src/seed.js';
import { createServices, type Services } from '../src/services.js';
import { fakeSources, testConfig } from './fakes.js';

const USD = 'USD';
const MODELS = ['m-alpha', 'm-beta'] as const;
const NOW = new Date('2026-12-02T10:00:00Z');
const OPEN = '2026-12';

type Op =
  | { t: 'est'; model: 0 | 1; cents: number; day: number }
  | { t: 'import'; which: 0 | 1; lines: [number | null, number | null]; credit: number | null }
  | { t: 'void'; which: 0 | 1 }
  | { t: 'lock' };

const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('est' as const),
      model: fc.constantFrom(0 as const, 1 as const),
      cents: fc.integer({ min: 1, max: 5000 }),
      day: fc.integer({ min: 1, max: 28 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('import' as const),
      which: fc.constantFrom(0 as const, 1 as const),
      lines: fc.tuple(
        fc.option(fc.integer({ min: 0, max: 9000 }), { nil: null }),
        fc.option(fc.integer({ min: 0, max: 9000 }), { nil: null }),
      ),
      credit: fc.option(fc.integer({ min: 1, max: 500 }), { nil: null }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant('void' as const), which: fc.constantFrom(0 as const, 1 as const) }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('lock' as const) }) },
);

const cents = (n: number) => Money.ofMicros(BigInt(n) * 10_000n, USD);
const dollars = (n: number) => (n / 100).toFixed(2);

/** The seeds to run: `LANDLEDGER_PROPERTY_SEEDS` as a range (`1-3000`) or a list (`3,451`); one random seed if unset. */
function seedsFromEnv(env = process.env.LANDLEDGER_PROPERTY_SEEDS): number[] {
  if (!env?.trim()) return [Math.floor(Math.random() * 2 ** 31)];
  return env.split(',').flatMap((part) => {
    const [a, b] = part.split('-').map((x) => Number(x.trim()));
    if (b === undefined) return [a!];
    return Array.from({ length: b - a! + 1 }, (_, k) => a! + k);
  });
}

const controller: Principal = {
  kind: 'person',
  id: 'usr_prop_controller',
  name: 'Prop Controller',
  email: 'prop.controller@landbright.test',
  roles: ['controller'],
  groups: ['Finance Controllers'],
  scopes: ['read', 'requests:write', 'admin'],
};

/** A migrated, seeded database with services over it, and the helpers every sequence uses. */
async function world() {
  const db: TestDatabase = await createTestDatabase();
  const sql: Sql = createSql(db.appUrl);
  const owner = postgres(db.url, { max: 1, onnotice: () => {} });
  const services: Services = createServices(
    testConfig({ postgresUrl: db.appUrl, devAuth: false }),
    sql,
    fakeSources().fetchImpl,
    undefined,
    () => NOW,
  );
  await seed(sql);
  await owner`
    INSERT INTO users (id, issuer, subject, email, name, roles, groups, kind)
    VALUES (${controller.id}, 'test', 'prop-controller', ${controller.email}, ${controller.name}, ARRAY['controller'],
            ARRAY['Finance Controllers'], 'person')`;
  await owner`
    INSERT INTO ingest_runs (id, source, kind, day, params, started_by, outcome, finished_at)
    VALUES ('run_prop', 'manual', 'manual', '2019-01-01', '{}', 'test', 'succeeded', now())`;
  let seq = 0;

  /** An AI estimate of a provider's model, charged in `month`, booked in `billed` (the open month once it locked). */
  const estimate = async (provider: string, model: string, month: string, billed: string, day: number, amt: Money) => {
    const d = `${month}-${String(day).padStart(2, '0')}`;
    const rec: CostRecord = {
      BilledCost: Money.zero(USD),
      EffectiveCost: amt,
      ListCost: amt,
      ContractedCost: amt,
      ListUnitPrice: null,
      ContractedUnitPrice: null,
      PricingQuantity: null,
      PricingUnit: null,
      ConsumedQuantity: Decimal.parse('1000'),
      ConsumedUnit: 'Tokens',
      BillingCurrency: USD,
      ChargePeriodStart: `${d}T00:00:00Z`,
      ChargePeriodEnd: `${new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`,
      ...billingPeriod(billed),
      ChargeCategory: 'Usage',
      // A late day of a locked month is booked in the open month, as a Correction (as ingest books it).
      ChargeClass: billed === month ? null : 'Correction',
      ChargeDescription: 'property test estimate',
      ChargeFrequency: 'Usage-Based',
      PricingCategory: 'Standard',
      ServiceCategory: 'AI and Machine Learning',
      ServiceSubcategory: 'Generative AI',
      ServiceName: `${provider} API`,
      ServiceProviderName: provider,
      HostProviderName: null,
      InvoiceIssuerName: provider,
      BillingAccountId: `${provider}:estimate`,
      BillingAccountName: null,
      SubAccountId: null,
      SubAccountName: null,
      SubAccountType: null,
      InvoiceId: null,
      ResourceId: null,
      ResourceName: model,
      ResourceType: 'AI Model',
      SkuId: `${provider}:${model}`,
      SkuMeter: null,
      SkuPriceId: `${provider}:${model}:estimate`,
      SkuPriceDetails: null,
      Tags: { provider, model, resource: 'ai' },
      AllocatedMethodId: null,
      AllocatedMethodDetails: null,
      AllocatedResourceId: null,
      AllocatedResourceName: null,
      AllocatedTags: null,
      x_RecordId: `rec_prop_${++seq}`,
      x_Basis: 'estimated',
      x_Source: 'manual',
      x_SourceKey: `prop:${provider}:${seq}`,
      x_SourceCost: amt.toDecimal(),
      x_RateCardVersion: null,
      x_IngestRunId: 'run_prop',
      x_CorrectionOfId: null,
      x_WorkflowId: null,
      x_AgentId: null,
      x_ActorId: null,
      x_OriginalCost: null,
      x_OriginalCurrency: null,
      x_FxRateId: null,
    };
    // As ingest does: entered, then linked `late` when its month and model are invoiced already.
    await sql.begin(async (tx) => {
      await services.records.append([rec], tx);
      await services.invoices.coverLate(tx, [rec]);
    });
  };

  /** A provider's figure: the months it is booked in (its month, or every month to the open one). */
  const figure = async (provider: string, from: string, to: string) => {
    const { lines } = await services.spend.lines({ fromMonth: from, toMonth: to }, false);
    return Money.sum(
      lines.filter((l) => String(l.tags.provider ?? '').toLowerCase() === provider).map((l) => l.amount),
      USD,
    );
  };

  /** Lock `month`, and before it every month with a period row that is not locked (months lock in order). */
  const lock = async (month: string) => {
    const open = await owner<{ m: string }[]>`
      SELECT to_char(month, 'YYYY-MM') AS m FROM periods WHERE status <> 'locked' AND month <= ${monthStart(month).slice(0, 10)}
      ORDER BY month`;
    for (const m of [...new Set([...open.map((o) => o.m), month])].sort()) {
      const [p] = await owner<{ status: string }[]>`SELECT status FROM periods WHERE month = ${`${m}-01`}`;
      if (p?.status === 'locked') continue;
      if (!p || p.status === 'open') await services.periods.advance(m, 'closing', controller);
      await services.periods.advance(m, 'locked', controller, { reason: 'property test' });
    }
  };

  /**
   * Plays one sequence for `provider` in `month`, checking after every step that nothing is double counted and that a
   * locked month never moves; leaves the month locked (months lock in order).
   */
  const play = async (ops: Op[], provider: string, month: string) => {
    const estimates: [Money, Money] = [Money.zero(USD), Money.zero(USD)];
    type Live = null | { lines: [number | null, number | null]; credit: number | null };
    const live: [Live, Live] = [null, null];
    let locked: Money | null = null;
    const ids: [string | null, string | null] = [null, null];
    const expected = () => {
      let t = Money.zero(USD);
      for (const k of [0, 1] as const) {
        const billed = live.filter((x) => x && x.lines[k] !== null);
        t = billed.length
          ? t.plus(
              Money.sum(
                billed.map((x) => cents(x!.lines[k]!)),
                USD,
              ),
            )
          : t.plus(estimates[k]);
      }
      for (const x of live) if (x?.credit) t = t.minus(cents(x.credit));
      return t;
    };
    for (const o of ops) {
      if (o.t === 'est') {
        await estimate(provider, MODELS[o.model], month, locked ? OPEN : month, o.day, cents(o.cents));
        estimates[o.model] = estimates[o.model].plus(cents(o.cents));
      } else if (o.t === 'import') {
        const rows = [
          'provider,invoice_number,period,model,sku,quantity,unit,amount,currency,charge_category,description',
        ];
        o.lines.forEach((c, k) => {
          if (c !== null)
            rows.push(`${provider},INV-${o.which},${month},${MODELS[k]},tokens,1000,Tokens,${dollars(c)},USD,Usage,`);
        });
        if (o.credit) rows.push(`${provider},INV-${o.which},${month},,credit,,,-${dollars(o.credit)},USD,Credit,`);
        if (rows.length === 1) continue;
        const res = await services.invoices.import({ csv: rows.join('\n'), note: '', origin: 'entered' }, controller);
        ids[o.which] = res.invoices[0]!.id;
        live[o.which] = { lines: o.lines, credit: o.credit };
      } else if (o.t === 'void') {
        if (!live[o.which]) continue;
        await services.invoices.void(ids[o.which]!, 'property test', controller);
        live[o.which] = null;
      } else {
        if (locked) continue;
        await lock(month);
        locked = await figure(provider, month, month);
      }
      // No double count, anywhere.
      expect((await figure(provider, month, OPEN)).toString(), JSON.stringify(ops)).toBe(expected().toString());
      // A locked month never moves.
      if (locked)
        expect((await figure(provider, month, month)).toString(), JSON.stringify(ops)).toBe(locked.toString());
    }
    if (!locked) await lock(month);
  };

  return {
    services,
    estimate,
    figure,
    lock,
    play,
    async close() {
      await sql.end();
      await owner.end();
      await db.drop();
    },
  };
}

describe.skipIf(!integrationEnabled('db'))(
  'invoices never double count, and a locked month never moves (property)',
  () => {
    for (const seedNo of seedsFromEnv())
      it(`holds for random sequences of estimates, imports, re-imports, voids and a lock (seed ${seedNo})`, async () => {
        const w = await world();
        let run = 0;
        try {
          await fc.assert(
            fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 9 }), async (ops) => {
              const i = run++;
              let month = '2025-01';
              for (let k = 0; k < i; k++) month = nextMonth(month);
              // The ledger's partitions start in 2025, and the open month is 2026-12.
              if (month >= '2026-12') return;
              await w.play(ops, `prov${i}`, month);
            }),
            { numRuns: 18, seed: seedNo, endOnFailure: true },
          );
        } finally {
          await w.close();
        }
      }, 600_000);

    // The two classes of sequence the review of wave 4 found failing (B1), as fixed cases.
    describe('regression cases from the review of wave 4 (B1)', () => {
      it('a re-import that drops a model another live invoice bills frees its estimates to that invoice', async () => {
        const w = await world();
        try {
          // Seed 3, run 14: INV-0 is re-issued without m-beta while INV-1 bills it; m-beta's estimate must stay
          // claimed (by INV-1) rather than count beside it.
          await w.play(
            [
              { t: 'import', which: 0, lines: [8745, 4278], credit: 337 },
              { t: 'lock' },
              { t: 'void', which: 1 },
              { t: 'est', model: 1, cents: 2933, day: 14 },
              { t: 'void', which: 1 },
              { t: 'import', which: 0, lines: [2298, 846], credit: 475 },
              { t: 'import', which: 1, lines: [4528, 1816], credit: 393 },
              { t: 'import', which: 0, lines: [4949, null], credit: 33 },
            ],
            'regp',
            '2025-01',
          );
          // The same in an open month: INV-0 claims the estimates, INV-1 bills the model too, INV-0 drops it.
          await w.play(
            [
              { t: 'est', model: 0, cents: 1000, day: 3 },
              { t: 'import', which: 0, lines: [1500, null], credit: null },
              { t: 'import', which: 1, lines: [700, 200], credit: null },
              { t: 'import', which: 0, lines: [null, 300], credit: null },
              { t: 'void', which: 1 },
            ],
            'regq',
            '2025-02',
          );
        } finally {
          await w.close();
        }
      }, 120_000);

      it('after the lock, a $0.00 line for a model with nothing to claim still covers a later estimate', async () => {
        const w = await world();
        try {
          // Seed 451, run 5.
          await w.play(
            [
              { t: 'est', model: 1, cents: 1458, day: 8 },
              { t: 'lock' },
              { t: 'import', which: 1, lines: [0, null], credit: 4 },
              { t: 'est', model: 0, cents: 4988, day: 17 },
            ],
            'regz',
            '2025-01',
          );
        } finally {
          await w.close();
        }
      }, 120_000);
    });

    describe('examples', () => {
      let w: Awaited<ReturnType<typeof world>>;
      beforeAll(async () => {
        w = await world();
      }, 120_000);
      afterAll(async () => {
        await w?.close();
      });

      it('two invoices for one model in a locked month never both subtract its estimates (B2)', async () => {
        const provider = 'twice';
        const month = '2026-09';
        await w.estimate(provider, 'm-alpha', month, month, 3, cents(10_000)); // $100 estimated
        await w.lock(month);
        const before = await w.figure(provider, month, month);
        for (const n of ['A', 'B']) {
          const csv = [
            'provider,invoice_number,period,model,sku,quantity,unit,amount,currency,charge_category,description',
            `${provider},INV-${n},${month},m-alpha,tokens,1000,Tokens,50.00,USD,Usage,`,
          ].join('\n');
          await w.services.invoices.import({ csv, note: '', origin: 'entered' }, controller);
        }
        // $50 + $50 billed: $100 in all, never $0; October-style, the locked month itself stays as it was.
        expect((await w.figure(provider, month, OPEN)).toString()).toBe(cents(10_000).toString());
        expect((await w.figure(provider, month, month)).toString()).toBe(before.toString());
      }, 120_000);

      it('an estimate after its month was invoiced is linked late, flagged on the row, and re-planned on re-import (B1)', async () => {
        const provider = 'late';
        const month = '2026-10';
        const csv = [
          'provider,invoice_number,period,model,sku,quantity,unit,amount,currency,charge_category,description',
          `${provider},INV-L,${month},m-alpha,tokens,1000,Tokens,30.00,USD,Usage,`,
        ].join('\n');
        await w.estimate(provider, 'm-alpha', month, month, 2, cents(1_000));
        await w.services.invoices.import({ csv, note: '', origin: 'entered' }, controller);
        await w.estimate(provider, 'm-alpha', month, month, 20, cents(2_000)); // arrives after the invoice
        expect((await w.figure(provider, month, OPEN)).toString()).toBe(cents(3_000).toString());
        const row = (await w.services.invoices.reconciliation(month)).rows.find((r) => r.provider === provider)!;
        expect(row.lateEstimates).toBe(1);
        expect(row.note).toMatch(/estimates after invoice: re-reconcile/);
        expect(row.estimated).toBe('30.000000');
        await w.services.invoices.import({ csv, note: 're-reconcile', origin: 'entered' }, controller);
        const again = (await w.services.invoices.reconciliation(month)).rows.find((r) => r.provider === provider)!;
        expect(again.lateEstimates).toBe(0);
        expect((await w.figure(provider, month, OPEN)).toString()).toBe(cents(3_000).toString());
      }, 120_000);
    });
  },
);
