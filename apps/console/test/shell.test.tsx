import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ME, mockApi, renderAt } from './render';

afterEach(() => vi.unstubAllGlobals());

describe('the shell', () => {
  it('has the sidebar groups and screens of docs/ui.md, in order', async () => {
    mockApi({ '/api/auth/me': [200, ME] });
    renderAt('/overview');
    await screen.findByTestId('nav-Money');
    const groups = ['Money', 'Control', 'Value', 'Close', 'Setup'].map((g) =>
      within(screen.getByTestId(`nav-${g}`))
        .getAllByRole('link')
        .map((a) => a.textContent),
    );
    expect(groups).toEqual([
      ['Overview', 'Explore', 'Budgets', 'Reconciliation'],
      ['Approvals', 'Anomalies', 'Contracts'],
      ['Agents'],
      ['Month-end'],
      ['Rates and rules', 'Access review', 'Audit log'],
    ]);
    expect(screen.getAllByText('Yoav Ben David').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Finance · controller').length).toBeGreaterThan(0);
  });

  it('puts Overview, Explore, Approvals and More on the phone’s bottom bar; More holds the rest by group', async () => {
    mockApi({ '/api/auth/me': [200, ME] });
    renderAt('/overview');
    const bar = await screen.findByTestId('bottom-bar');
    expect(
      within(bar)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Overview', 'Explore', 'Approvals']);
    await userEvent.click(within(bar).getByRole('button', { name: 'More' }));
    const sheet = screen.getByRole('dialog', { name: 'More screens' });
    expect(
      within(sheet)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual([
      'Budgets',
      'Reconciliation',
      'Anomalies',
      'Contracts',
      'Agents',
      'Month-end',
      'Rates and rules',
      'Access review',
      'Audit log',
      'Yoav Ben DavidFinance · controller',
    ]);
    // The person's row opens their profile (Link Slack).
    expect(within(sheet).getByTitle('Your profile and Link Slack')).toHaveAttribute('href', '/profile');
    expect(within(sheet).getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
  });

  it('switches the theme', async () => {
    mockApi({ '/api/auth/me': [200, ME] });
    renderAt('/overview');
    await screen.findByTestId('nav-Money');
    await userEvent.click(screen.getAllByRole('radio', { name: 'Dark theme' })[0]!);
    expect(document.documentElement.dataset.theme).toBe('dark');
    await userEvent.click(screen.getAllByRole('radio', { name: 'System theme' })[0]!);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('has every screen built by wave 4: Month-end and its tabs, titled by the nav', async () => {
    mockApi({ '/api/auth/me': [200, ME] });
    renderAt('/close/accruals?month=2026-10');
    expect(await screen.findByTestId('accruals-page')).toBeInTheDocument();
    expect(screen.queryByTestId('placeholder')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Month-end' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Month-end' })).getAllByRole('link')).toHaveLength(5);
  });
});

describe('sign-in', () => {
  it('offers “Sign in with Landbright” to someone not signed in', async () => {
    mockApi({
      '/api/auth/me': [401, { error: { code: 'unauthorized', message: 'Sign in', details: { signIn: 'available' } } }],
    });
    renderAt('/rules');
    const button = await screen.findByRole('button', { name: 'Sign in with Landbright' });
    expect(button).toBeEnabled();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, pathname: '/rules', search: '' });
    await userEvent.click(button);
    expect(assign).toHaveBeenCalledWith('/api/auth/login?returnTo=%2Frules');
  });

  it('says why a sign-in came back without a session', async () => {
    mockApi({
      '/api/auth/me': [401, { error: { code: 'unauthorized', message: 'Sign in', details: { signIn: 'available' } } }],
    });
    renderAt('/?signin_error=no_role');
    expect(await screen.findByRole('alert')).toHaveTextContent(/isn’t in a Landledger group/);
  });

  it('disables sign-in, and says why, before Landbright’s client exists', async () => {
    mockApi({
      '/api/auth/me': [
        401,
        {
          error: {
            code: 'unauthorized',
            message: 'Sign in',
            details: { signIn: 'unavailable', problem: 'No client secret' },
          },
        },
      ],
    });
    renderAt('/');
    expect(await screen.findByRole('button', { name: 'Sign in with Landbright' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('No client secret');
  });
});
