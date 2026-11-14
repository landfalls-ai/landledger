import type { RequestDetail, RequestLifecycle, RequestView } from '@landledger/contracts';
import { useQuery } from '@tanstack/react-query';
import { Card, CardBody } from '@/components/ui/card';
import { get, quiet } from '@/lib/api';
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

const SUGGESTION_WORD = { scale: 'Scale', keep: 'Keep', review: 'Review', retire: 'Retire' } as const;

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
            ['Outcomes', e.outcomes === null ? '—' : String(e.outcomes)],
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
