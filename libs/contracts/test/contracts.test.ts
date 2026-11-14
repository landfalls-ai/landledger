import { describe, expect, it } from 'vitest';
import { ApiKeyInput, MoneyJson, ROLE_BY_GROUP, Role, SCOPES_BY_ROLE } from '../src/index.js';

describe('roles', () => {
  it('map the six Landbright finance groups and nothing else', () => {
    expect(ROLE_BY_GROUP).toEqual({
      'Finance CFO': 'cfo',
      'Finance Controllers': 'controller',
      'Finance FP&A': 'fpa',
      'Budget Owners': 'budget_owner',
      'Landledger Auditors': 'auditor',
      Engineering: 'engineer',
    });
    expect(ROLE_BY_GROUP['Everyone']).toBeUndefined();
  });

  it('give every role read, and only the CFO and controllers admin', () => {
    for (const role of Role.options) expect(SCOPES_BY_ROLE[role]).toContain('read');
    const admins = Role.options.filter((r) => SCOPES_BY_ROLE[r].includes('admin'));
    expect(admins.sort()).toEqual(['cfo', 'controller']);
    expect(SCOPES_BY_ROLE.auditor).toEqual(['read']);
  });
});

describe('wire values', () => {
  it('carry money as minor-unit strings', () => {
    expect(MoneyJson.safeParse({ amountMinor: '-1250', currency: 'USD' }).success).toBe(true);
    expect(MoneyJson.safeParse({ amountMinor: 12.5, currency: 'USD' }).success).toBe(false);
    expect(MoneyJson.safeParse({ amountMinor: '12.5', currency: 'usd' }).success).toBe(false);
  });

  it('need a name and at least one known scope for a key', () => {
    expect(ApiKeyInput.safeParse({ name: 'ingest', scopes: ['ingest'] }).success).toBe(true);
    expect(ApiKeyInput.safeParse({ name: 'x', scopes: [] }).success).toBe(false);
    expect(ApiKeyInput.safeParse({ name: 'x', scopes: ['decide'] }).success).toBe(false);
  });
});
