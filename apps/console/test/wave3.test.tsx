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
