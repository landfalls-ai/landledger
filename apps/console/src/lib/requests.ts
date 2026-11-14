import {
  REQUEST_KIND_LABEL,
  type Requester,
  type RequestBox,
  type RequestsList,
  type RequestStatus,
  type RequestSummary,
} from '@landledger/contracts';
import { Decimal } from '@landledger/money';
import { useQuery } from '@tanstack/react-query';
import type { PillTone } from '@/components/ui/pill';
import { get, quiet } from './api';
import { usd } from './format';

/** One box of the inbox (`waiting`, `mine`, `decided`, …), with the counts of every box. */
export function useRequests(box: RequestBox, enabled = true) {
  return useQuery({
    queryKey: ['requests', box],
    queryFn: () => get<RequestsList>(`/api/requests?box=${box}&limit=200`),
    retry: quiet,
    enabled,
    refetchInterval: 30_000,
  });
}

/** Requests waiting on the signed-in person, for the sidebar's and the bottom bar's count (0 while unknown). */
export function useWaitingCount(): number {
  return useRequests('waiting').data?.counts.waiting ?? 0;
}

export const kindLabel = (k: keyof typeof REQUEST_KIND_LABEL) => REQUEST_KIND_LABEL[k];

/** `a month` or `once`, after an amount. */
export const perLabel = (r: { recurrence: 'monthly' | 'once' }) => (r.recurrence === 'monthly' ? 'a month' : 'once');

/** `$1,840` for whole dollars, `$1,840.50` otherwise. */
export const amountWords = (amount: string): string => usd(amount).replace(/\.00$/, '');

/** Who asked, in words: a person's name, or an agent's name and its sponsor. */
export function askedBy(r: Requester): { name: string; agent: boolean; sponsor: string | null } {
  return r.kind === 'agent'
    ? { name: r.agent.name, agent: true, sponsor: r.sponsor.name }
    : { name: r.person.name, agent: false, sponsor: null };
}

const ENDED: Partial<Record<RequestStatus, PillTone>> = {
  approved: 'ok',
  applied: 'ok',
  rejected: 'over',
  expired: 'over',
  cancelled: 'nu',
};

/** The step pill: a pending step is amber when it waits on you, grey otherwise; an ended request by its outcome. */
export function stepTone(r: Pick<RequestSummary, 'status'>, mine: boolean): PillTone {
  if (r.status === 'pending' || r.status === 'awaiting_confirmation') return mine ? 'risk' : 'nu';
  return ENDED[r.status] ?? 'nu';
}

/** How long ago, short: `12m`, `5h`, `3d`. */
export function age(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** `14 Nov, 10:42 GMT+2`: in the browser's time zone, which it names (review of wave 2: every time says its zone). */
export const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

/** The default thresholds' tier for an amount (docs/approvals.md): 0 automatic, 1 budget owner, 2 Finance, 3 CFO. */
export function tierOf(thresholdAmount: string): number {
  const a = Decimal.parse(thresholdAmount);
  if (a.compare('500') < 0) return 0;
  if (a.compare('5000') <= 0) return 1;
  if (a.compare('25000') <= 0) return 2;
  return 3;
}

export const TIERS = [
  ['Automatic', 'under $500'],
  ['Budget owner', 'to $5,000'],
  ['Finance', 'to $25,000'],
  ['CFO', 'above'],
] as const;
