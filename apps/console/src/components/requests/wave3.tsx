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
