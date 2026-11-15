/** Spec 011, pure parts: the quarter a day falls in, and who may attest. */
import { describe, expect, it } from 'vitest';
import { canAttest, quarterOf } from '../src/access-review.js';
import type { Principal } from '../src/principal.js';

const person = (roles: Principal['roles'], kind: Principal['kind'] = 'person'): Principal => ({
  kind,
  id: 'usr_1',
  name: 'Someone',
  email: null,
  roles,
  groups: [],
  scopes: ['read', 'admin'],
});

describe('the access review', () => {
  it('names the quarter of a day in UTC', () => {
    expect(quarterOf(new Date('2026-01-01T00:00:00Z'))).toBe('2026-Q1');
    expect(quarterOf(new Date('2026-03-31T23:59:59Z'))).toBe('2026-Q1');
    expect(quarterOf(new Date('2026-04-01T00:00:00Z'))).toBe('2026-Q2');
    expect(quarterOf(new Date('2026-11-16T10:00:00Z'))).toBe('2026-Q4');
  });

  it('is attested by the controller or the CFO, signed in; never an auditor, a budget owner, a key or the developer', () => {
    expect(canAttest(person(['controller']))).toBe(true);
    expect(canAttest(person(['cfo']))).toBe(true);
    expect(canAttest(person(['auditor']))).toBe(false);
    expect(canAttest(person(['budget_owner', 'engineer']))).toBe(false);
    expect(canAttest(person(['controller'], 'key'))).toBe(false);
    expect(canAttest(person(['controller'], 'dev'))).toBe(false);
  });
});
