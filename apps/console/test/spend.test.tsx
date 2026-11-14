import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { change, usd } from '../src/lib/format';
import { ME, mockApi, renderAt } from './render';

afterEach(() => vi.unstubAllGlobals());

const cc = (code: string, name: string, mtd: string, budget: string | null, forecast: string, state: string) => ({
  code,
  name,
  owner: null,
  monthToDate: mtd,
  invoiced: '0.000000',
  budget,
  forecast,
  reserved: '0.000000',
  state,
});

const OVERVIEW = {
  month: '2026-11',
  today: '2026-11-14',
  dayOfMonth: 14,
  daysInMonth: 30,
  currency: 'USD',
  monthToDate: { total: '3.520000', estimated: '3.520000', invoiced: '0.000000', provisional: '3.520000' },
  forecast: {
    amount: '345.760000',
    low: '294.420000',
    high: '397.090000',
    basis: 'Run rate',
    perDay: { low: '18', mid: '21', high: '24' },
  },
  budget: { amount: '323.010000', version: 1, source: 'csv', importedAt: '2026-11-14T19:00:00.000Z' },
  leftAfterReservations: '319.490000',
  reserved: '0.000000',
  burn: [
    { day: '2026-11-13', actual: '0.000000', forecast: null, low: null, high: null },
    { day: '2026-11-14', actual: '3.520000', forecast: '3.520000', low: '3.520000', high: '3.520000' },
    { day: '2026-11-15', actual: null, forecast: '25.000000', low: '20.000000', high: '30.000000' },
  ],
  costCenters: [
    cc('SHARED-POOL', 'Shared pool', '2.510000', '200.000000', '246.180000', 'risk'),
    cc('CS-SUPPORT', 'Customer Support', '0.008600', '0.005000', '0.850000', 'over'),
  ],
  byCategory: [{ key: 'Compute', label: 'Compute', amount: '3.060000', invoiced: '0.000000' }],
  byPlClass: [{ key: 'rnd', label: 'R&D', amount: '0.950000', invoiced: '0.000000' }],
  attribution: {
    direct: '0.980000',
    sharedPool: '2.510000',
    unallocated: '0.030000',
    total: '3.520000',
    directShare: '27.9',
  },
  runs: [
    {
      source: 'clickland',
      day: '2026-11-14',
      finishedAt: '2026-11-14T19:00:00.000Z',
      outcome: 'succeeded',
      warnings: ['x'],
    },
  ],
  rateCard: { version: 1, status: 'approved', approvedBy: 'yoav.bendavid@landbright.test' },
};

const group = (key: string, label: string, total: string, share: string, extra: object = {}) => ({
  key,
  label,
  sub: key,
  estimated: total,
  invoiced: '0.000000',
  total,
  previous: null,
  share,
  provisional: total,
  clicklandUrl: null,
  ...extra,
});

const spend = (by: string, groups: ReturnType<typeof group>[], filters: object[] = []) => ({
  from: '2026-11-01',
  to: '2026-11-14',
  by,
  layer: 'direct',
  filters,
  currency: 'USD',
  total: { estimated: '3.520000', invoiced: '0.000000', total: '3.520000', provisional: '3.520000', previous: null },
  groups,
  daily: { days: ['2026-11-14'], series: groups.map((g) => ({ key: g.key, label: g.label, values: [g.total] })) },
  attribution: OVERVIEW.attribution,
  drill: by === 'costCenter' ? 'service' : 'resource',
  warnings: [],
});

describe('formatting', () => {
  it('keeps small costs visible and exact', () => {
    expect(usd('3.520000')).toBe('$3.52');
    expect(usd('0.008600')).toBe('$0.0086');
    expect(usd('0.000000')).toBe('$0.00');
    expect(usd('-12.345000')).toBe('-$12.35');
    expect(usd(null)).toBe('—');
    expect(change('1.5', '1.0')).toBe('50.0');
    expect(change('1', null)).toBeNull();
  });
});

describe('Overview', () => {
  it('shows the four figures, the cost centers with their state, and where the figures come from', async () => {
    mockApi({ '/api/auth/me': [200, ME], '/api/overview': [200, OVERVIEW] });
    renderAt('/overview');
    expect(await screen.findByTestId('overview')).toBeInTheDocument();
    expect(within(screen.getByTestId('stat-mtd')).getAllByText('$3.52').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('stat-forecast')).getByText('$22.75 over')).toBeInTheDocument();
    expect(within(screen.getByTestId('stat-budget')).getByText('$323.01')).toBeInTheDocument();
    const table = screen.getByTestId('cost-centers');
    expect(within(table).getAllByText('Shared pool').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Over').length).toBeGreaterThan(0);
    expect(screen.getByText('27.9% attributed to a cost center')).toBeInTheDocument();
    expect(screen.getByText('Approved by yoav.bendavid@landbright.test')).toBeInTheDocument();
  });
});

describe('Explore', () => {
  it('groups by cost center, then drills into a row by service', async () => {
    const fetchMock = mockApi({
      '/api/auth/me': [200, ME],
      '/api/spend': [
        200,
        spend('costCenter', [
          group('SHARED-POOL', 'Shared pool', '2.510000', '71.3'),
          group('ENG-AGENTS', 'AI Agents', '0.500000', '14.2'),
        ]),
      ],
    });
    renderAt('/explore');
    const table = await screen.findByTestId('groups');
    expect(within(table).getAllByText('its own row').length).toBeGreaterThan(0);
    mockApi({
      '/api/auth/me': [200, ME],
      '/api/spend': [
        200,
        spend(
          'service',
          [
            group('landflow-cache-npm', 'landflow-cache-npm', '0.110000', '100.0', {
              clicklandUrl: 'http://localhost:4711/services/landflow-cache-npm',
            }),
          ],
          [{ dimension: 'costCenter', value: 'ENG-AGENTS' }],
        ),
      ],
    });
    await userEvent.click(within(table).getAllByRole('button', { name: /AI Agents/ })[0]!);
    expect((await screen.findAllByText('Open in Clickland')).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalled();
    const last = (vi.mocked(fetch).mock.calls.at(-1)![0] as string).toString();
    expect(last).toContain('by=service');
    expect(last).toContain('filter=costCenter%3AENG-AGENTS');
  });
});

describe('Budgets', () => {
  it('shows budget against actual and opens a row for its months', async () => {
    const row = {
      ...cc('CS-SUPPORT', 'Customer Support', '0.008600', '0.005000', '0.850000', 'over'),
      available: '-0.003600',
      variance: '0.845000',
      variancePct: '16900.0',
      months: [{ month: '2026-10', budget: null, actual: '0.000000', locked: false }],
    };
    mockApi({
      '/api/auth/me': [200, ME],
      '/api/budgets': [
        200,
        {
          month: '2026-11',
          currency: 'USD',
          version: {
            version: 1,
            source: 'csv',
            fileName: 'budgets-2026-11.dev.csv',
            importedAt: '2026-11-14T19:00:00.000Z',
            importedBy: 'seed',
            origin: 'dev-seed',
            note: '',
          },
          rows: [row],
          totals: {
            budget: '0.005000',
            actual: '0.008600',
            reserved: '0.000000',
            available: '-0.003600',
            forecast: '0.850000',
            variance: '0.845000',
            variancePct: '16900.0',
            state: 'over',
          },
        },
      ],
    });
    renderAt('/budgets');
    const card = await screen.findByTestId('budget-table');
    expect(within(card).getAllByText('dev seed').length).toBeGreaterThan(0);
    await userEvent.click(within(card).getAllByRole('button', { name: /Customer Support/ })[0]!);
    expect((await screen.findAllByText(/Nothing is reserved/)).length).toBeGreaterThan(0);
  });
});
