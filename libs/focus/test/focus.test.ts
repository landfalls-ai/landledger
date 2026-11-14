import { describe, expect, it } from 'vitest';
import { BASES, columnFor, EXTENSION_COLUMNS, FOCUS_COLUMNS } from '../src/index.js';

describe('the FOCUS columns', () => {
  it('map to unique snake_case columns', () => {
    const all = [...FOCUS_COLUMNS, ...EXTENSION_COLUMNS];
    expect(new Set(all.map((c) => c.column)).size).toBe(all.length);
    for (const c of all) expect(c.column).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('keep extensions under the x_ prefix', () => {
    for (const c of EXTENSION_COLUMNS) {
      expect(c.focus.startsWith('x_')).toBe(true);
      expect(c.column.startsWith('x_')).toBe(true);
    }
  });

  it('name the money columns in minor units and the basis values', () => {
    expect(columnFor('BilledCost')).toBe('billed_cost_minor');
    expect(columnFor('x_Basis')).toBe('x_basis');
    expect(columnFor('Nope')).toBeUndefined();
    expect(BASES).toEqual(['estimated', 'invoiced']);
  });
});
