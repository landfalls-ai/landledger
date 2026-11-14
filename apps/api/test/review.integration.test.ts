/**
 * The fixes of wave 1's review against Postgres (LANDLEDGER_INTEGRATION=db): an empty source answer never reverses a
 * day unasked, a retroactive rate card reaches every day, the hours after midnight while yesterday is provisional,
 * locks only of whole months (and the audited override), and a late record in a closing month.
 */
import { correct, ulid } from '@landledger/focus';
import { aiInputRow } from '@landledger/focus/testing';
import { Decimal, Money } from '@landledger/money';
import { createTestDatabase, integrationEnabled, type TestDatabase } from '@landledger/schema/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/db.js';
import { RATE_CARD_V1, seed } from '../src/seed.js';
import { createServices, type Services } from '../src/services.js';
import { call, DANA, fakeSources, TAL, testConfig, YOAV } from './fakes.js';

const sources = fakeSources();

describe.skipIf(!integrationEnabled('db'))("wave 1's review against Postgres", () => {
  let db: TestDatabase;
  let sql: Sql;
  let services: Services;
  let now = new Date('2026-11-14T12:00:00Z');

  beforeAll(async () => {
    db = await createTestDatabase();
    sql = createSql(db.url);
    services = createServices(
      testConfig({ postgresUrl: db.url, dockerSharesCluster: 'orbstack' }),
      sql,
      sources.fetchImpl,
      undefined,
      () => now,
    );
    await seed(sql);
    for (const p of [YOAV, DANA, TAL])
      await sql`INSERT INTO users (id, issuer, subject, email, name, roles) VALUES (${p.id}, 'test', ${p.id}, ${p.email}, ${p.name}, ${p.roles})`;
    await services.rateCards.importAiLines(RATE_CARD_V1, await services.landflow!.prices(), DANA);
    await services.rateCards.approve(RATE_CARD_V1, YOAV);
    await services.allocation.approve('rsv_main_1', DANA);
  });
  afterAll(async () => {
    await sql?.end();
    await db?.drop();
  });

  const net = async (source: string, day: string, resource?: string) => {
    const [{ c }] = await sql`
      SELECT coalesce(sum(effective_cost_micros), 0)::text AS c FROM cost_records
      WHERE source = ${source} AND charge_period_start = ${`${day}T00:00:00Z`}::timestamptz
        AND (${resource ?? null}::text IS NULL OR tags->>'resource' = ${resource ?? null})`;
    return c as string;
  };

  it('refuses to reverse a day the source now answers with nothing for, unless forced with a reason', async () => {
    sources.state.events = [call('2026-11-13T10:00:00.000Z', 1_000_000, 100_000)];
    expect((await services.ingest.run('landflow', '2026-11-13', 'manual', 'test')).newCount).toBe(2);
    const before = await net('landflow', '2026-11-13');
    // Landflow answers with nothing (an outage looks the same): the run fails and the day stands.
    sources.state.events = [];
    const refused = await services.ingest.run('landflow', '2026-11-13', 'daily', 'schedule');
    expect(refused.outcome).toBe('failed');
    expect(refused.error).toMatch(/answered with nothing for 2026-11-13, but the ledger has 2 live entries/);
    expect(await net('landflow', '2026-11-13')).toBe(before);
    // Clickland too.
    expect((await services.ingest.run('clickland', '2026-11-13', 'manual', 'test')).outcome).toBe('succeeded');
    sources.state.clickland = 'empty';
    expect((await services.ingest.run('clickland', '2026-11-13', 'manual', 'test')).error).toMatch(
      /answered with nothing/,
    );
    sources.state.clickland = 'fixture';
    // Forced, with a reason: reversed, and audited.
    await expect(
      services.ingest.run('landflow', '2026-11-13', 'manual', 'yoav.bendavid@landbright.test', { force: true }),
    ).rejects.toThrow(/needs a reason/);
    const forced = await services.ingest.run('landflow', '2026-11-13', 'manual', 'yoav.bendavid@landbright.test', {
      force: true,
      reason: 'The test calls were deleted in Landflow on purpose',
    });
    expect(forced).toMatchObject({ outcome: 'succeeded', correctedCount: 2 });
    expect(await net('landflow', '2026-11-13')).toBe('0');
    const [audit] = await sql`SELECT actor, actor_kind, data FROM audit_log WHERE action = 'ingest.forced'`;
    expect(audit).toMatchObject({
      actor: 'yoav.bendavid@landbright.test',
      actor_kind: 'person',
      data: { source: 'landflow', day: '2026-11-13', reversed: 2 },
    });
  });

  it('reprices every day from a retroactive rate card’s effective date, not only the last seven', async () => {
    for (const r of await services.ingest.backfill('clickland', '2026-11-02', 'test'))
      expect(r.outcome).toBe('succeeded');
    // 24 core-hours a day at USD 0.034, Docker and pods and idle together.
    expect(await net('clickland', '2026-11-02', 'cpu')).toBe('816000');
    // Version 2 doubles the CPU price from 2 November, proposed by Tal, who added its lines; Yoav approves.
    await sql`INSERT INTO rate_card_versions (id, rate_card_id, version, effective_from, proposed_by)
              VALUES ('rcv_internal_2', 'rc_internal', 2, '2026-11-02', 'usr_tal')`;
    await sql`
      INSERT INTO rate_lines (id, version_id, sku_id, sku_price_id, sku_meter, label, provider, model, pricing_unit,
                              unit_price, currency, details, position, added_by)
      SELECT replace(id, 'internal_1', 'internal_2'), 'rcv_internal_2', sku_id, sku_price_id, sku_meter, label,
             provider, model, pricing_unit,
             CASE WHEN sku_price_id = 'landledger:k8s:cpu' THEN 0.068 ELSE unit_price END,
             currency, details, position, 'usr_tal'
      FROM rate_lines WHERE version_id = ${RATE_CARD_V1}`;
    const approved = await services.rateCards.approve('rcv_internal_2', YOAV);
    const runs = await services.ingest.reprice(approved.effectiveFrom, 'yoav.bendavid@landbright.test', 'v2');
    expect(runs.filter((r) => r.source === 'clickland').map((r) => r.day)).toEqual(
      Array.from({ length: 13 }, (_, i) => `2026-11-${String(i + 2).padStart(2, '0')}`),
    );
    expect(runs.every((r) => r.outcome === 'succeeded')).toBe(true);
    // Twelve days back, outside the hourly job's seven: at the new price.
    expect(await net('clickland', '2026-11-02', 'cpu')).toBe('1632000');
    expect(await net('clickland', '2026-11-13', 'cpu')).toBe('1632000');
    // 1 November stays on v1.
    const [v1] = await sql`SELECT effective_to FROM rate_card_versions WHERE id = ${RATE_CARD_V1}`;
    expect(v1!.effective_to.toISOString().slice(0, 10)).toBe('2026-11-02');
  });

  it('keeps yesterday provisional between midnight and two, then enters it', async () => {
    now = new Date('2026-11-15T01:00:00Z');
    await services.ingest.tick();
    const provisional = await sql`
      SELECT DISTINCT to_char(charge_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM provisional_usage
      WHERE source = 'clickland' ORDER BY 1`;
    expect(provisional.map((r) => r.d)).toEqual(['2026-11-14', '2026-11-15']);
    // The month's figures still have yesterday, as provisional.
    const ov = await services.spend.overview('2026-11');
    expect(Number(ov.monthToDate.provisional)).toBeGreaterThan(0);
    now = new Date('2026-11-15T03:00:00Z');
    await services.ingest.tick();
    const left = await sql`
      SELECT DISTINCT to_char(charge_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM provisional_usage
      WHERE source = 'clickland' ORDER BY 1`;
    expect(left.map((r) => r.d)).toEqual(['2026-11-15']);
    expect(await net('clickland', '2026-11-14', 'cpu')).toBe('1632000');
  });

  it('locks a month only when it is whole; a controller overrides with a reason, audited', async () => {
    now = new Date('2026-11-15T12:00:00Z');
    sources.state.events = [call('2026-10-30T10:00:00.000Z', 1000, 10, {}, 0.01)];
    await services.ingest.run('landflow', '2026-10-30', 'manual', 'test');
    await services.periods.advance('2026-10', 'closing', YOAV);
    // Landflow's data starts 30 October; 31 October was never entered.
    await expect(services.periods.advance('2026-10', 'locked', YOAV)).rejects.toThrow(
      /2026-10 isn't ready to lock: landflow has no complete run for 1 day\(s\) of 2026-10: 2026-10-31/,
    );
    await expect(
      services.periods.advance('2026-10', 'locked', DANA, { reason: 'Landflow was down on the 31st' }),
    ).rejects.toThrow(/Only a controller overrides/);
    const locked = await services.periods.advance('2026-10', 'locked', YOAV, {
      reason: 'Landflow was down on the 31st; its calls are in November',
    });
    expect(locked.status).toBe('locked');
    const [audit] = await sql`SELECT data FROM audit_log WHERE action = 'period.locked'`;
    expect(audit!.data).toMatchObject({
      checks: 'overridden',
      override: { reason: 'Landflow was down on the 31st; its calls are in November' },
    });
    expect(audit!.data.problems[0]).toMatch(/2026-10-31/);
    // A rate card can't take effect in a locked month.
    await sql`INSERT INTO rate_card_versions (id, rate_card_id, version, effective_from, proposed_by)
              VALUES ('rcv_internal_3', 'rc_internal', 3, '2026-10-20', 'usr_tal')`;
    await sql`INSERT INTO rate_lines (id, version_id, sku_id, sku_price_id, sku_meter, label, pricing_unit, unit_price, currency, added_by)
              VALUES ('rl_internal_3_cpu', 'rcv_internal_3', 'landledger:k8s:cpu', 'landledger:k8s:cpu', 'Allocated Cores', 'Compute', 'Core-Hours', 0.05, 'USD', 'usr_tal')`;
    await expect(services.rateCards.approve('rcv_internal_3', YOAV)).rejects.toThrow(/closing or locked month/);
  });

  it('refuses to lock a month that has not ended; a late record in a closing month is allocated', async () => {
    now = new Date('2026-11-20T12:00:00Z');
    await services.ingest.run('clickland', '2026-11-20', 'hourly', 'test'); // today: provisional
    await services.periods.advance('2026-11', 'closing', YOAV);
    const problems = await services.periods.lockProblems('2026-11');
    expect(problems[0]).toBe("2026-11 hasn't ended yet (it ends 2026-12-01 00:00 UTC)");
    expect(problems.some((p) => /provisional row\(s\) from clickland are still in 2026-11/.test(p))).toBe(true);
    expect(problems.some((p) => /clickland has no complete run for .* 2026-11-15/.test(p))).toBe(true);
    await expect(services.periods.advance('2026-11', 'locked', YOAV)).rejects.toThrow(/hasn't ended yet/);
    // A late day enters the closing month and joins its newest allocation generation.
    const late = await services.ingest.run('clickland', '2026-11-16', 'manual', 'test');
    expect(late).toMatchObject({ outcome: 'succeeded', provisional: false });
    expect(late.newCount).toBeGreaterThan(0);
    const [{ n }] = await sql`
      SELECT count(*)::int AS n FROM cost_records r
      WHERE r.charge_period_start = '2026-11-16T00:00:00Z'
        AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.record_id = r.record_id
          AND a.generation_id = (SELECT id FROM allocation_generations WHERE month = '2026-11-01' ORDER BY number DESC LIMIT 1))`;
    expect(n).toBe(0);
    expect((await services.periods.lockProblems('2026-11')).some((p) => /no stored allocation/.test(p))).toBe(false);
  });

  it('never adds an estimate to the invoice line that replaces it', async () => {
    const charged = {
      from: '2026-11-16',
      to: '2026-11-16',
      by: 'category',
      layer: 'direct',
      provisional: 'true',
    } as const;
    const before = Money.parse((await services.spend.spend(charged)).total.total, 'USD');
    const idleKey = 'clickland:2026-11-16:orbstack:idle:cpu';
    const [idle] = await sql`
      SELECT effective_cost_micros::text AS c FROM cost_records r JOIN cost_record_keys k USING (record_id)
      WHERE r.source_key = ${idleKey} AND NOT k.is_reversal
        AND NOT EXISTS (SELECT 1 FROM cost_record_keys x WHERE x.correction_of_id = k.record_id)`;
    const [run] = await sql`SELECT id FROM ingest_runs WHERE source = 'clickland' LIMIT 1`;
    // The cluster's invoice for 16 November: USD 7.20, invoiced (the estimate stays in the ledger).
    const invoice = aiInputRow({
      x_RecordId: ulid(),
      x_IngestRunId: run!.id,
      x_Basis: 'invoiced',
      x_Source: 'invoice',
      x_SourceKey: 'invoice:2026-11:orbstack:cpu',
      x_RateCardVersion: null,
      x_SourceCost: null,
      BilledCost: Money.parse('7.2', 'USD'),
      ChargePeriodStart: '2026-11-16T00:00:00Z',
      ChargePeriodEnd: '2026-11-17T00:00:00Z',
    });
    await services.records.append([invoice]);
    const both = Money.parse((await services.spend.spend(charged)).total.total, 'USD');
    expect(both.minus(before).toString()).toBe('USD 7.200000'); // unlinked: both count
    await sql`INSERT INTO invoice_estimate_links (estimated_source_key, invoiced_record_id, month, linked_by)
              VALUES (${idleKey}, ${invoice.x_RecordId}, '2026-11-01', 'usr_yoav')`;
    const linked = Money.parse((await services.spend.spend(charged)).total.total, 'USD');
    // The estimate it replaces drops out: never estimated and invoiced for the same charge.
    expect(linked.toString()).toBe(both.minus(Money.ofMicros(idle!.c, 'USD')).toString());
    await expect(
      sql`INSERT INTO invoice_estimate_links (estimated_source_key, invoiced_record_id, month, linked_by)
          VALUES ('clickland:2026-11-16:orbstack:idle:memory', ${invoice.x_RecordId}, '2026-10-01', 'usr_yoav')`,
    ).rejects.toThrow(/its own billing month/);
    await expect(sql`DELETE FROM invoice_estimate_links`).rejects.toThrow(/append-only/);
  });

  it('refuses budgets for a locked month, and allocations to a code that is no cost center', async () => {
    await expect(
      services.budgets.import(
        { csv: 'cost_center,month,amount,currency\nENG-PLATFORM,2026-10,5,USD\n', note: 'late' },
        YOAV,
      ),
    ).rejects.toThrow(/2026-10 is locked; nothing was imported/);
    const [imp] = await sql`SELECT id FROM budget_imports LIMIT 1`;
    await expect(
      sql`INSERT INTO budgets (import_id, cost_center_code, month, amount_micros, currency)
          VALUES (${imp!.id}, 'ENG-PLATFORM', '2026-10-01', 1, 'USD')`,
    ).rejects.toThrow(/locked: its budget is final/);
    const [gen] =
      await sql`SELECT id FROM allocation_generations WHERE month = '2026-11-01' ORDER BY number DESC LIMIT 1`;
    await expect(
      sql`INSERT INTO allocations (month, generation_id, record_id, billing_period_start, charge_day, basis, cost_center, amount_micros, currency)
          VALUES ('2026-11-01', ${gen!.id}, 'r_x', '2026-11-01T00:00:00Z', '2026-11-16', 'estimated', 'NOPE', 1, 'USD')`,
    ).rejects.toThrow(/foreign key/);
  });

  it('keeps a charge in another currency beside its conversion; reads refuse an unconverted one', async () => {
    await sql`INSERT INTO fx_rates (id, base, quote, rate_date, rate, source, recorded_by)
              VALUES ('fx_eur_usd_1116', 'EUR', 'USD', '2026-11-16', 1.0827, 'ECB reference rate (test)', 'test')`;
    const [run] = await sql`SELECT id FROM ingest_runs WHERE source = 'clickland' LIMIT 1`;
    const converted = aiInputRow({
      x_RecordId: ulid(),
      x_IngestRunId: run!.id,
      x_Source: 'manual',
      x_SourceKey: 'manual:2026-11-16:eur-service',
      x_OriginalCost: Decimal.parse('6.650000'),
      x_OriginalCurrency: 'EUR',
      x_FxRateId: 'fx_eur_usd_1116',
      ChargePeriodStart: '2026-11-16T00:00:00Z',
      ChargePeriodEnd: '2026-11-17T00:00:00Z',
    });
    await services.records.append([converted]);
    const [row] =
      await sql`SELECT original_cost::text, original_currency, fx_rate_id FROM cost_records WHERE record_id = ${converted.x_RecordId}`;
    expect(row).toMatchObject({ original_cost: '6.650000', original_currency: 'EUR', fx_rate_id: 'fx_eur_usd_1116' });
    // A reversal negates the original amount too; one that doesn't is refused.
    const state = { isLocked: (m: string) => m <= '2026-10', openMonth: '2026-11' };
    const [reversal] = correct(converted, null, state, { ingestRunId: run!.id });
    await expect(
      services.records.append([{ ...reversal!, x_RecordId: ulid(), x_OriginalCost: Decimal.parse('6.65') }]),
    ).rejects.toThrow(/negates every amount/);
    await services.records.append([reversal!]);
    // A record whose amounts are themselves in EUR never reaches a USD sum: the read refuses it.
    const eur = (a: string) => Money.parse(a, 'EUR');
    await services.records.append([
      aiInputRow({
        x_RecordId: ulid(),
        x_IngestRunId: run!.id,
        x_Source: 'manual',
        x_SourceKey: 'manual:2026-11-16:eur-unconverted',
        BillingCurrency: 'EUR',
        BilledCost: eur('0'),
        EffectiveCost: eur('7.2'),
        ListCost: eur('7.2'),
        ContractedCost: eur('7.2'),
        ChargePeriodStart: '2026-11-16T00:00:00Z',
        ChargePeriodEnd: '2026-11-17T00:00:00Z',
      }),
    ]);
    await expect(
      services.spend.spend({
        from: '2026-11-16',
        to: '2026-11-16',
        by: 'category',
        layer: 'direct',
        provisional: 'true',
      }),
    ).rejects.toThrow(/is in EUR/);
  });
});
