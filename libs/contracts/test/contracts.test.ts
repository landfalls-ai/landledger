import { describe, expect, it } from 'vitest';
import { toWire } from '@landledger/focus';
import { aiInputRow } from '@landledger/focus/testing';
import { Money } from '@landledger/money';
import {
  ApiKeyInput,
  CostRecord,
  MoneyJson,
  Period,
  RecordsQuery,
  ROLE_BY_GROUP,
  Role,
  SCOPES_BY_ROLE,
} from '../src/index.js';

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
    expect(MoneyJson.safeParse({ amount: '-0.003100', currency: 'USD' }).success).toBe(true);
    expect(MoneyJson.safeParse(JSON.parse(JSON.stringify(Money.parse('7.2', 'USD')))).success).toBe(true);
    expect(MoneyJson.safeParse({ amount: 12.5, currency: 'USD' }).success).toBe(false);
    expect(MoneyJson.safeParse({ amount: '12.5', currency: 'usd' }).success).toBe(false);
    expect(MoneyJson.safeParse({ amount: '0.0000001', currency: 'USD' }).success).toBe(false);
    expect(MoneyJson.safeParse({ amount: '+1', currency: 'USD' }).success).toBe(false);
  });

  it('need a name and at least one known scope for a key', () => {
    expect(ApiKeyInput.safeParse({ name: 'ingest', scopes: ['ingest'] }).success).toBe(true);
    expect(ApiKeyInput.safeParse({ name: 'x', scopes: [] }).success).toBe(false);
    expect(ApiKeyInput.safeParse({ name: 'x', scopes: ['decide'] }).success).toBe(false);
  });
});

describe('cost records and periods on the wire (spec 001)', () => {
  it('takes a record as libs/focus writes it, with amounts as strings', () => {
    const wire = JSON.parse(JSON.stringify(toWire(aiInputRow())));
    expect(CostRecord.parse(wire)).toEqual(wire);
    expect(CostRecord.safeParse({ ...wire, EffectiveCost: 7.2 }).success).toBe(false);
    expect(CostRecord.safeParse({ ...wire, PricingQuantity: '2.4e0' }).success).toBe(false);
    expect(CostRecord.safeParse({ ...wire, ChargePeriodStart: '2026-11-13' }).success).toBe(false);
    expect(CostRecord.safeParse({ ...wire, x_Extra: 'no' }).success).toBe(false);
  });

  it('reads periods and record queries', () => {
    expect(Period.shape.status.options).toEqual(['open', 'closing', 'locked']);
    expect(RecordsQuery.parse({ month: '2026-11', limit: '50' })).toMatchObject({ month: '2026-11', limit: 50 });
    expect(RecordsQuery.safeParse({ month: '2026-13' }).success).toBe(false);
    expect(RecordsQuery.parse({}).limit).toBe(100);
  });
});
