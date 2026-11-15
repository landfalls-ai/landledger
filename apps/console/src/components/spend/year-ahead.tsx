import type { ForecastView } from '@landledger/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { StatePill } from '@/components/spend/bits';
import { Card } from '@/components/ui/card';
import { get, quiet } from '@/lib/api';
import { monthLabel, usd } from '@/lib/format';

/**
 * The year ahead (spec 006): each month's run rate with its P10–P90 band, what approved requests reserve and commit
 * beyond their reservations, against its budget. A month with no budget says so; it is never on track (decision 8).
 */
export function YearAhead({ months = 12 }: { months?: number }) {
  const q = useQuery({
    queryKey: ['forecast', months],
    queryFn: () => get<ForecastView>(`/api/forecast?months=${months}`),
    retry: quiet,
  });
  const f = q.data;
  if (!f) return null;
  const a = f.annualised;
  return (
    <Card
      title="The year ahead"
      sub={
        f.status === 'ok'
          ? 'Run rate × days, its P10–P90 band, plus what approved requests reserve and commit beyond it, and contracts'
          : 'Not enough data yet for a run rate: reservations, commitments and contracts only'
      }
      testId="year-ahead"
    >
      <ul>
        {f.months.map((m) => (
          <li
            key={m.month}
            className="border-t border-hair px-4 py-2.5 first:border-t-0"
            data-testid={`ahead-${m.month}`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-t1">{monthLabel(m.month)}</span>
              <span className="figure whitespace-nowrap font-medium">
                {m.total ? usd(m.total, { whole: true }) : '—'}
                {m.budget && <span className="text-t3"> of {usd(m.budget, { whole: true })}</span>}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12px] text-t3">
              <span className="figure">
                {m.runRate
                  ? `${usd(m.runRate.p10, { whole: true })}–${usd(m.runRate.p90, { whole: true })} run rate`
                  : 'No run rate yet'}
                {m.reserved !== '0.000000' && ` · ${usd(m.reserved, { whole: true })} reserved`}
                {m.committed !== '0.000000' && ` · ${usd(m.committed, { whole: true })} committed`}
                {m.contracted !== '0.000000' && ` · ${usd(m.contracted, { whole: true })} contracted`}
              </span>
              <StatePill state={m.state} />
            </div>
          </li>
        ))}
        <li className="border-t border-hair px-4 py-3" data-testid="annualised">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-t1">Annualised</span>
            <span className="figure whitespace-nowrap font-medium">
              {a.runRate ? usd(a.runRate.p50, { whole: true }) : 'Not enough data yet'}
            </span>
          </div>
          <small className="block text-[12px] text-t3">
            {a.runRate &&
              `Today’s run rate × 365, ${usd(a.runRate.p10, { whole: true })}–${usd(a.runRate.p90, { whole: true })} · `}
            {usd(a.commitments, { whole: true })} over the next 12 months of approved monthly requests (
            {f.commitments.length}) · {usd(a.contracted, { whole: true })} under contract
            {a.total && ` · ${usd(a.total, { whole: true })} in all`}
            {a.budget && ` · ${usd(a.budget, { whole: true })} budgeted in these months`}
          </small>
          {f.commitments.length > 0 && (
            <ul className="mt-1.5 text-[12px] text-t2">
              {f.commitments.slice(0, 5).map((c) => (
                <li key={c.requestId}>
                  <Link className="underline decoration-hair underline-offset-2" to={`/approvals/${c.requestId}`}>
                    {c.number}
                  </Link>{' '}
                  {c.title} · <span className="figure">{usd(c.monthly)}</span> a month ·{' '}
                  {c.reservedThrough ? `reserved through ${monthLabel(c.reservedThrough)}` : 'nothing reserved'}
                </li>
              ))}
            </ul>
          )}
        </li>
      </ul>
    </Card>
  );
}
