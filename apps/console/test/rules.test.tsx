import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unitPrice, unitWords } from '../src/routes/rules';
import { ME, mockApi, renderAt } from './render';

afterEach(() => vi.unstubAllGlobals());

const line = (key: string, label: string, unit: string, price: string, details: object | null = null) => ({
  id: `rl_internal_1_${key}`,
  skuId: `landledger:k8s:${key}`,
  skuPriceId: `landledger:k8s:${key}`,
  skuMeter: label,
  label,
  provider: null,
  model: null,
  pricingUnit: unit,
  unitPrice: price,
  currency: 'USD',
  details,
});

const version = {
  id: 'rcv_internal_1',
  version: 1,
  status: 'proposed',
  effectiveFrom: '2026-11-01',
  effectiveTo: null,
  hoursPerMonth: '730',
  note: 'Rate card v1',
  proposedBy: 'seed',
  proposedAt: '2026-11-14T10:00:00.000Z',
  approvedBy: null,
  approvedAt: null,
  lines: [
    line('cpu', 'Compute', 'Core-Hours', '0.034'),
    line('memory', 'Memory', 'GiB-Hours', '0.0045'),
    line('storage', 'Storage', 'GB-Months', '0.10'),
    line('egress', 'Network egress', 'GB', '0.02', { Applied: false }),
  ],
};

describe('Rates and rules', () => {
  it('reads the rate card and the cost centers from the API', async () => {
    mockApi({
      '/api/auth/me': [200, ME],
      '/api/rate-cards': [
        200,
        {
          rateCards: [
            {
              id: 'rc_internal',
              name: 'Internal',
              currency: 'USD',
              owner: 'Finance',
              current: null,
              versions: [version],
            },
          ],
        },
      ],
      '/api/cost-centers': [
        200,
        {
          costCenters: [
            {
              code: 'ENG-PLATFORM',
              version: 1,
              name: 'Platform',
              description: '',
              ownerName: 'Dana Levi',
              ownerSubject: null,
              validFrom: '2026-11-01',
              validTo: null,
              origin: 'dev-seed',
            },
          ],
        },
      ],
    });
    renderAt('/rules');
    const card = await screen.findByTestId('rate-card');
    expect(await within(card).findByRole('heading', { name: /^Rate card v1/ })).toBeInTheDocument();
    expect(within(card).getByText(/Proposed for 1 Nov 2026; waits for a person/)).toBeInTheDocument();
    expect(within(card).getByText('Proposed')).toBeInTheDocument();
    expect(within(card).getAllByText(/per core-hour/).length).toBeGreaterThan(0);
    expect(within(card).getAllByText(/not applied yet/).length).toBeGreaterThan(0);
    for (const price of ['$0.034', '$0.0045', '$0.10', '$0.02'])
      expect(within(card).getAllByText(price).length).toBeGreaterThan(0);
    const ccs = screen.getByTestId('cost-centers');
    expect(await within(ccs).findAllByText('ENG-PLATFORM')).not.toHaveLength(0);
    expect(within(ccs).getAllByText('dev seed').length).toBeGreaterThan(0);
    expect(within(ccs).getByText(/Development seed data/)).toBeInTheDocument();
  });

  it('prints unit prices exactly, keeping every digit', () => {
    expect(unitPrice({ unitPrice: '0.0045', currency: 'USD' })).toBe('$0.0045');
    expect(unitPrice({ unitPrice: '0.1', currency: 'USD' })).toBe('$0.10');
    expect(unitPrice({ unitPrice: '1250.5', currency: 'EUR' })).toBe('EUR 1,250.50');
    expect(unitWords('1000000 Tokens')).toBe('million tokens');
    expect(unitWords('Widget-Days')).toBe('Widget-Days');
  });
});
