/** Spec 008, pure: the keep, scale, review or retire suggestion, first rule that holds, with its rule in words. */
import { Money } from '@landledger/money';
import { describe, expect, it } from 'vitest';
import { suggest } from '../src/agents.js';

const usd = (a: string) => Money.parse(a, 'USD');
const base = { runs: 20, outcomes: 12, successRate: 0.95, cost: usd('10'), value: usd('600') };

describe('the agent suggestion', () => {
  it('scales an agent with 10 or more outcomes worth 5 × its cost or more, 90% succeeding', () => {
    expect(suggest(base)).toMatchObject({ suggestion: 'scale', why: expect.stringMatching(/^Scale: 12 outcomes/) });
    expect(suggest({ ...base, value: usd('49.99') }).suggestion).toBe('keep'); // under 5 × cost
    expect(suggest({ ...base, successRate: 0.85 }).suggestion).toBe('keep');
  });

  it('retires one that runs and achieves nothing', () => {
    expect(suggest({ ...base, outcomes: 0, value: usd('0') })).toMatchObject({
      suggestion: 'retire',
      why: 'Retire: 20 runs this month and no outcome (rule: 10 or more runs, none)',
    });
    expect(suggest({ ...base, runs: 9, outcomes: 0, value: usd('0') }).suggestion).toBe('keep'); // too few to say
  });

  it('reviews one whose outcomes cost more than they are worth, or that fails too often', () => {
    expect(suggest({ ...base, cost: usd('700') }).suggestion).toBe('review');
    expect(suggest({ ...base, successRate: 0.5 })).toMatchObject({
      suggestion: 'review',
      why: 'Review: 50% of 20 runs succeeded (rule: under 80% of 5 or more)',
    });
    expect(suggest({ ...base, runs: 3, outcomes: 1, successRate: 0.33 }).suggestion).toBe('keep');
  });

  it('keeps one Clickland knows nothing of, and says so', () => {
    expect(suggest({ runs: null, outcomes: null, successRate: null, cost: usd('5'), value: null })).toMatchObject({
      suggestion: 'keep',
      why: expect.stringMatching(/no match in Clickland/),
    });
  });
});
