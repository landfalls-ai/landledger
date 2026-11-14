import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoicedShare } from '../src/lib/format';
import { ME, mockApi, renderAt } from './render';

afterEach(() => vi.unstubAllGlobals());

const RECONCILIATION = {
  month: '2026-11',
  currency: 'USD',
  tolerancePct: '2',
  rows: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      month: '2026-11',
      estimated: '13.500000',
      invoiced: '22.500000',
      variance: '9.000000',
      variancePct: '66.7',
      status: 'outside',
      invoices: ['DEV-ANT-2026-11-0042'],
    },
    {
      provider: 'ollama',
      model: 'qwen3-coder:30b',
      month: '2026-11',
      estimated: '0.000000',
      invoiced: '0.000000',
      variance: '0.000000',
      variancePct: null,
      status: 'matched',
      invoices: ['DEV-OLLAMA-2026-11'],
    },
  ],
  totals: {
    estimated: '13.500000',
    invoiced: '22.500000',
    variance: '9.000000',
    variancePct: '66.7',
    invoicedShare: '71',
    within: false,
  },
  invoices: [
    {
      id: 'inv_1',
      provider: 'Anthropic',
      number: 'DEV-ANT-2026-11-0042',
      month: '2026-11',
      version: 1,
      status: 'posted',
      origin: 'dev-fixture',
      total: '23.500000',
      lines: [],
      posted: { added: 9, reversed: 0, unchanged: 0, linkedEstimates: 6 },
      correction: false,
      importedBy: 'yoav.bendavid@landbright.test',
      importedAt: '2026-11-15T10:00:00.000Z',
      note: '',
      fileSha256: 'x',
    },
  ],
};

describe('Reconciliation (spec 005)', () => {
  it('shows each provider and model against its invoice, the share invoiced, and lets a controller import', async () => {
    mockApi({
      '/api/auth/me': [200, ME],
      '/api/reconciliation': [200, RECONCILIATION],
      '/api/requests': [200, { requests: [], counts: { waiting: 0, mine: 0, decided: 0 } }],
    });
    renderAt('/reconciliation?month=2026-11');
    const table = await screen.findByTestId('reconciliation-table');
    expect(within(table).getAllByText('claude-sonnet-4-5').length).toBeGreaterThan(0);
    expect(within(table).getAllByTestId('status-claude-sonnet-4-5')[0]).toHaveTextContent('Outside tolerance');
    expect(within(table).getAllByTestId('status-qwen3-coder:30b')[0]).toHaveTextContent('Within tolerance');
    expect(screen.getByText('71%')).toBeInTheDocument();
    expect(within(screen.getByTestId('invoices')).getByText('dev fixture')).toBeInTheDocument();
    expect(await screen.findByText('Import an invoice')).toBeInTheDocument();
  });

  it('hides import and void from someone who is neither the controller nor the CFO', async () => {
    mockApi({
      '/api/auth/me': [200, { ...ME, user: { ...ME.user, roles: ['engineer'] } }],
      '/api/reconciliation': [200, RECONCILIATION],
      '/api/requests': [200, { requests: [], counts: { waiting: 0, mine: 0, decided: 0 } }],
    });
    renderAt('/reconciliation?month=2026-11');
    await screen.findByTestId('reconciliation-table');
    expect(screen.queryByText('Import an invoice')).toBeNull();
    expect(screen.queryByText('Void…')).toBeNull();
  });

  it('says how much of a mixed total is invoiced', () => {
    expect(invoicedShare('71', '100')).toBe(71);
    expect(invoicedShare('0', '0')).toBe(0);
    expect(invoicedShare('5', '0')).toBe(100);
  });
});

const FORECAST = {
  from: '2026-11',
  status: 'ok',
  basis: 'Run rate over the last 7 days',
  months: [
    {
      month: '2026-11',
      days: 30,
      runRate: { p10: '200.000000', p50: '240.000000', p90: '280.000000' },
      actual: '100.000000',
      reserved: '60.000000',
      committed: '0.000000',
      total: '400.000000',
      budget: '500.000000',
      state: 'ok',
    },
    {
      month: '2027-02',
      days: 28,
      runRate: { p10: '400.000000', p50: '448.000000', p90: '496.000000' },
      actual: '0.000000',
      reserved: '0.000000',
      committed: '120.000000',
      total: '568.000000',
      budget: null,
      state: 'none',
    },
  ],
  annualised: {
    runRate: { p10: '5000.000000', p50: '5840.000000', p90: '6700.000000' },
    commitments: '1440.000000',
    total: '968.000000',
    budget: '500.000000',
  },
  commitments: [
    {
      requestId: 'req_9',
      number: 'R-9',
      title: 'A bigger node',
      costCenter: 'ENG-AGENTS',
      monthly: '120.000000',
      reservedThrough: '2027-01',
    },
  ],
};

describe('The year ahead (spec 006)', () => {
  it('shows each month with its band, reserved and committed, says "No budget" where there is none, and annualises', async () => {
    const { YearAhead } = await import('../src/components/spend/year-ahead');
    const { render } = await import('@testing-library/react');
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { MemoryRouter } = await import('react-router');
    mockApi({ '/api/forecast': [200, FORECAST] });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <YearAhead />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const feb = await screen.findByTestId('ahead-2027-02');
    expect(feb).toHaveTextContent('$400.00–$496.00 run rate');
    expect(feb).toHaveTextContent('$120.00 committed');
    expect(feb).toHaveTextContent('No budget');
    expect(screen.getByTestId('ahead-2026-11')).toHaveTextContent('On track');
    expect(screen.getByTestId('ahead-2026-11')).toHaveTextContent('$60.00 reserved');
    const a = screen.getByTestId('annualised');
    expect(a).toHaveTextContent('$5,840');
    expect(a).toHaveTextContent('$1,440 a year of approved monthly requests (1)');
    expect(within(a).getByText('R-9')).toBeInTheDocument();
  });
});

const anomaly = (over: object) => ({
  id: 'anm_1',
  kind: 'cost',
  rule: 'cost_jump',
  dimension: 'agent',
  key: 'ag_1',
  label: 'Triage lead',
  windowStart: '2026-11-16T00:00:00.000Z',
  windowEnd: '2026-11-17T00:00:00.000Z',
  summary: 'Triage lead cost $45.00 so far today, against a median of $0.00 a day over the 11 observed days before',
  observed: '45.000000',
  baseline: '0.000000',
  mad: '0.000000',
  score: null,
  costCenter: null,
  requests: [],
  detectedAt: '2026-11-16T10:00:00.000Z',
  acknowledged: null,
  dev: false,
  ...over,
});

describe('Anomalies (spec 007)', () => {
  it('lists cost and approval anomalies, marks a dev test, and lets a person acknowledge with a note', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const fetchMock = mockApi({
      '/api/auth/me': [200, ME],
      '/api/anomalies': [
        200,
        {
          anomalies: [
            anomaly({}),
            anomaly({
              id: 'anm_2',
              dimension: 'service',
              key: 'landledger-dev-anomaly',
              label: 'landledger-dev-anomaly',
              dev: true,
            }),
            anomaly({
              id: 'anm_3',
              kind: 'approval',
              rule: 'split',
              dimension: 'requester',
              label: 'Tal Levi on ENG-AGENTS',
              summary: 'Tal Levi raised 4 infra change requests on ENG-AGENTS within 72 hours',
              observed: '570.000000',
              requests: [{ id: 'req_1', number: 'R-7', title: 'Runner node A' }],
            }),
          ],
        },
      ],
      '/api/anomalies/anm_1/acknowledge': [
        200,
        anomaly({ acknowledged: { by: 'x', at: '2026-11-16T11:00:00.000Z', note: 'ok' } }),
      ],
      '/api/requests': [200, { requests: [], counts: { waiting: 0, mine: 0, decided: 0 } }],
    });
    renderAt('/anomalies');
    const cost = await screen.findByTestId('cost-anomalies');
    expect(within(cost).getAllByText('Cost jump').length).toBe(2);
    expect(within(screen.getByTestId('anomaly-anm_2')).getByText('dev test')).toBeInTheDocument();
    const approval = screen.getByTestId('approval-anomalies');
    expect(within(approval).getByText('Split under the threshold')).toBeInTheDocument();
    expect(within(approval).getByRole('link', { name: /R-7 Runner node A/ })).toHaveAttribute(
      'href',
      '/approvals/req_1',
    );
    await userEvent.click(screen.getByTestId('ack-anm_1'));
    await userEvent.type(screen.getByLabelText('Note'), 'The backfill');
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    const [, init] = fetchMock.mock.calls.find(([p]) => p === '/api/anomalies/anm_1/acknowledge')!;
    expect(JSON.parse(String(init!.body))).toEqual({ note: 'The backfill' });
  });
});
