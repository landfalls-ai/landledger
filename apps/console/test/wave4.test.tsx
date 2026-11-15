import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ME, mockApi, renderAt } from './render';

afterEach(() => vi.unstubAllGlobals());

const REQUESTS = { requests: [], counts: { waiting: 0, mine: 0, decided: 0 } };
const TITLES = [
  ['usage_ingested', 'Usage ingested to the last day'],
  ['reconciled', 'Reconciled within tolerance'],
  ['unallocated', 'Unallocated spend under its limit'],
  ['no_dev_rows', 'No dev-fixture or dev-anomaly rows'],
  ['no_open_anomalies', 'No open anomalies'],
  ['no_outstanding_revokes', 'No outstanding access-review revokes'],
  ['accrual_accepted', 'Accrual accepted'],
  ['notes_accepted', 'Variance notes accepted'],
  ['datarails_uploaded', 'Datarails upload done'],
  ['locked', 'Period locked'],
] as const;

const step = (i: number, state: string, extra: Record<string, unknown> = {}) => ({
  number: i + 1,
  key: TITLES[i]![0],
  title: TITLES[i]![1],
  state,
  summary: `${TITLES[i]![1]}: ${state}`,
  problems: state === 'red' ? ['Something to fix'] : [],
  by: null,
  at: null,
  explainable: i !== 3 && i !== 9,
  explanations: [],
  ...extra,
});

const CLOSING = {
  month: '2026-10',
  status: 'closing',
  reopened: false,
  round: 0,
  ended: true,
  dryRun: false,
  steps: [
    step(0, 'done'),
    step(1, 'red', {
      rows: [
        {
          key: 'Anthropic|claude-sonnet-4-5',
          provider: 'Anthropic',
          model: 'claude-sonnet-4-5',
          status: 'no_invoice',
          estimated: '12.000000',
          invoiced: '0.000000',
          variancePct: null,
          ok: false,
          explained: false,
        },
      ],
    }),
    ...[2, 3, 4, 5].map((i) => step(i, 'done')),
    ...[6, 7, 8, 9].map((i) => step(i, 'waiting')),
  ],
  done: 5,
  next: 'reconciled',
  snapshot: null,
  signoffs: [],
  locks: [],
  reopens: [],
  pendingReopen: null,
  unallocatedLimitPct: '5',
};

const LOCKED = {
  ...CLOSING,
  status: 'locked',
  steps: TITLES.map((_, i) => step(i, 'done')),
  done: 10,
  next: null,
  snapshot: {
    id: 'snp_1',
    sha256: 'a'.repeat(64),
    frozenAt: '2026-11-15T10:00:00.000Z',
    frozenBy: 'Yoav',
    current: true,
  },
  locks: [
    {
      round: 0,
      at: '2026-11-15T11:00:00.000Z',
      signoffs: [
        {
          person: { id: 'usr_1', name: 'Yoav Ben David', email: null },
          role: 'controller',
          at: '2026-11-15T10:50:00.000Z',
        },
        { person: { id: 'usr_2', name: 'Dana Shalev', email: null }, role: 'cfo', at: '2026-11-15T11:00:00.000Z' },
      ],
      auditSeq: 41,
      auditHash: 'b'.repeat(64),
      anchor: { seq: 42, hash: 'c'.repeat(64), at: '2026-11-15T11:00:01.000Z' },
      snapshotSha256: 'a'.repeat(64),
    },
  ],
};

describe('Month-end (spec 012)', () => {
  it('shows the checklist in order and lets a controller explain one reconciliation row', async () => {
    const fetchMock = mockApi({
      '/api/auth/me': [200, ME],
      '/api/close': [200, CLOSING],
      '/api/requests': [200, REQUESTS],
      '/api/close/2026-10/explain': [200, CLOSING],
    });
    renderAt('/close?month=2026-10');
    const list = await screen.findByTestId('checklist');
    expect(
      within(list)
        .getAllByRole('listitem')
        .filter((li) => li.dataset.testid?.startsWith('step-')),
    ).toHaveLength(10);
    expect(screen.getByTestId('state-reconciled')).toHaveTextContent('Red');
    expect(screen.getByTestId('state-accrual_accepted')).toHaveTextContent('Waiting');
    expect(screen.getByTestId('close-done')).toHaveTextContent('5 of 10');
    await userEvent.click(await screen.findByTestId('explain-reconciled-Anthropic|claude-sonnet-4-5'));
    await userEvent.type(screen.getByLabelText('Explanation'), 'Anthropic invoices October on 3 December');
    await userEvent.click(screen.getByRole('button', { name: 'Explain' }));
    const call = fetchMock.mock.calls.find(([p]) => String(p).endsWith('/explain'));
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      step: 'reconciled',
      rowKey: 'Anthropic|claude-sonnet-4-5',
      note: 'Anthropic invoices October on 3 December',
    });
  });

  it('shows a locked month’s signatures and its anchor, and lets a controller ask to reopen', async () => {
    mockApi({ '/api/auth/me': [200, ME], '/api/close': [200, LOCKED], '/api/requests': [200, REQUESTS] });
    renderAt('/close?month=2026-10');
    const lock = await screen.findByTestId('lock-0');
    expect(lock).toHaveTextContent('Yoav Ben David (controller) and Dana Shalev (CFO)');
    expect(lock).toHaveTextContent('c'.repeat(64));
    expect(screen.getByRole('button', { name: 'Ask to reopen' })).toBeDisabled();
    expect(screen.queryByTestId('sign-lock')).not.toBeInTheDocument();
  });

  it('offers the controller a signature once steps 1–9 are done, and says who signs next', async () => {
    const ready = {
      ...LOCKED,
      status: 'closing',
      locks: [],
      steps: TITLES.map((_, i) => step(i, i === 9 ? 'red' : 'done')),
    };
    mockApi({ '/api/auth/me': [200, ME], '/api/close': [200, ready], '/api/requests': [200, REQUESTS] });
    renderAt('/close?month=2026-10');
    expect(await screen.findByTestId('sign-lock')).toHaveTextContent('Sign the lock as a controller');
  });

  it('is a dry run for a month still open: nothing to act on', async () => {
    const dry = { ...CLOSING, month: '2026-11', status: 'open', ended: false, dryRun: true };
    mockApi({ '/api/auth/me': [200, ME], '/api/close': [200, dry], '/api/requests': [200, REQUESTS] });
    renderAt('/close?month=2026-11');
    expect(await screen.findByText('Open · dry run')).toBeInTheDocument();
    expect(screen.queryByTestId('start-close')).not.toBeInTheDocument();
    expect(screen.queryByText('Explain…')).not.toBeInTheDocument();
  });
});

const NOTE = (sponsorId: string) => ({
  id: 'vn_1',
  month: '2026-10',
  costCenter: 'TOTAL',
  name: 'October 2026',
  status: 'drafted',
  accepted: null,
  current: true,
  versions: [
    {
      version: 1,
      text: 'Spend was $12.00 against no budget.',
      cites: [{ figure: 'actual', amount: '12.000000' }],
      kind: 'draft',
      by: 'landflow notes',
      agent: { id: 'agt_1', name: 'Variance writer', system: 'landflow' },
      sponsor: { id: sponsorId, name: 'Someone', email: null },
      at: '2026-11-15T10:00:00.000Z',
      snapshotSha256: 'a'.repeat(64),
      decision: null,
    },
  ],
});
const NOTES = (sponsorId: string) => ({
  month: '2026-10',
  snapshotSha256: 'a'.repeat(64),
  requestedAt: '2026-11-15T09:00:00.000Z',
  needed: [
    {
      costCenter: 'TOTAL',
      name: 'October 2026',
      actual: '12.000000',
      budget: null,
      forecastDay10: null,
      varianceBudget: null,
      varianceBudgetPct: null,
      varianceForecast: null,
      drivers: [],
    },
  ],
  notes: [NOTE(sponsorId)],
});

describe('Variance notes (spec 015)', () => {
  it('lets an analyst who is not the sponsor accept a draft, and shows what it cites', async () => {
    mockApi({ '/api/auth/me': [200, ME], '/api/notes': [200, NOTES('usr_9')], '/api/requests': [200, REQUESTS] });
    renderAt('/close/notes?month=2026-10');
    const card = await screen.findByTestId('note-TOTAL');
    expect(card).toHaveTextContent('Variance writer (landflow)');
    expect(card).toHaveTextContent('Cites actual $12.00');
    expect(within(card).getByTestId('accept-note-TOTAL')).toBeInTheDocument();
  });

  it('never offers the sponsor the decision', async () => {
    mockApi({ '/api/auth/me': [200, ME], '/api/notes': [200, NOTES('usr_1')], '/api/requests': [200, REQUESTS] });
    renderAt('/close/notes?month=2026-10');
    const card = await screen.findByTestId('note-TOTAL');
    expect(within(card).queryByTestId('accept-note-TOTAL')).not.toBeInTheDocument();
    expect(card).toHaveTextContent('another analyst decides');
  });
});

describe('Datarails (spec 017)', () => {
  it('shows the fake on this machine, the month’s upload and a pending budget pull', async () => {
    mockApi({
      '/api/auth/me': [200, ME],
      '/api/requests': [200, REQUESTS],
      '/api/datarails': [
        200,
        {
          mcpUrl: 'http://127.0.0.1:4819/mcp',
          uploadUrl: 'http://127.0.0.1:4819/api/v1/fileboxes/upload_file',
          filebox: 'landledger',
          loopback: true,
          real: false,
          configured: true,
          uploads: [
            {
              id: 'dru_1',
              month: '2026-10',
              snapshotSha256: 'a'.repeat(64),
              files: [{ name: 'landledger-actuals-2026-10.csv', sha256: 'd'.repeat(64), rows: 7, bytes: 900 }],
              ok: true,
              status: 200,
              response: { upload_id: 'up_1' },
              uploadedBy: 'Yoav',
              uploadedAt: '2026-11-15T10:00:00.000Z',
            },
          ],
          pulls: [
            {
              id: 'drp_1',
              status: 'pending',
              dataModel: 'dm_budget_fy27',
              rows: 28,
              months: ['2026-12'],
              total: '1000.000000',
              sha256: 'e'.repeat(64),
              pulledBy: 'Yoav',
              pulledAt: '2026-11-15T10:00:00.000Z',
              decidedBy: null,
              decidedAt: null,
              budgetVersion: null,
              reason: null,
              preview: [{ costCenter: 'ENG-AGENTS', month: '2026-12', amount: '1000.000000', current: null }],
            },
          ],
        },
      ],
    });
    renderAt('/close/datarails?month=2026-10');
    expect(await screen.findByText('This machine')).toBeInTheDocument();
    expect(screen.getByTestId('uploads')).toHaveTextContent('landledger-actuals-2026-10.csv (7 rows)');
    expect(screen.getByTestId('pull-status-drp_1')).toHaveTextContent('Pending');
    expect(screen.getByTestId('accept-pull')).toBeInTheDocument();
  });
});
