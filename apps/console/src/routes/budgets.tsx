import type { BudgetLine, BudgetsView, ReservationView } from '@landledger/contracts';
import { Decimal } from '@landledger/money';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { ErrorNote, Lede, StatePill } from '@/components/spend/bits';
import { Card } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Tag } from '@/components/ui/pill';
import { get, quiet } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toTsv } from '@/lib/copy';
import { dayLabel, monthLabel, pct, signed, usd } from '@/lib/format';

const tone = (amount: string | null) => (amount && Decimal.parse(amount).compare('0') > 0 ? 'text-rd' : '');

function Detail({ row, view }: { row: BudgetLine; view: BudgetsView }) {
  return (
    <div className="grid gap-4 px-4 py-3.5 text-[13px] md:grid-cols-3">
      <div>
        <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-t3">Owner and source</h3>
        <div className="font-medium text-t1">{row.owner ?? 'No owner'}</div>
        <small className="text-t3">
          {view.versions.length
            ? view.versions.map((v) => `Budget v${v.version} · ${v.fileName ?? v.source}`).join('; ')
            : 'No budget imported'}
          {view.versions.some((v) => v.origin === 'dev-seed') && ' · development seed data'}
        </small>
      </div>
      <div>
        <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-t3">Months</h3>
        {[
          ...row.months,
          { month: view.month, budget: row.budget, actual: row.forecast ?? row.monthToDate, locked: false },
        ].map((m, i, all) => (
          <div key={m.month} className="flex justify-between gap-3 border-t border-hair py-1.5 first:border-t-0">
            <span className="text-t2">
              {monthLabel(m.month).split(' ')[0]}
              {m.locked ? ' · locked' : i === all.length - 1 ? (row.forecast ? ' · forecast' : ' · to date') : ''}
            </span>
            <span className="figure whitespace-nowrap">
              {usd(m.actual)} of {usd(m.budget)}
            </span>
          </div>
        ))}
      </div>
      <div>
        <h3 className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-t3">Reservations</h3>
        <Reservations code={row.code} month={view.month} />
      </div>
    </div>
  );
}

/** What approved requests hold against a cost center's month (reserved → consumed or released). */
function Reservations({ code, month }: { code: string; month: string }) {
  const q = useQuery({
    queryKey: ['reservations', code, month],
    queryFn: () =>
      get<{ reservations: ReservationView[] }>(
        `/api/reservations?costCenter=${encodeURIComponent(code)}&month=${month}`,
      ),
    retry: quiet,
  });
  const rows = q.data?.reservations ?? [];
  if (q.isLoading) return <span className="text-t3">Loading…</span>;
  if (rows.length === 0) return <span className="text-t3">Nothing is reserved against this budget.</span>;
  return (
    <>
      {rows.map((r) => (
        <div key={r.id} className="flex justify-between gap-3 border-t border-hair py-1.5 first:border-t-0">
          <span className="min-w-0">
            <Link to={`/approvals/${r.requestId}`} className="text-t1 hover:underline">
              {r.requestTitle}
            </Link>
            <small className="block text-t3">
              {r.status}
              {r.status === 'reserved' && r.consumed !== '0.000000' && `, ${usd(r.consumed)} used`}
              {r.note && ` · ${r.note}`}
            </small>
            <small className="block text-t3" data-testid="consumption">
              {r.consumption === 'none'
                ? 'No match selector: real cost never consumes it; held in full until its month ends.'
                : `Consumed by matched cost above ${usd(r.baselineDaily ?? '0')} a day, what already ran before approval.`}
            </small>
          </span>
          <span className="figure whitespace-nowrap">{usd(r.status === 'reserved' ? r.remaining : r.amount)}</span>
        </div>
      ))}
    </>
  );
}

const HEAD = ['Cost center', 'Budget', 'Actual', 'Reserved', 'Available', 'Forecast', 'Variance', 'State'];

/** Budgets (docs/ui.md): budget against actual, per cost center, for the month. */
export function BudgetsPage() {
  const q = useQuery({ queryKey: ['budgets'], queryFn: () => get<BudgetsView>('/api/budgets'), retry: quiet });
  const [open, setOpen] = useState<string | null>(null);
  const v = q.data;
  if (!v) return q.isError ? <ErrorNote error={q.error} /> : <Lede>Loading budgets…</Lede>;
  const t = v.totals;
  const latest = v.versions[0] ?? null;
  const name = (r: BudgetLine) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-left font-medium text-t1"
      aria-expanded={open === r.code}
      onClick={() => setOpen(open === r.code ? null : r.code)}
    >
      <ChevronRight className={cn('size-3.5 text-t3 transition-transform', open === r.code && 'rotate-90')} />
      {r.name}
    </button>
  );
  const sub = (r: BudgetLine) => <span className="block pl-[18px] text-[12px] text-t3">{r.code}</span>;
  const variance = (r: { variance: string | null; variancePct: string | null }) =>
    r.variance === null ? (
      <span className="text-t3">—</span>
    ) : (
      <span className={tone(r.variance)}>{`${signed(r.variance)} · ${pct(r.variancePct, true)}`}</span>
    );
  const cells = (r: BudgetLine) => [
    usd(r.budget),
    usd(r.monthToDate),
    r.reserved === '0.000000' ? <span className="text-t3">—</span> : usd(r.reserved),
    <span className={r.available && r.available.startsWith('-') ? 'text-rd' : ''}>{usd(r.available)}</span>,
    r.forecast === null ? <span className="text-t3">—</span> : usd(r.forecast),
    variance(r),
  ];
  return (
    <div data-testid="budgets">
      <Lede>
        {monthLabel(v.month)} by cost center. Actual is estimated (usage × the rate card) until invoices arrive. All
        figures in USD.
      </Lede>
      <Card
        title={latest ? `Budget ${v.versions.map((i) => `v${i.version}`).join(', ')}` : 'No budget'}
        sub={
          latest ? (
            <>
              From {latest.fileName ?? 'a CSV'}, imported {dayLabel(latest.importedAt.slice(0, 10))} by{' '}
              {latest.importedBy}
              {v.versions.length > 1 &&
                ` (and ${v.versions.length - 1} earlier import${v.versions.length > 2 ? 's' : ''})`}{' '}
              {v.versions.some((i) => i.origin === 'dev-seed') && <Tag dashed>dev seed</Tag>}
            </>
          ) : (
            'Import a CSV of cost center, month, amount and currency'
          )
        }
        action={
          <CopyButton
            tsv={() =>
              toTsv(
                [
                  'Cost center',
                  'Code',
                  'Budget',
                  'Actual',
                  'Reserved',
                  'Available',
                  'Forecast',
                  'Variance',
                  'Variance %',
                  'State',
                ],
                v.rows.map((r) => [
                  r.name,
                  r.code,
                  r.budget ?? '',
                  r.monthToDate,
                  r.reserved,
                  r.available ?? '',
                  r.forecast ?? '',
                  r.variance ?? '',
                  r.variancePct ?? '',
                  r.state,
                ]),
              )
            }
          />
        }
        testId="budget-table"
      >
        {/* Desktop: a table whose rows open; phone: cards. */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {HEAD.map((h, i) => (
                  <th
                    key={h}
                    className={cn(
                      'whitespace-nowrap px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-t3 first:pl-4 last:pr-4',
                      i > 0 && i < 7 && 'text-right',
                    )}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {v.rows.map((r) => (
                <Fragment key={r.code}>
                  <tr>
                    <td className="border-t border-hair py-[11px] pl-4 pr-3 text-[14px]">
                      {name(r)}
                      {sub(r)}
                    </td>
                    {cells(r).map((c, i) => (
                      <td
                        key={i}
                        className="figure whitespace-nowrap border-t border-hair px-3 py-[11px] text-right text-[14px]"
                      >
                        {c}
                      </td>
                    ))}
                    <td className="border-t border-hair py-[11px] pl-3 pr-4">
                      <StatePill state={r.state} />
                    </td>
                  </tr>
                  {open === r.code && (
                    <tr>
                      <td colSpan={8} className="border-t border-hair bg-sf2">
                        <Detail row={r} view={v} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="border-t border-bd py-[11px] pl-4 pr-3 text-[14px]">All cost centers</td>
                {[usd(t.budget), usd(t.actual), usd(t.reserved), usd(t.available), usd(t.forecast), variance(t)].map(
                  (c, i) => (
                    <td
                      key={i}
                      className="figure whitespace-nowrap border-t border-bd px-3 py-[11px] text-right text-[14px]"
                    >
                      {c}
                    </td>
                  ),
                )}
                <td className="border-t border-bd py-[11px] pl-3 pr-4">
                  <StatePill state={t.state} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <ul className="md:hidden">
          {v.rows.map((r) => (
            <li key={r.code} className="border-t border-hair">
              <div className="grid grid-cols-2 gap-x-[18px] gap-y-[7px] px-4 py-3.5">
                <div className="col-span-2 mb-0.5 flex items-start justify-between gap-2 text-[14px]">
                  <span>
                    {name(r)}
                    {sub(r)}
                  </span>
                  <StatePill state={r.state} />
                </div>
                {HEAD.slice(1, 7).map((h, i) => (
                  <div
                    key={h}
                    className={cn(
                      'flex min-w-0 items-baseline justify-between gap-2 text-[14px]',
                      h === 'Variance' && 'col-span-2',
                    )}
                  >
                    <span className="shrink-0 text-[12px] text-t3">{h}</span>
                    <span className="figure min-w-0 text-right">{cells(r)[i]}</span>
                  </div>
                ))}
              </div>
              {open === r.code && (
                <div className="border-t border-hair bg-sf2">
                  <Detail row={r} view={v} />
                </div>
              )}
            </li>
          ))}
          <li className="grid grid-cols-2 gap-x-[18px] gap-y-[7px] border-t border-bd px-4 py-3.5 font-semibold">
            <div className="col-span-2 flex items-center justify-between text-[14px]">
              All cost centers <StatePill state={t.state} />
            </div>
            {[
              ['Budget', usd(t.budget)],
              ['Actual', usd(t.actual)],
              ['Available', usd(t.available)],
              ['Forecast', usd(t.forecast)],
            ].map(([h, c]) => (
              <div key={h} className="flex items-baseline justify-between gap-2 text-[14px]">
                <span className="text-[12px] font-normal text-t3">{h}</span>
                <span className="figure">{c}</span>
              </div>
            ))}
            <div className="col-span-2 flex items-baseline justify-between gap-2 text-[14px]">
              <span className="text-[12px] font-normal text-t3">Variance</span>
              <span className="figure">{variance(t)}</span>
            </div>
          </li>
        </ul>
      </Card>
      <Lede className="mt-2.5">
        Available is budget less actual and reservations. Variance is forecast against budget. Open a row for its months
        and owner.
      </Lede>
    </div>
  );
}
