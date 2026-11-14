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
      'allocations',
      'cost_centers',
      'teams',
      'products',
      'rate_cards',
      'rate_card_versions',
      'allocation_rules',
      'fx_rates',
      'budgets',
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

  it('keep money in bigint minor units and never use floats', () => {
    const sql = migrations
      .map((m) => m.sql)
      .join('\n')
      .replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\b(real|double precision|float\d?|money)\b/i);
    for (const col of sql.match(/\b\w+_minor\s+\w+/g) ?? []) expect(col).toMatch(/bigint$/);
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
