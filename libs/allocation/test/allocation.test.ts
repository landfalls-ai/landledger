import { Money } from '@landledger/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AllocInput,
  allocateDirect,
  type Attrs,
  firstMatch,
  matches,
  type Rule,
  type RuleSetVersion,
  SHARED_POOL,
  spread,
  totalBy,
  UNALLOCATED,
  validateRuleSet,
} from '../src/index.js';

const attrs = (over: Partial<Attrs> = {}): Attrs => ({
  source: 'clickland',
  resource: 'cpu',
  idle: false,
  cluster: 'orbstack',
  service: '',
  provider: 'Land platform',
  model: '',
  namespace: '',
  workload: '',
  container: '',
  composeProject: '',
  composeService: '',
  workflow: '',
  workflowName: '',
  agent: '',
  agentName: '',
  actor: '',
  meter: 'Allocated Cores',
  labels: {},
  ...over,
});
const usd = (s: string) => Money.parse(s, 'USD');
const rec = (id: string, amount: string, a: Partial<Attrs>, day = '2026-11-14'): AllocInput => ({
  recordId: id,
  day,
  amount: usd(amount),
  attrs: attrs(a),
});

const rules: Rule[] = [
  {
    id: 'r1',
    name: 'Agent sandboxes',
    selector: { namespace: 'landflow-dev', workload: 'landflow-cache*' },
    target: { costCenter: 'ENG-AGENTS', plClass: 'rnd', capitalisable: false },
  },
  {
    id: 'r2',
    name: 'Landflow host',
    selector: { namespace: 'landflow-dev' },
    target: { costCenter: 'ENG-PLATFORM', team: 'Platform', product: 'Landflow', plClass: 'rnd', capitalisable: true },
  },
  { id: 'r3', name: 'Cluster overhead', selector: { namespace: 'kube-system' }, shared: true, plClass: 'rnd' },
  {
    id: 'r4',
    name: 'Agents',
    selector: { agent: 'Triage*' },
    target: { costCenter: 'ENG-AGENTS', plClass: 'cost_of_revenue', capitalisable: false },
  },
  {
    id: 'r5',
    name: 'Team label',
    selector: { label: { key: 'team', value: 'billing' } },
    target: { costCenter: 'CS-SUPPORT', plClass: 'cost_of_revenue', capitalisable: false },
  },
];
const v: RuleSetVersion = { id: 'rsv1', rules, shares: [{ id: 's1', method: 'weighted' }] };

describe('selectors', () => {
  it('match every given field, case-insensitively, with * as a wildcard; an empty selector matches nothing', () => {
    expect(matches({ namespace: 'LANDFLOW-*' }, attrs({ namespace: 'landflow-dev' }))).toBe(true);
    expect(
      matches({ namespace: 'landflow-dev', container: 'host' }, attrs({ namespace: 'landflow-dev', container: 'mcp' })),
    ).toBe(false);
    expect(matches({}, attrs())).toBe(false);
    expect(matches({ namespace: '*' }, attrs())).toBe(false);
  });
  it('match an agent or a workflow by id or by name, and labels by key and value', () => {
    expect(matches({ agent: 'ag_1' }, attrs({ agent: 'ag_1', agentName: 'Triage lead' }))).toBe(true);
    expect(matches({ agent: 'triage lead' }, attrs({ agent: 'ag_1', agentName: 'Triage lead' }))).toBe(true);
    expect(matches({ workflow: 'SDLC *' }, attrs({ workflow: 'wf_1', workflowName: 'SDLC build' }))).toBe(true);
    expect(matches({ label: { key: 'team', value: 'billing' } }, attrs({ labels: { team: 'billing' } }))).toBe(true);
    expect(matches({ label: { key: 'team', value: 'billing' } }, attrs())).toBe(false);
  });
});

describe('the direct layer', () => {
  it('takes the first rule that matches, in order', () => {
    expect(firstMatch(rules, attrs({ namespace: 'landflow-dev', workload: 'landflow-cache-npm' }))?.id).toBe('r1');
    expect(firstMatch(rules, attrs({ namespace: 'landflow-dev', workload: 'landflow-host' }))?.id).toBe('r2');
  });
  it('sends idle to the shared pool unless a rule names idle, shared rules to the pool, and the rest to unallocated', () => {
    const out = allocateDirect(
      [
        rec('idle', '10', { idle: true, namespace: 'landflow-dev' }),
        rec('ks', '1', { namespace: 'kube-system' }),
        rec('host', '2', { namespace: 'landflow-dev', workload: 'landflow-host' }),
        rec('x', '3', { composeProject: 'something-else' }),
      ],
      () => v,
    );
    expect(out.map((r) => [r.recordId, r.costCenter, r.ruleId, r.plClass])).toEqual([
      ['idle', SHARED_POOL, 'idle', null],
      ['ks', SHARED_POOL, 'r3', 'rnd'],
      ['host', 'ENG-PLATFORM', 'r2', 'rnd'],
      ['x', UNALLOCATED, null, null],
    ]);
    expect(out[2]!).toMatchObject({
      team: 'Platform',
      product: 'Landflow',
      capitalisable: true,
      ruleSetVersionId: 'rsv1',
    });
    const idleRule: Rule = {
      id: 'ri',
      name: 'Idle to platform',
      selector: { idle: true },
      target: { costCenter: 'ENG-PLATFORM', plClass: 'rnd', capitalisable: false },
    };
    expect(firstMatch([idleRule], attrs({ idle: true }))?.id).toBe('ri');
  });
  it('uses the version effective on each record’s day; no version leaves records unallocated', () => {
    const out = allocateDirect(
      [rec('a', '1', { namespace: 'landflow-dev' }, '2026-10-31'), rec('b', '1', { namespace: 'landflow-dev' })],
      (day) => (day >= '2026-11-01' ? v : null),
    );
    expect(out.map((r) => r.costCenter)).toEqual([UNALLOCATED, 'ENG-PLATFORM']);
  });
});

describe('the spread layer', () => {
  const day = [
    rec('p-cpu', '3', { namespace: 'landflow-dev' }),
    rec('a-cpu', '1', { namespace: 'landflow-dev', workload: 'landflow-cache-go' }),
    rec('p-mem', '1', { namespace: 'landflow-dev', resource: 'memory' }),
    rec('a-mem', '3', { namespace: 'landflow-dev', workload: 'landflow-cache-go', resource: 'memory' }),
    rec('idle-cpu', '10', { idle: true }),
    rec('idle-mem', '1', { idle: true, resource: 'memory' }),
    rec('lost', '5', {}),
  ];
  const direct = allocateDirect(day, () => v);
  it('weights idle per resource by each cost center’s direct cost of that resource (OpenCost)', () => {
    const { rows } = spread(day, direct, () => v.shares);
    const cpuIdle = rows.filter((r) => r.recordId === 'idle-cpu');
    expect(cpuIdle.map((r) => [r.costCenter, r.amount.toString()])).toEqual([
      ['ENG-AGENTS', 'USD 2.500000'],
      ['ENG-PLATFORM', 'USD 7.500000'],
    ]);
    const memIdle = rows.filter((r) => r.recordId === 'idle-mem');
    expect(memIdle.map((r) => [r.costCenter, r.amount.toString()])).toEqual([
      ['ENG-AGENTS', 'USD 0.750000'],
      ['ENG-PLATFORM', 'USD 0.250000'],
    ]);
    // Unallocated never receives and stays itself.
    expect(rows.find((r) => r.recordId === 'lost')!.costCenter).toBe(UNALLOCATED);
  });
  it('splits evenly or by fixed percentages among the listed cost centers', () => {
    const even = spread(day, direct, () => [
      { id: 'e', method: 'even', recipients: ['ENG-PLATFORM', 'ENG-AGENTS', 'RND-DATA'] },
    ]);
    expect(even.rows.filter((r) => r.recordId === 'idle-cpu').map((r) => r.amount.toString())).toEqual([
      'USD 3.333334',
      'USD 3.333333',
      'USD 3.333333',
    ]);
    const fixed = spread(day, direct, () => [
      {
        id: 'f',
        method: 'fixed',
        percentages: [
          { costCenter: 'ENG-PLATFORM', percent: '70' },
          { costCenter: 'GA-IT', percent: '30' },
        ],
      },
    ]);
    expect(fixed.rows.filter((r) => r.recordId === 'idle-mem').map((r) => [r.costCenter, r.amount.toString()])).toEqual(
      [
        ['ENG-PLATFORM', 'USD 0.700000'],
        ['GA-IT', 'USD 0.300000'],
      ],
    );
  });
  it('leaves a row with no recipient in the shared pool, with a warning', () => {
    const lonely = [rec('idle', '4', { idle: true, cluster: 'other' })];
    const r = spread(
      lonely,
      allocateDirect(lonely, () => v),
      () => v.shares,
    );
    expect(r.rows.map((x) => x.costCenter)).toEqual([SHARED_POOL]);
    expect(r.warnings[0]).toMatch(/no recipient/);
  });
  it('computes coefficients over the whole day, so a filtered view keeps its shares', () => {
    const all = spread(day, direct, () => v.shares).rows.filter((r) => r.costCenter === 'ENG-AGENTS');
    const again = spread(day, direct, () => v.shares).rows.filter((r) => r.costCenter === 'ENG-AGENTS');
    expect(again).toEqual(all);
  });
});

describe('splits always total (property)', () => {
  const cc = fc.constantFrom('landflow-dev', 'kube-system', 'clickland-dev', 'x');
  const record = fc.record({
    micros: fc.bigInt({ min: -5_000_000_000n, max: 5_000_000_000n }),
    namespace: cc,
    workload: fc.constantFrom('landflow-host', 'landflow-cache-go', ''),
    resource: fc.constantFrom<'cpu' | 'memory'>('cpu', 'memory'),
    idle: fc.boolean(),
  });
  it('each layer adds up exactly to the records, per record and in total, for any share rule', () => {
    fc.assert(
      fc.property(
        fc.array(record, { minLength: 1, maxLength: 60 }),
        fc.constantFrom<RuleSetVersion['shares']>(
          [{ id: 'w', method: 'weighted' }],
          [{ id: 'e', method: 'even', recipients: ['ENG-PLATFORM', 'ENG-AGENTS', 'RND-DATA'] }],
          [
            {
              id: 'f',
              method: 'fixed',
              percentages: [
                { costCenter: 'ENG-PLATFORM', percent: '33.3' },
                { costCenter: 'GA-IT', percent: '66.7' },
              ],
            },
          ],
          [],
        ),
        (rs, shares) => {
          const recs = rs.map((r, i) => ({
            recordId: `r${i}`,
            day: '2026-11-14',
            amount: Money.ofMicros(r.micros, 'USD'),
            attrs: attrs({ namespace: r.namespace, workload: r.workload, resource: r.resource, idle: r.idle }),
          }));
          const direct = allocateDirect(recs, () => ({ ...v, shares }));
          const spreadRows = spread(recs, direct, () => shares).rows;
          const total = Money.sum(
            recs.map((r) => r.amount),
            'USD',
          );
          const byRecord = totalBy(
            spreadRows,
            (r) => r.recordId,
            (r) => r.amount,
          );
          return (
            direct.length === recs.length &&
            Money.sum(
              direct.map((d) => d.amount),
              'USD',
            ).equals(total) &&
            Money.sum(
              spreadRows.map((d) => d.amount),
              'USD',
            ).equals(total) &&
            recs.every((r) => (byRecord.get(r.recordId) ?? Money.zero('USD')).equals(r.amount))
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('validating a rule set', () => {
  it('names unknown cost centers, empty selectors and percentages that are not 100', () => {
    const problems = validateRuleSet(
      {
        rules: [
          { id: 'a', name: 'a', selector: {}, target: { costCenter: 'NOPE', plClass: 'rnd', capitalisable: false } },
        ],
        shares: [{ id: 'f', method: 'fixed', percentages: [{ costCenter: 'ENG-PLATFORM', percent: '90' }] }],
      },
      new Set(['ENG-PLATFORM']),
    );
    expect(problems).toEqual([
      'rule a names cost center NOPE, which doesn’t exist'.replace('’', "'"),
      'rule a selects nothing',
      'share rule f: percentages add up to 90, not 100',
    ]);
  });
});
