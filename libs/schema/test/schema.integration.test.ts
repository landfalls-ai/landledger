import { Decimal, Money } from '@landledger/money';
import { billingPeriod, type CostRecord, correct, dayPeriod, reverse, toRow } from '@landledger/focus';
import { aiInputRow, clusterRow } from '@landledger/focus/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/index.js';
import { createTestDatabase, integrationEnabled, type TestDatabase } from '../src/testing.js';

/** Migration 0001 against a real Postgres (spec 001 T010–T012). Run with LANDLEDGER_INTEGRATION=db. */
describe.skipIf(!integrationEnabled('db'))('0001 against Postgres', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;
  let n = 0;
  const id = (prefix = '01KTEST') => `${prefix}${String(++n).padStart(19 - prefix.length + 7, '0')}`;
  const ctx = { ingestRunId: 'run_2', newId: () => id('01KREV') };

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false });
    sql = postgres(db.url, { onnotice: () => {}, max: 2 });
  });
  afterAll(async () => {
    await sql?.end();
    await db?.drop();
  });

  const refused = async (query: Promise<unknown>, pattern: RegExp) => {
    await expect(query).rejects.toThrow(pattern);
  };
  const insert = (...records: CostRecord[]) => sql`INSERT INTO cost_records ${sql(records.map(toRow))}`;

  it('applies once, then has nothing to do, and refuses an edited migration', async () => {
    expect(await migrate(db.url)).toEqual([
      '0001_core.sql',
      '0002_approvals_and_ingest.sql',
      '0003_allocation.sql',
      '0004_budgets.sql',
    ]);
    expect(await migrate(db.url)).toEqual([]);
    const edited = loadMigrations().map((m) => ({ ...m, checksum: 'x' }));
    await expect(migrate(db.url, () => {}, edited)).rejects.toThrow(/changed after it was applied/);
    // What the records below stand on: a person, a rate card version and two ingest runs.
    await sql`INSERT INTO users (id, issuer, subject, name, roles) VALUES ('usr_ctrl', 'iss', 'sub', 'Yoav', ${['controller']})`;
    await sql`INSERT INTO rate_cards (id, name, currency, owner) VALUES ('rc_internal', 'Internal', 'USD', 'Finance')`;
    await sql`INSERT INTO rate_card_versions (id, rate_card_id, version, effective_from, proposed_by)
              VALUES ('rcv_internal_1', 'rc_internal', 1, '2026-10-01', 'seed')`;
    for (const run of ['run_1', 'run_2'])
      await sql`INSERT INTO ingest_runs (id, source, kind, day, started_by) VALUES (${run}, 'manual', 'manual', '2026-11-13', 'test')`;
  });

  it('partitions by billing month in UTC, 2025–2027 from the start and more on demand', async () => {
    const [{ count }] =
      await sql`SELECT count(*)::int AS count FROM pg_inherits WHERE inhparent = 'cost_records'::regclass`;
    expect(count).toBe(36);
    const [{ name }] = await sql`SELECT ensure_cost_records_partition('2028-02-17') AS name`;
    expect(name).toBe('cost_records_2028_02');
    await sql.begin(async (tx) => {
      await tx`SET LOCAL TIME ZONE 'Asia/Jerusalem'`;
      await tx`INSERT INTO cost_records ${tx(toRow(aiInputRow({ x_RecordId: id(), x_SourceKey: 'k:tz', ...dayPeriod('2026-11-30') })))}`;
    });
    const [row] = await sql`SELECT tableoid::regclass::text AS part FROM cost_records WHERE source_key = 'k:tz'`;
    expect(row!.part).toBe('cost_records_2026_11');
  });

  it('accepts inserts only: UPDATE, DELETE and TRUNCATE fail, for the owner too', async () => {
    const r = aiInputRow({ x_RecordId: id(), x_SourceKey: 'k:append' });
    await insert(r);
    await refused(
      sql`UPDATE cost_records SET effective_cost_micros = 1 WHERE record_id = ${r.x_RecordId}`,
      /append-only/,
    );
    await refused(sql`DELETE FROM cost_records WHERE record_id = ${r.x_RecordId}`, /append-only/);
    await refused(sql`UPDATE cost_records_2026_11 SET effective_cost_micros = 1`, /append-only/);
    await refused(sql`DELETE FROM cost_records_2026_11`, /append-only/);
    await refused(sql`TRUNCATE cost_records`, /append-only/);
    await refused(sql`TRUNCATE cost_records_2026_11`, /append-only/);
    await refused(sql`DELETE FROM cost_record_keys`, /append-only/);
    const [row] =
      await sql`SELECT effective_cost_micros, pricing_quantity FROM cost_records WHERE record_id = ${r.x_RecordId}`;
    expect(row).toEqual({ effective_cost_micros: '7200000', pricing_quantity: '2.4' }); // strings: exact
  });

  it('checks basis, billed cost, units, UTC days and the correction class in the database', async () => {
    const bad = (over: Partial<CostRecord>) =>
      insert(aiInputRow({ x_RecordId: id(), x_SourceKey: `k:bad:${n}`, ...over }));
    await refused(bad({ BilledCost: Money.parse('7.2', 'USD') }), /estimated_billed_zero/);
    await refused(bad({ EffectiveCost: Money.parse('1', 'USD') }), /estimated_effective/);
    await refused(bad({ x_Basis: 'invoiced', BilledCost: Money.parse('7.2', 'USD') }), /invoiced_no_rate_card/);
    await refused(bad({ x_Basis: 'guessed' as never }), /check constraint/);
    await refused(bad({ ConsumedUnit: null }), /check constraint/);
    await refused(bad({ ChargePeriodStart: '2026-11-13T01:00:00Z' }), /charge_period_utc_days/);
    await refused(bad({ BillingPeriodEnd: '2026-11-30T00:00:00Z' }), /billing_period_utc_month/);
    await refused(bad({ ChargeClass: 'Correction' }), /correction_class/);
    await refused(bad({ ...billingPeriod('2026-12') }), /correction_class/);
    await refused(bad({ ServiceCategory: 'AI' as never }), /check constraint/);
    await refused(bad({ BillingCurrency: 'usd' }), /check constraint/);
    await refused(bad({ x_IngestRunId: 'run_nope' }), /foreign key/);
  });

  it('corrects by reversal and re-entry; one live entry per key and basis', async () => {
    const original = aiInputRow({ x_RecordId: id(), x_SourceKey: 'k:fix' });
    await insert(original);
    await refused(insert(aiInputRow({ x_RecordId: id(), x_SourceKey: 'k:fix' })), /live entry: reverse it/);

    const fixed = aiInputRow({
      x_SourceKey: 'k:fix',
      ConsumedQuantity: Decimal.parse('2500000'),
      PricingQuantity: Decimal.parse('2.5'),
      ListCost: Money.parse('7.5', 'USD'),
      ContractedCost: Money.parse('7.5', 'USD'),
      EffectiveCost: Money.parse('7.5', 'USD'),
    });
    const [reversal, reentry] = correct(original, fixed, { isLocked: () => false, openMonth: '2026-11' }, ctx);
    await insert(reversal!, reentry!); // one statement: the re-entry sees the reversal
    const rows = await sql`
      SELECT source_revision AS rev, is_reversal, effective_cost_micros AS micros FROM cost_records
      WHERE source_key = 'k:fix' ORDER BY seq`;
    expect(rows.map((r) => [r.rev, r.is_reversal, r.micros])).toEqual([
      [0, false, '7200000'],
      [0, true, '-7200000'],
      [1, false, '7500000'],
    ]);
    const [{ net }] =
      await sql`SELECT sum(effective_cost_micros)::text AS net FROM cost_records WHERE source_key = 'k:fix'`;
    expect(net).toBe('7500000');

    await refused(insert(reverse(original, ctx)), /duplicate key|reverses an entry/); // reversed once only
    const reReversal: CostRecord = {
      ...original,
      x_RecordId: id(),
      x_CorrectionOfId: reversal!.x_RecordId,
      ...{ BilledCost: reversal!.BilledCost.negate(), EffectiveCost: reversal!.EffectiveCost.negate() },
    };
    await refused(insert(reReversal), /never another reversal/);
  });

  it('refuses a reversal that does not negate its original, or names another key', async () => {
    const original = aiInputRow({ x_RecordId: id(), x_SourceKey: 'k:neg' });
    await insert(original);
    const r = reverse(original, ctx);
    await refused(
      insert({
        ...r,
        EffectiveCost: Money.parse('-7', 'USD'),
        ContractedCost: Money.parse('-7', 'USD'),
        ListCost: Money.parse('-7', 'USD'),
      }),
      /negates every amount/,
    );
    await refused(insert({ ...r, x_SourceKey: 'k:other' }), /its own source key/);
    await refused(insert({ ...r, x_CorrectionOfId: 'nope' }), /not in the ledger/);
  });

  it('moves periods open → closing → locked by a person; a locked month takes only corrections elsewhere', async () => {
    const october = clusterRow({ x_RecordId: id(), x_SourceKey: 'k:oct' });
    await insert(october);
    const [{ status }] = await sql`SELECT status FROM periods WHERE month = '2026-10-01'`;
    expect(status).toBe('open'); // created by its first record

    await refused(
      sql`UPDATE periods SET status = 'locked', locked_by = 'usr_ctrl', locked_at = now() WHERE month = '2026-10-01'`,
      /one step forward/,
    );
    await refused(sql`UPDATE periods SET status = 'closing' WHERE month = '2026-10-01'`, /check constraint/); // who and when
    await refused(
      sql`UPDATE periods SET status = 'closing', closing_by = 'key_1', closing_at = now() WHERE month = '2026-10-01'`,
      /foreign key/,
    );
    await sql`UPDATE periods SET status = 'closing', closing_by = 'usr_ctrl', closing_at = now() WHERE month = '2026-10-01'`;
    await insert(clusterRow({ x_RecordId: id(), x_SourceKey: 'k:oct-closing' })); // closing still takes ingest
    await sql`UPDATE periods SET status = 'locked', locked_by = 'usr_ctrl', locked_at = now() WHERE month = '2026-10-01'`;

    await refused(
      sql`UPDATE periods SET status = 'open', closing_by = null, closing_at = null, locked_by = null, locked_at = null WHERE month = '2026-10-01'`,
      /never reopens/,
    );
    await refused(sql`DELETE FROM periods WHERE month = '2026-10-01'`, /never deleted/);
    await refused(insert(clusterRow({ x_RecordId: id(), x_SourceKey: 'k:oct-late' })), /period 2026-10 is locked/);
    await refused(
      insert(
        clusterRow({ x_RecordId: id(), x_SourceKey: 'k:sep', ...dayPeriod('2026-09-30'), ...billingPeriod('2026-09') }),
      ),
      /locked/,
    );
    await refused(insert(reverse(october, ctx)), /locked/); // a reversal in October too

    // Late data for 30 October: reversal and re-entry in November as Corrections, dated 30 October (§6).
    const more = clusterRow({
      x_SourceKey: 'k:oct',
      ConsumedQuantity: Decimal.parse('2.5'),
      PricingQuantity: Decimal.parse('2.5'),
      ListCost: Money.parse('0.085', 'USD'),
      ContractedCost: Money.parse('0.085', 'USD'),
      EffectiveCost: Money.parse('0.085', 'USD'),
    });
    await insert(...correct(october, more, { isLocked: (m) => m <= '2026-10', openMonth: '2026-11' }, ctx));
    const [oct] =
      await sql`SELECT sum(effective_cost_micros)::text AS s FROM cost_records WHERE billing_period_start = '2026-10-01T00:00:00Z'`;
    expect(oct!.s).toBe(String(42_500 * 2)); // October's total never changes
    const nov =
      await sql`SELECT charge_class, charge_period_start FROM cost_records WHERE source_key = 'k:oct' AND billing_period_start = '2026-11-01T00:00:00Z'`;
    expect(nov.map((r) => r.charge_class)).toEqual(['Correction', 'Correction']);
    expect(nov.every((r) => (r.charge_period_start as Date).toISOString() === '2026-10-30T00:00:00.000Z')).toBe(true);
  });

  it('locks months in order', async () => {
    await sql`INSERT INTO periods (month) VALUES ('2026-12-01'), ('2027-01-01') ON CONFLICT DO NOTHING`;
    await sql`UPDATE periods SET status = 'closing', closing_by = 'usr_ctrl', closing_at = now() WHERE month = '2027-01-01'`;
    await refused(
      sql`UPDATE periods SET status = 'locked', locked_by = 'usr_ctrl', locked_at = now() WHERE month = '2027-01-01'`,
      /lock the months before/,
    );
  });

  it('presents records under FOCUS names, six decimals, UTC times: an export is a select', async () => {
    const [row] = await sql`SELECT * FROM cost_records_focus WHERE "x_SourceKey" = 'k:append'`;
    expect(row).toMatchObject({
      BilledCost: '0.000000',
      EffectiveCost: '7.200000',
      ListUnitPrice: '3',
      PricingQuantity: '2.4',
      PricingUnit: '1000000 Tokens',
      ChargePeriodStart: '2026-11-13T00:00:00Z',
      ChargePeriodEnd: '2026-11-14T00:00:00Z',
      BillingPeriodStart: '2026-11-01T00:00:00Z',
      BillingPeriodEnd: '2026-12-01T00:00:00Z',
      ServiceCategory: 'AI and Machine Learning',
      Tags: { team: 'support' },
      x_Basis: 'estimated',
      x_IngestRunId: 'run_1',
    });
    expect(Object.keys(row!)).toHaveLength(56);
    const [rev] =
      await sql`SELECT "EffectiveCost", "PricingQuantity" FROM cost_records_focus WHERE "x_SourceKey" = 'k:fix' AND "x_CorrectionOfId" IS NOT NULL`;
    expect(rev).toEqual({ EffectiveCost: '-7.200000', PricingQuantity: '-2.4' });
    const text = await sql`SELECT "EffectiveCost"::text AS t FROM cost_records_focus`;
    for (const { t } of text) expect(t).toMatch(/^-?\d+\.\d{6}$/); // plain decimals, no +, no exponent
  });

  it('keeps FX rates append-only and finds the latest recorded rate for the latest date on or before a day', async () => {
    await sql`INSERT INTO fx_rates (id, base, quote, rate_date, rate, source, recorded_by) VALUES
      ('fx_1', 'EUR', 'USD', '2026-11-01', '1.08', 'test', 'test')`;
    await sql`INSERT INTO fx_rates (id, base, quote, rate_date, rate, source, recorded_by) VALUES
      ('fx_2', 'EUR', 'USD', '2026-11-01', '1.09', 'test', 'test')`;
    await refused(sql`UPDATE fx_rates SET rate = 2`, /append-only/);
    await refused(sql`DELETE FROM fx_rates`, /append-only/);
    await refused(
      sql`INSERT INTO fx_rates (id, base, quote, rate_date, rate, source, recorded_by) VALUES ('fx_3', 'EUR', 'USD', '2026-11-02', '-1', 't', 't')`,
      /check constraint/,
    );
    const [r] = await sql`SELECT id FROM fx_rates WHERE base = 'EUR' AND quote = 'USD' AND rate_date <= '2026-11-05'
                          ORDER BY rate_date DESC, recorded_at DESC, id DESC LIMIT 1`;
    expect(r!.id).toBe('fx_2');
  });

  it('keeps rate card proposals until a person approves them; approved versions never overlap or change', async () => {
    await sql`INSERT INTO rate_cards (id, name, currency, owner) VALUES ('rc_t', 'T', 'USD', 'Finance')`;
    await sql`INSERT INTO rate_card_versions (id, rate_card_id, version, effective_from, proposed_by) VALUES ('v1', 'rc_t', 1, '2026-11-01', 'seed')`;
    await sql`INSERT INTO rate_lines (id, version_id, sku_id, sku_price_id, sku_meter, label, pricing_unit, unit_price, currency)
              VALUES ('l1', 'v1', 'landledger:k8s:cpu', 'landledger:k8s:cpu', 'Allocated Cores', 'CPU', 'Core-Hours', '0.034', 'USD')`;
    await sql`INSERT INTO rate_card_versions (id, rate_card_id, version, effective_from, proposed_by) VALUES ('v1b', 'rc_t', 2, '2026-11-01', 'agent')`; // proposals may overlap
    await refused(sql`UPDATE rate_card_versions SET note = 'x' WHERE id = 'v1'`, /only gets approved/);
    await refused(
      sql`UPDATE rate_card_versions SET approved_by = 'key_x', approved_at = now() WHERE id = 'v1'`,
      /foreign key/,
    );
    await sql`UPDATE rate_card_versions SET approved_by = 'usr_ctrl', approved_at = now() WHERE id = 'v1'`;
    await refused(
      sql`UPDATE rate_card_versions SET approved_by = 'usr_ctrl', approved_at = now() WHERE id = 'v1b'`,
      /exclusion constraint/,
    );
    await refused(
      sql`INSERT INTO rate_lines (id, version_id, sku_id, sku_price_id, sku_meter, label, pricing_unit, unit_price, currency)
              VALUES ('l2', 'v1', 's', 's2', 'm', 'x', 'GB', '1', 'USD')`,
      /approved: its lines never change/,
    );
    await refused(sql`UPDATE rate_lines SET unit_price = '1'`, /append-only/);
    await refused(sql`UPDATE rate_card_versions SET note = 'x' WHERE id = 'v1'`, /only gets an end date/);
    await sql`UPDATE rate_card_versions SET effective_to = '2026-12-01' WHERE id = 'v1'`;
    await refused(
      sql`UPDATE rate_card_versions SET effective_to = '2027-01-01' WHERE id = 'v1'`,
      /only gets an end date/,
    );
  });

  it('finishes an ingest run once and never deletes it', async () => {
    await sql`INSERT INTO ingest_runs (id, source, kind, day, started_by) VALUES ('run_f', 'clickland', 'daily', '2026-11-13', 'job')`;
    await refused(sql`UPDATE ingest_runs SET day = '2026-11-12' WHERE id = 'run_f'`, /finished once/);
    await refused(sql`UPDATE ingest_runs SET outcome = 'succeeded' WHERE id = 'run_f'`, /check constraint/);
    await sql`UPDATE ingest_runs SET outcome = 'succeeded', finished_at = now(), new_count = 3 WHERE id = 'run_f'`;
    await refused(sql`UPDATE ingest_runs SET new_count = 4 WHERE id = 'run_f'`, /finished once/);
    await refused(sql`DELETE FROM ingest_runs WHERE id = 'run_f'`, /never deleted/);
  });

  it('replaces provisional usage freely, estimated rows only, never in the ledger', async () => {
    const today = toRow(aiInputRow({ x_RecordId: id(), x_SourceKey: 'k:today', ...dayPeriod('2026-11-14') }));
    await sql`INSERT INTO provisional_usage ${sql(today)}`;
    await sql`DELETE FROM provisional_usage WHERE source = 'landflow' AND charge_period_start = '2026-11-14T00:00:00Z'`;
    await sql`INSERT INTO provisional_usage ${sql(today)}`;
    await refused(
      sql`INSERT INTO provisional_usage ${sql({ ...today, record_id: id(), source_key: 'k:x', basis: 'invoiced', rate_card_version_id: null, billed_cost_micros: '7200000' })}`,
      /provisional_estimated/,
    );
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM cost_records WHERE source_key = 'k:today'`;
    expect(count).toBe(0);
  });

  it('keeps the audit log append-only and API keys to known scopes', async () => {
    const zero = '0'.repeat(64);
    await sql`INSERT INTO audit_log (seq, at, actor, actor_kind, action, subject_type, subject_id, prev_hash, hash)
              VALUES (1, now(), 'test', 'system', 'test', 't', '1', ${zero}, ${'a'.repeat(64)})`;
    await refused(sql`UPDATE audit_log SET actor = 'x'`, /append-only/);
    await refused(sql`DELETE FROM audit_log`, /append-only/);
    await refused(sql`TRUNCATE audit_log`, /append-only/);
    await refused(
      sql`INSERT INTO api_keys (id, name, prefix, hash, scopes, created_by) VALUES ('k1', 'x', 'll_', 'h1', ${['decide']}, 't')`,
      /check constraint/,
    );
    await refused(
      sql`INSERT INTO api_keys (id, name, prefix, hash, scopes, created_by) VALUES ('k2', 'x', 'll_', 'h2', ${[]}::text[], 't')`,
      /check constraint/,
    );
  });
});
