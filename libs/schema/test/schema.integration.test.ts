import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/index.js';
import { createTestDatabase, integrationEnabled, type TestDatabase } from '../src/testing.js';

describe.skipIf(!integrationEnabled('db'))('0001 against Postgres', () => {
  let db: TestDatabase;
  let sql: postgres.Sql;

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

  it('applies once, then has nothing to do, and refuses an edited migration', async () => {
    expect(await migrate(db.url)).toEqual(['0001_core.sql']);
    expect(await migrate(db.url)).toEqual([]);
    const edited = loadMigrations().map((m) => ({ ...m, checksum: 'x' }));
    await expect(migrate(db.url, () => {}, edited)).rejects.toThrow(/changed after it was applied/);
  });

  it('creates monthly partitions for 2026–2027 and more on demand, in UTC', async () => {
    const parts = await sql`SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'cost_records'::regclass`;
    expect(parts[0]!.n).toBe(24);
    const [{ name }] = await sql`SELECT ensure_cost_records_partition('2028-02-17') AS name`;
    expect(name).toBe('cost_records_2028_02');
    await sql`SET TIME ZONE 'Asia/Jerusalem'`;
    await sql`INSERT INTO rate_cards (id, name, currency, owner) VALUES ('rc_t', 'T', 'USD', 'Finance')`;
    await insertRecord('rec_edge', '2026-11-30T23:30:00Z');
    const [row] = await sql`SELECT tableoid::regclass::text AS part FROM cost_records WHERE id = 'rec_edge'`;
    expect(row!.part).toBe('cost_records_2026_11');
    await sql`SET TIME ZONE 'UTC'`;
  });

  async function insertRecord(id: string, start: string, extra: Record<string, unknown> = {}) {
    const row = {
      id,
      charge_period_start: start,
      charge_period_end: new Date(new Date(start).getTime() + 3600_000).toISOString(),
      charge_category: 'Usage',
      service_name: 'landflow-host',
      provider_name: 'Own cluster',
      consumed_quantity: '730',
      consumed_unit: 'vCPU-hour',
      list_unit_price: '0.034',
      billed_cost_minor: 2482,
      effective_cost_minor: 2482,
      billing_currency: 'USD',
      x_basis: 'estimated',
      x_source: 'clickland',
      ...extra,
    };
    await sql`INSERT INTO cost_records ${sql(row)}`;
  }

  it('keeps cost records append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
    await insertRecord('rec_1', '2026-11-10T00:00:00Z');
    await refused(sql`UPDATE cost_records SET billed_cost_minor = 1 WHERE id = 'rec_1'`, /append-only/);
    await refused(sql`DELETE FROM cost_records WHERE id = 'rec_1'`, /append-only/);
    await refused(sql`UPDATE cost_records_2026_11 SET billed_cost_minor = 1 WHERE id = 'rec_1'`, /append-only/);
    await refused(sql`TRUNCATE cost_records CASCADE`, /append-only/);
    await refused(sql`TRUNCATE cost_records_2026_11 CASCADE`, /append-only/);
    const [r] = await sql`SELECT billed_cost_minor FROM cost_records WHERE id = 'rec_1'`;
    expect(r!.billed_cost_minor).toBe('2482'); // bigint comes back as a string: exact
  });

  it('takes a correction as a new row that names what it corrects', async () => {
    await insertRecord('rec_2', '2026-11-11T00:00:00Z', {
      charge_class: 'Correction',
      x_corrects: 'rec_1',
      billed_cost_minor: -100,
      effective_cost_minor: -100,
    });
    await refused(insertRecord('rec_3', '2026-11-11T00:00:00Z', { charge_class: 'Correction' }), /check constraint/);
    await refused(insertRecord('rec_4', '2026-11-11T00:00:00Z', { x_basis: 'guessed' }), /check constraint/);
    await refused(insertRecord('rec_5', '2026-11-11T00:00:00Z', { billing_currency: 'usd' }), /check constraint/);
  });

  it('keeps the audit log, FX rates and budgets append-only', async () => {
    const zero = '0'.repeat(64);
    await sql`INSERT INTO audit_log (seq, at, actor, actor_kind, action, subject_type, subject_id, prev_hash, hash)
              VALUES (1, now(), 'test', 'system', 'test', 't', '1', ${zero}, ${'a'.repeat(64)})`;
    await refused(sql`UPDATE audit_log SET actor = 'x'`, /append-only/);
    await refused(sql`DELETE FROM audit_log`, /append-only/);
    await refused(sql`TRUNCATE audit_log`, /append-only/);
    await sql`INSERT INTO fx_rates (base, quote, rate_date, rate, source) VALUES ('EUR', 'USD', '2026-11-01', '1.08', 'test')`;
    await refused(sql`UPDATE fx_rates SET rate = 2`, /append-only/);
    await refused(
      sql`INSERT INTO fx_rates (base, quote, rate_date, rate, source) VALUES ('EUR', 'USD', '2026-11-02', '-1', 'test')`,
      /check constraint/,
    );
    await sql`INSERT INTO budgets (id, cost_center_code, month, amount_minor, currency, version, source, created_by)
              VALUES ('b1', 'ENG-PLATFORM', '2026-11-01', 2800000, 'USD', 1, 'csv', 'test')`;
    await refused(sql`UPDATE budgets SET amount_minor = 1`, /append-only/);
    await refused(
      sql`INSERT INTO budgets (id, cost_center_code, month, amount_minor, currency, version, source, created_by)
              VALUES ('b2', 'ENG-PLATFORM', '2026-11-15', 1, 'USD', 1, 'csv', 'test')`,
      /check constraint/,
    );
  });

  it('lets rate card versions only gain an end date, never overlap, and keeps their rates', async () => {
    await sql`INSERT INTO rate_card_versions (id, rate_card_id, version, effective_from, created_by) VALUES ('v1', 'rc_t', 1, '2026-11-01', 't')`;
    await sql`INSERT INTO rate_card_rates (version_id, key, label, unit, price, currency) VALUES ('v1', 'cpu', 'Compute', 'vCPU-hour', '0.034', 'USD')`;
    await refused(sql`UPDATE rate_card_rates SET price = '1'`, /append-only/);
    await refused(
      sql`INSERT INTO rate_card_versions (id, rate_card_id, version, effective_from, created_by) VALUES ('v2x', 'rc_t', 2, '2026-12-01', 't')`,
      /conflicting key value violates exclusion constraint/,
    );
    await refused(sql`UPDATE rate_card_versions SET note = 'x' WHERE id = 'v1'`, /only gets an end date/);
    await sql`UPDATE rate_card_versions SET effective_to = '2026-12-01' WHERE id = 'v1'`;
    await sql`INSERT INTO rate_card_versions (id, rate_card_id, version, effective_from, created_by) VALUES ('v2', 'rc_t', 2, '2026-12-01', 't')`;
    await refused(
      sql`UPDATE rate_card_versions SET effective_to = '2027-01-01' WHERE id = 'v1'`,
      /only gets an end date/,
    );
    const [p] = await sql`SELECT price FROM rate_card_rates WHERE version_id = 'v1'`;
    expect(p!.price).toBe('0.034');
  });

  it('moves periods forward only, and a locked period freezes its allocations', async () => {
    await sql`INSERT INTO periods (month) VALUES ('2026-10-01'), ('2026-11-01')`;
    await insertRecord('rec_oct', '2026-10-05T00:00:00Z');
    const alloc = (id: string, month: string, rec: string, start: string) => sql`
      INSERT INTO allocations (id, cost_record_id, charge_period_start, period_month, pl_class, weight, amount_minor, currency)
      VALUES (${id}, ${rec}, ${start}, ${month}, 'rnd', 1, 2482, 'USD')`;
    await alloc('a_oct', '2026-10-01', 'rec_oct', '2026-10-05T00:00:00Z');
    await refused(sql`UPDATE periods SET status = 'locked' WHERE month = '2026-10-01'`, /check constraint/);
    await sql`UPDATE periods SET status = 'locked', locked_by = 'cfo', locked_at = now() WHERE month = '2026-10-01'`;
    await refused(sql`UPDATE periods SET status = 'open' WHERE month = '2026-10-01'`, /locked/);
    await refused(sql`DELETE FROM periods WHERE month = '2026-10-01'`, /never deleted/);
    await refused(sql`DELETE FROM allocations WHERE id = 'a_oct'`, /locked/);
    await refused(alloc('a_oct2', '2026-10-01', 'rec_oct', '2026-10-05T00:00:00Z'), /locked/);
    await sql`UPDATE periods SET status = 'closing' WHERE month = '2026-11-01'`;
    await refused(sql`UPDATE periods SET status = 'open' WHERE month = '2026-11-01'`, /only moves forward/);
    await alloc('a_nov', '2026-11-01', 'rec_1', '2026-11-10T00:00:00Z');
    await sql`DELETE FROM allocations WHERE id = 'a_nov'`; // open (closing) periods are rebuilt
  });

  it('refuses an API key with an unknown scope or no scope', async () => {
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
