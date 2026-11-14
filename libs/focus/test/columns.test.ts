import { describe, expect, it } from 'vitest';
import { ADDITIVE_COLUMNS, COLUMNS, columnOf, CUSTOM_COLUMNS, DROPPED_COLUMNS, FOCUS_COLUMNS } from '../src/index.js';

describe('the column catalogue (T007)', () => {
  it('keeps 45 of the 65 FOCUS 1.4 cost-and-usage columns and says why for the other 20', () => {
    expect(FOCUS_COLUMNS).toHaveLength(45);
    expect(Object.keys(DROPPED_COLUMNS)).toHaveLength(20);
    for (const name of Object.keys(DROPPED_COLUMNS)) expect(columnOf(name)).toBeUndefined();
  });

  it('has unique FOCUS names and unique snake-case table columns', () => {
    expect(new Set(COLUMNS.map((c) => c.name)).size).toBe(COLUMNS.length);
    expect(new Set(COLUMNS.map((c) => c.column)).size).toBe(COLUMNS.length);
    for (const c of COLUMNS) expect(c.column).toMatch(/^[a-z][a-z0-9_]*$/);
    for (const c of FOCUS_COLUMNS) expect(c.name).toMatch(/^[A-Z][A-Za-z]*$/);
  });

  it('names custom columns by the FOCUS rule: x_, Pascal case, alphanumeric, ≤ 50 characters, Id suffix', () => {
    // custom_column_handling.md:23-31
    for (const c of CUSTOM_COLUMNS) {
      expect(c.name).toMatch(/^x_[A-Z][A-Za-z0-9]*$/);
      expect(c.name.length).toBeLessThanOrEqual(50);
      expect(c.level).toBe('Custom');
      if (c.name.endsWith('ID')) throw new Error(`${c.name}: Id, not ID`);
    }
    expect(CUSTOM_COLUMNS.map((c) => c.name)).toEqual(
      expect.arrayContaining(['x_RecordId', 'x_IngestRunId', 'x_SourceKey', 'x_CorrectionOfId', 'x_SourceCost']),
    );
    expect(columnOf('x_IngestRun')).toBeUndefined();
  });

  it('stores amounts in micro-units and negates exactly the additive columns', () => {
    expect(columnOf('BilledCost')).toMatchObject({ column: 'billed_cost_micros', storage: 'micros', nullable: false });
    expect(columnOf('EffectiveCost')?.column).toBe('effective_cost_micros');
    expect(ADDITIVE_COLUMNS).toEqual([
      'BilledCost',
      'EffectiveCost',
      'ListCost',
      'ContractedCost',
      'PricingQuantity',
      'ConsumedQuantity',
      'x_SourceCost',
    ]);
  });
});
