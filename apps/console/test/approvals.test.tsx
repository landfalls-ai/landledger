import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionWords } from '../src/routes/audit';
import { whenWords } from '../src/routes/proposals';
import { ME, mockApi, renderAt } from './render';

afterEach(() => vi.unstubAllGlobals());

const person = (id: string, name: string, email: string) => ({ id, name, email, sub: `sub-${id}` });
const TAL = person('usr_tal', 'Tal Levi', 'tal.levi@landbright.test');
const SHIRA = person('usr_shira', 'Shira Navon', 'shira.navon@landbright.test');
const SHA = 'a'.repeat(64);

const step = (position: number, key: string, label: string, status: string, groups: string[], people = [SHIRA]) => ({
  position,
  key,
  label,
  status,
  approvers: { groups, costCenterOwner: null, people },
  deadlineAt: status === 'pending' ? '2026-11-17T10:00:00.000Z' : null,
  escalatedAt: null,
  escalatedTo: [],
  decision: null,
});

const request = (you: object, status = 'pending') => ({
  id: 'req_1',
  number: 'R-1',
  kind: 'infra_change',
  title: 'Two more GPU nodes for inference',
  note: 'Latency is over target at peak.',
  status,
  costCenter: { code: 'ENG-PLATFORM', name: 'Platform', owner: 'Shira Navon' },
  amount: { amount: '1840.000000', currency: 'USD' },
  recurrence: 'monthly',
  start: '2026-11-16',
  end: null,
  thresholdAmount: '1840.000000',
  evidence: { lines: [{ label: '2 × g5.xlarge', amount: '1840.00' }], basis: 'Usage × rate card v1' },
  origin: { type: 'console' },
  related: [],
  requester: { kind: 'person', person: TAL },
  createdVia: 'session',
  createdByKey: null,
  change: null,
  automatic: false,
  policy: { id: 'pol_infra_change_1', version: 1, reason: '$1,840 a month is in the budget owner’s range.' },
  steps: [
    step(1, 'budget_owner', 'Budget owner', 'pending', ['Budget Owners']),
    step(2, 'finance', 'Finance', 'waiting', ['Finance Controllers', 'Finance CFO'], []),
  ],
  currentStep: 1,
  decisions: [],
  reservations: [],
  createdAt: '2026-11-16T09:00:00.000Z',
  submittedAt: '2026-11-16T09:00:00.000Z',
  decidedAt: null,
  appliedAt: null,
  you: { isRequester: false, isSponsor: false, canDecide: true, reason: null, canCancel: false, ...you },
});

const evidence = {
  month: '2026-11',
  currency: 'USD',
  adds: '920.000000',
  budget: '20000.000000',
  actual: '9000.000000',
  reserved: '0.000000',
  leftNow: '11000.000000',
  leftAfter: '10080.000000',
  forecastNow: null,
  forecastWith: null,
  stateNow: 'ok',
  stateWith: 'ok',
  rateCard: { version: 1, effectiveFrom: '2026-11-01', approvedBy: 'Yoav Ben David' },
  similar: [],
  why: '$1,840 a month: the budget owner decides.',
};

const summary = {
  ...request({}),
  stepLabel: 'Step 1 of 2 · Budget owner',
  stepCount: 2,
  budgetLeftAfter: '10080.000000',
};

describe('Approvals', () => {
  it('lists what waits on you, what you raised and what was decided, with the tiers', async () => {
    mockApi({
      '/api/auth/me': [200, ME],
      '/api/requests': [200, { requests: [summary], counts: { waiting: 1, mine: 0, decided: 0, open: 1 } }],
      '/api/exceptions': [
        200,
        { from: '2026-10', to: '2026-11', currency: 'USD', generatedAt: '', rows: [], unowned: [] },
      ],
    });
    renderAt('/approvals');
    const waiting = await screen.findByTestId('box-waiting');
    expect(await within(waiting).findAllByText('Two more GPU nodes for inference')).not.toHaveLength(0);
    expect(within(waiting).getAllByText('Step 1 of 2 · Budget owner').length).toBeGreaterThan(0);
    expect(screen.getByText('Who decides what')).toBeInTheDocument();
    expect(screen.getByText('Spend no request covers')).toBeInTheDocument();
    // The count on the nav comes from the API.
    await waitFor(() => expect(screen.getAllByLabelText('1 waiting').length).toBeGreaterThan(0));
  });
});

describe('a request', () => {
  it('shows the evidence and the path, and approves with the evidence hash and step', async () => {
    const fetchMock = mockApi({
      '/api/auth/me': [200, ME],
      '/api/requests/req_1': [200, { request: request({}), evidence, evidenceSha256: SHA }],
      '/api/requests/req_1/decisions': [201, {}],
    });
    renderAt('/approvals/req_1');
    await screen.findByText('Two more GPU nodes for inference');
    expect(within(screen.getByTestId('evidence')).getByText('2 × g5.xlarge')).toBeInTheDocument();
    expect(within(screen.getByTestId('path')).getByText('Now')).toBeInTheDocument();
    expect(screen.getByText('Deciding as Yoav Ben David')).toBeInTheDocument();

    // Reject needs a comment.
    await userEvent.click(screen.getByTestId('reject'));
    expect(screen.getByRole('alert')).toHaveTextContent('Say why');

    await userEvent.click(screen.getByTestId('approve'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([p, init]) => p === '/api/requests/req_1/decisions' && init?.method === 'POST'),
      ).toBe(true),
    );
    const [, init] = fetchMock.mock.calls.find(([p]) => p === '/api/requests/req_1/decisions')!;
    expect(JSON.parse(String(init!.body))).toEqual({ outcome: 'approve', comment: '', evidenceSha256: SHA, step: 1 });
  });

  it('tells the requester they can’t decide their own request, and who has it', async () => {
    mockApi({
      '/api/auth/me': [200, ME],
      '/api/requests/req_1': [
        200,
        {
          request: request({ isRequester: true, canDecide: false, reason: 'You raised this request' }),
          evidence,
          evidenceSha256: SHA,
        },
      ],
    });
    renderAt('/approvals/req_1');
    const msg = await screen.findByTestId('cannot-decide');
    expect(msg).toHaveTextContent('You raised this request, so you can’t decide it.');
    expect(msg).toHaveTextContent('Budget Owners');
    expect(screen.queryByTestId('approve')).toBeNull();
  });
});

describe('words', () => {
  it('says audit actions and policy conditions in words', () => {
    expect(actionWords('request.decided')).toBe('Request decided');
    expect(actionWords('rate_card.version_approved')).toBe('Rate card version approved');
    const base = {
      key: 'finance',
      label: 'Finance',
      approvers: { groups: ['Finance Controllers'], costCenterOwner: false },
    };
    expect(whenWords({ ...base, when: { amountAbove: '5000', costCenterAtRisk: true } })).toBe(
      'above $5,000, or when at risk or over',
    );
    expect(whenWords({ ...base, when: { always: true } })).toBe('Always');
  });
});
