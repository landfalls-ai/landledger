/**
 * Spec 008, pure: the suggestion, first rule that holds, with its rule in words. Review of wave 3: "Outcomes not
 * measured" unless Clickland measures the agent's outcomes; no retire under USD 10 a month; retire only when measured
 * and the outcomes cost far more than they are worth (or there are none in 10+ runs).
 */
import { Money } from '@landledger/money';
import { describe, expect, it } from 'vitest';
import { suggest } from '../src/agents.js';

const usd = (a: string) => Money.parse(a, 'USD');
const base = { runs: 20, outcomes: 12, successRate: 0.95, cost: usd('10'), value: usd('600'), measured: true };

describe('the agent suggestion', () => {
  it('scales an agent with 10 or more outcomes worth 5 × its cost or more, 90% succeeding', () => {
    expect(suggest(base)).toMatchObject({
      suggestion: 'scale',
      why: expect.stringMatching(/^Scale: 12 self-reported outcomes/),
    });
    expect(suggest({ ...base, value: usd('49.99') }).suggestion).toBe('keep'); // under 5 × cost
    expect(suggest({ ...base, successRate: 0.85 }).suggestion).toBe('keep');
  });

  it('says outcomes are not measured when Clickland credits none and does not say the agent is instrumented', () => {
    // The live case: a $0 agent with 27 runs and no outcome is not "retire".
    expect(suggest({ ...base, runs: 27, outcomes: 0, cost: usd('0'), value: usd('0'), measured: false })).toMatchObject(
      {
        suggestion: 'not_measured',
        why: expect.stringMatching(/^Outcomes not measured: Clickland credits no outcome to it \(27 runs\)/),
      },
    );
    expect(
      suggest({ ...base, runs: 27, outcomes: 0, cost: usd('900'), value: usd('0'), measured: false }).suggestion,
    ).toBe('not_measured');
  });

  it('retires a measured agent costing $10 or more with no outcome in 10+ runs, or outcomes costing 3 × their worth', () => {
    expect(suggest({ ...base, outcomes: 0, value: usd('0') })).toMatchObject({
      suggestion: 'retire',
      why: 'Retire: 20 runs, $10.00 this month and no outcome, while its outcomes are measured (rule: measured, $10.00 or more, 10 or more runs, none)',
    });
    expect(suggest({ ...base, cost: usd('1800'), value: usd('600') }).suggestion).toBe('retire');
    expect(suggest({ ...base, runs: 9, outcomes: 0, value: usd('0') }).suggestion).toBe('keep'); // too few to say
  });

  it('never retires under $10 a month', () => {
    expect(suggest({ ...base, outcomes: 0, value: usd('0'), cost: usd('9.99') })).toMatchObject({
      suggestion: 'keep',
      why: 'Keep: $9.99 this month, under the $10.00 floor for retiring',
    });
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
    expect(
      suggest({ runs: null, outcomes: null, successRate: null, cost: usd('5'), value: null, measured: false }),
    ).toMatchObject({
      suggestion: 'keep',
      why: expect.stringMatching(/no match in Clickland/),
    });
  });
});
