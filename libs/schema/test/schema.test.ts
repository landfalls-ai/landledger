import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrations } from '../src/index.js';
import { integrationEnabled } from '../src/testing.js';

describe('the shipped migrations', () => {
  const migrations = loadMigrations();

  it('are numbered 0001, 0002, … in order', () => {
    expect(migrations[0]?.name).toBe('0001_core.sql');
    migrations.forEach((m, i) => expect(Number(m.name.slice(0, 4))).toBe(i + 1));
  });

  it('create every core table wave 1 stands on', () => {
    const sql = migrations.map((m) => m.sql).join('\n');
    for (const table of [
      'cost_records',
      'cost_record_keys',
      'provisional_usage',
      'ingest_runs',
      'cost_centers',
      'teams',
      'products',
      'rate_cards',
      'rate_card_versions',
      'rate_lines',
      'fx_rates',
      'periods',
      'audit_log',
      'api_keys',
      'users',
      'groups',
      'sessions',
      'outbox',
    ])
      expect(sql, table).toMatch(new RegExp(`CREATE TABLE ${table} \\(`));
  });

  it('keep money in bigint micro-units and never use floats', () => {
    const sql = migrations
      .map((m) => m.sql)
      .join('\n')
      .replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\b(real|double precision|float\d?|money)\b/i);
    expect(sql).not.toMatch(/_minor\b/);
    const amounts = sql.match(/^ +\w+_micros +\w+/gm) ?? [];
    expect(amounts.length).toBeGreaterThanOrEqual(4);
    for (const col of amounts) expect(col).toMatch(/bigint$/);
  });

  it('name every FOCUS column libs/focus maps, in the table and the view', async () => {
    const { COLUMNS } = await import('@landledger/focus');
    const sql = migrations.map((m) => m.sql).join('\n');
    for (const c of COLUMNS) {
      expect(sql, c.column).toMatch(new RegExp(`\\n  ${c.column}\\s+(text|bigint|numeric|timestamptz|jsonb|char)`));
      expect(sql, c.name).toMatch(new RegExp(`AS "${c.name}"`));
    }
  });
});

describe('loadMigrations', () => {
  it('refuses a gap in the numbering and a bad name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'll-migrations-'));
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '0003_c.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/numbered/);
    const bad = mkdtempSync(join(tmpdir(), 'll-migrations-'));
    writeFileSync(join(bad, '1_a.sql'), 'SELECT 1;');
    expect(() => loadMigrations(bad)).toThrow(/Bad migration name/);
  });
});

describe('integrationEnabled', () => {
  it('reads LANDLEDGER_INTEGRATION as a list', () => {
    expect(integrationEnabled('db', { LANDLEDGER_INTEGRATION: 'db' })).toBe(true);
    expect(integrationEnabled('db', { LANDLEDGER_INTEGRATION: 'oidc, db' })).toBe(true);
    expect(integrationEnabled('db', { LANDLEDGER_INTEGRATION: 'all' })).toBe(true);
    expect(integrationEnabled('db', {})).toBe(false);
  });
});
