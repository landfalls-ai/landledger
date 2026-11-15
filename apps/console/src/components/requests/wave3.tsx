import type { RequestDetail, RequestLifecycle, RequestView } from '@landledger/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { get, quiet, send } from '@/lib/api';
import { pct, signed, usd } from '@/lib/format';
import { when } from '@/lib/requests';

/** An approved request from decision to bill (spec 005): approved → reserved → consumed → invoiced, and the variance. */
export function Lifecycle({ r }: { r: RequestView }) {
  const on = r.status === 'approved' || r.status === 'applied';
  const q = useQuery({
    queryKey: ['lifecycle', r.id],
    queryFn: () => get<{ lifecycle: RequestLifecycle | null }>(`/api/requests/${encodeURIComponent(r.id)}/lifecycle`),
    retry: quiet,
    enabled: on,
  });
  const l = q.data?.lifecycle;
  if (!on || !l) return null;
  return (
    <Card title="From approval to invoice" testId="lifecycle">
      <CardBody>
        <ol className="flex flex-col text-[14px]">
          {l.stages.map((s) => (
            <li key={s.key} className="flex justify-between gap-3 border-t border-hair py-[7px] first:border-t-0">
              <span className="min-w-0">
                <span className="font-medium text-t1">{s.label}</span>
                <small className="block text-[12px] text-t3">
                  {s.at ? `${when(s.at)} · ` : ''}
                  {s.note}
                </small>
              </span>
              <span className="figure whitespace-nowrap">{s.amount === null ? '—' : usd(s.amount)}</span>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-[12.5px] text-t3" data-testid="lifecycle-variance">
          Approved to date {usd(l.approvedToDate)}, actual {usd(l.actualToDate)}: {signed(l.variance)}
          {l.variancePct !== null && ` (${pct(l.variancePct, true)})`}. {l.invoicedShare}% of its matched cost is
          invoiced.
        </p>
      </CardBody>
    </Card>
  );
}

export type Evidence = RequestDetail['evidence'];

const SUGGESTION_WORD = {
  scale: 'Scale',
  keep: 'Keep',
  review: 'Review',
  retire: 'Retire',
  not_measured: 'Outcomes not measured',
} as const;

/** An AI budget request's agent (spec 008): its month's cost per outcome, and what the raise buys at that rate. */
export function AgentEconomicsCard({ d }: { d: RequestDetail }) {
  const e = d.evidence.agentEconomics;
  if (!e) return null;
  return (
    <Card title={`What ${e.name} costs per outcome`} testId="agent-economics">
      <CardBody>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[14px] sm:grid-cols-4">
          {[
            ['Cost this month', usd(e.cost)],
            ['Outcomes (self-reported)', e.outcomes === null ? 'not measured' : String(e.outcomes)],
            ['Cost per outcome', e.costPerOutcome ? usd(e.costPerOutcome) : '—'],
            ['Value per outcome', e.valuePerOutcome ? usd(e.valuePerOutcome) : '—'],
          ].map(([label, value]) => (
            <div key={label}>
              <div className="text-[11.5px] text-t3">{label}</div>
              <div className="figure font-medium text-t1">{value}</div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[13px] text-t1" data-testid="agent-buys">
          {e.buys
            ? `At this month’s rate the raise buys about ${e.buys} outcomes a month.`
            : 'No outcomes are known for this agent yet, so what the raise buys can’t be said.'}
        </p>
        <p className="mt-1 text-[12.5px] text-t3">
          {SUGGESTION_WORD[e.suggestion]} — {e.why}. {e.source}.
        </p>
      </CardBody>
    </Card>
  );
}

/** A contract request's terms (spec 009), or a seat request's contract and seats (spec 010). */
export function ContractOrSeatCard({ d }: { d: RequestDetail }) {
  const c = d.request.contract;
  const s = d.evidence.seat;
  if (!c && !s) return null;
  if (c)
    return (
      <Card title="The contract" testId="contract-terms">
        <CardBody>
          <p className="text-[14px] text-t1">
            {c.vendor} · {c.product}: {usd(c.tcv)} over {c.termMonths} months from {c.start}
            {c.seats ? `, ${c.seats} seats` : ''}.
          </p>
          <p className="mt-1 text-[12.5px] text-t3">
            Approved for its total contract value and term. It reserves seats, never money: approval records the
            contract{c.contractId ? ' as a new version of the one it renews' : ''}, renewing after {c.termMonths} months
            with {c.noticeDays} days’ notice.
          </p>
        </CardBody>
      </Card>
    );
  return (
    <Card title={`A seat on ${s!.vendor} ${s!.product}`} testId="seat-evidence">
      <CardBody>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[14px] sm:grid-cols-4">
          {[
            ['Seats paid', String(s!.paid)],
            ['Used · reserved', `${s!.used} · ${s!.reserved}`],
            ['Left now', String(s!.leftNow)],
            ['Left after this', String(s!.leftAfter)],
          ].map(([label, value]) => (
            <div key={label}>
              <div className="text-[11.5px] text-t3">{label}</div>
              <div className="figure font-medium text-t1">{value}</div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[12.5px] text-t3">
          {usd(s!.seatPrice)} a seat a month
          {s!.contractSeatPrice ? ` (the contract works out at ${usd(s!.contractSeatPrice)})` : ''}; renews{' '}
          {s!.renewalDate}.
        </p>
        {s!.note && <p className="mt-1.5 text-[13px] text-warn">{s!.note}.</p>}
        <ReleaseSeat r={d.request} />
      </CardBody>
    </Card>
  );
}

const RELEASE_REASON = {
  access_denied: 'Access was denied in Landbright',
  grant_revoked: 'The grant was revoked',
  not_needed: 'Not needed after all',
} as const;

/**
 * Gives a reserved (or granted, then revoked) seat back to its contract: the requester, the creating key or an admin
 * (POST /api/requests/:id/seats/release). Unapplied seats go back by themselves 30 days after approval.
 */
function ReleaseSeat({ r }: { r: RequestView }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<keyof typeof RELEASE_REASON | null>(null);
  const status = r.seat?.status;
  const release = useMutation({
    mutationFn: () => send('POST', `/api/requests/${encodeURIComponent(r.id)}/seats/release`, { reason }),
    onSuccess: () => {
      setReason(null);
      void qc.invalidateQueries({ queryKey: ['request', r.id] });
      void qc.invalidateQueries({ queryKey: ['requests'] });
    },
  });
  if (status === 'released') return <p className="mt-2 text-[12.5px] text-t3">The seat went back to the contract.</p>;
  if (status !== 'reserved' && status !== 'applied') return null;
  const reasons = (Object.keys(RELEASE_REASON) as (keyof typeof RELEASE_REASON)[]).filter((k) =>
    status === 'applied' ? k === 'grant_revoked' : k !== 'grant_revoked',
  );
  return (
    <div className="mt-2.5 grid gap-1.5" data-testid="release-seat">
      <div className="flex flex-wrap gap-2">
        {reasons.map((k) => (
          <Button key={k} size="sm" variant={reason === k ? 'primary' : undefined} onClick={() => setReason(k)}>
            {RELEASE_REASON[k]}
          </Button>
        ))}
      </div>
      {reason && (
        <div>
          <Button size="sm" variant="primary" disabled={release.isPending} onClick={() => release.mutate()}>
            Release the seat
          </Button>
        </div>
      )}
      {release.isError && <p className="text-[12px] text-rd">{release.error.message}</p>}
    </div>
  );
}
