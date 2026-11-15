import type { CostCenterLine, Overview } from '@landledger/contracts';
import { Decimal } from '@landledger/money';
import { useQuery } from '@tanstack/react-query';
import { Activity, ChevronRight, Database, FileText, Gauge, Scale } from 'lucide-react';
import { Link } from 'react-router';
import { BudgetBar, BurnChart, SplitBar } from '@/components/spend/charts';
import { YearAhead } from '@/components/spend/year-ahead';
import { ErrorNote, Estimated, Invoiced, Legend, Lede, Stat, StatePill, Swatch } from '@/components/spend/bits';
import { Card, CardBody } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { Pill, Tag } from '@/components/ui/pill';
import { get, quiet } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { toTsv } from '@/lib/copy';
import { dayLabel, monthLabel, num, usd } from '@/lib/format';
import { amountWords, perLabel, useRequests } from '@/lib/requests';
import { RULE_LABEL, useOpenAnomalies } from './anomalies';
import { useContracts } from './contracts';

const share = (part: string, whole: string) => {
  const w = Decimal.parse(whole);
  return w.isZero() ? 0 : Math.round(Number(Decimal.parse(part).times('100').divide(w, 1, 'halfEven').toString()));
};

/** Needs you: requests waiting on the signed-in person, newest first (docs/ui.md, Overview). */
function NeedsYou() {
  const q = useRequests('waiting');
  const c = useRequests('confirm');
  const meId = useMe().data?.user.id;
  // Not yet seen by anyone, or assigned to you: an acknowledged one stays open on Anomalies, not here.
  const an = (useOpenAnomalies().data?.anomalies ?? []).filter(
    (a) => a.status === 'open' || (meId && a.assignee?.id === meId),
  );
  const due = (useContracts().data?.contracts ?? []).filter((c) => c.inNoticeWindow);
  const confirm = c.data?.requests ?? [];
  const rows = [...confirm, ...(q.data?.requests ?? [])];
  if (rows.length === 0 && an.length === 0 && due.length === 0) return null;
  const sub = [
    confirm.length ? `${confirm.length} raised in your name, to confirm` : null,
    q.data?.requests.length ? `${q.data.requests.length} waiting on your decision` : null,
    an.length ? `${an.length} open ${an.length === 1 ? 'anomaly' : 'anomalies'}` : null,
    due.length ? `${due.length} renewal${due.length === 1 ? '' : 's'} to decide` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Card title="Needs you" sub={sub} testId="needs-you">
      <ul>
        {rows.slice(0, 4).map((r) => (
          <li key={r.id} className="border-t border-hair first:border-t-0">
            <Link to={`/approvals/${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-acdim">
              <span className="min-w-0 flex-1 text-[14px]">
                <b className="font-medium">{r.title}</b>
                <small className="block text-[12px] text-t3">
                  +{amountWords(r.amount.amount)} {perLabel(r)} · {r.costCenter.code} · {r.stepLabel}
                </small>
              </span>
              <ChevronRight className="size-4 shrink-0 text-t3" />
            </Link>
          </li>
        ))}
        {due.slice(0, 2).map((c) => (
          <li key={c.id} className="border-t border-hair first:border-t-0" data-testid="needs-you-renewal">
            <Link to={`/contracts?id=${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-acdim">
              <FileText className="size-4 shrink-0 text-warn" />
              <span className="min-w-0 flex-1 text-[14px]">
                <b className="font-medium">
                  Renewal: {c.vendor} {c.product}
                </b>
                <small className="block text-[12px] text-t3">
                  Notice by {c.noticeDate} ({c.daysToNotice} days) · {usd(c.annualValue)} a year
                </small>
              </span>
              <ChevronRight className="size-4 shrink-0 text-t3" />
            </Link>
          </li>
        ))}
        {an.slice(0, 3).map((a) => (
          <li key={a.id} className="border-t border-hair first:border-t-0" data-testid="needs-you-anomaly">
            <Link to={`/anomalies?id=${a.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-acdim">
              <Activity className="size-4 shrink-0 text-warn" />
              <span className="min-w-0 flex-1 text-[14px]">
                <b className="font-medium">
                  {RULE_LABEL[a.rule]}: {a.label}
                </b>
                <small className="block text-[12px] text-t3">
                  {a.kind === 'cost' && a.observed
                    ? `${usd(a.observed)} against a median of ${usd(a.baseline)}`
                    : `${a.requests.length} request${a.requests.length === 1 ? '' : 's'}`}
                  {a.dev ? ' · dev test' : ''}
                </small>
              </span>
              <ChevronRight className="size-4 shrink-0 text-t3" />
            </Link>
          </li>
        ))}
        {an.length > 3 && (
          <li className="border-t border-hair px-4 py-2.5 text-[13px]">
            <Link to="/anomalies" className="underline decoration-hair underline-offset-2">
              All {an.length} open anomalies
            </Link>
          </li>
        )}
      </ul>
    </Card>
  );
}

const ccColumns: Column<CostCenterLine>[] = [
  {
    header: 'Cost center',
    cell: (c) => (
      <span>
        <Link
          to={`/explore?filter=costCenter:${encodeURIComponent(c.code)}&by=service`}
          className="font-medium text-t1 underline-offset-[3px] hover:underline"
        >
          {c.name}
        </Link>
        <span className="block text-[12px] text-t3">
          {c.code === 'SHARED-POOL'
            ? 'Idle capacity and shared services'
            : c.code === 'UNALLOCATED'
              ? 'No rule matched'
              : c.code === 'CORRECTIONS'
                ? 'Charged in a locked month, booked in this one'
                : c.code}
          {c.owner && ` · ${c.owner}`}
        </span>
      </span>
    ),
  },
  { header: 'Month to date', numeric: true, cell: (c) => usd(c.monthToDate) },
  { header: 'Invoiced', numeric: true, cell: (c) => `${share(c.invoiced, c.monthToDate)}%` },
  { header: 'Budget', numeric: true, cell: (c) => usd(c.budget) },
  {
    header: 'Forecast',
    numeric: true,
    cell: (c) =>
      c.forecast === null ? (
        <span className="text-t3">—</span>
      ) : (
        <span className={c.budget && Decimal.parse(c.forecast).compare(c.budget) > 0 ? 'text-rd' : ''}>
          {usd(c.forecast)}
        </span>
      ),
  },
  {
    header: 'Actual + reserved vs budget',
    full: true,
    cell: (c) => (
      <BudgetBar
        actual={num(c.monthToDate)}
        reserved={num(c.reserved)}
        budget={c.budget ? num(c.budget) : null}
        state={c.state}
      />
    ),
  },
  { header: 'State', cell: (c) => <StatePill state={c.state} /> },
];

function Split({ rows, total }: { rows: Overview['byCategory']; total: string }) {
  const max = Math.max(...rows.map((r) => num(r.amount)), 0);
  return (
    <CardBody>
      {rows.map((r) => (
        <div
          key={r.key}
          className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 gap-y-1 border-t border-hair py-[9px] first:border-t-0 first:pt-0"
        >
          <span className="text-[14px] text-t1">{r.label}</span>
          <span className="figure text-[14px]">{usd(r.amount)}</span>
          <span className="figure min-w-[34px] text-right text-[12px] text-t3">{share(r.amount, total)}%</span>
          <SplitBar invoiced={num(r.invoiced)} estimated={num(r.amount) - num(r.invoiced)} scale={max} />
        </div>
      ))}
      {rows.length === 0 && <p className="text-[13px] text-t3">No spend yet this month.</p>}
      <Legend>
        <span>
          <Swatch color="var(--color-t1)" />
          invoiced
        </span>
        <span>
          <i
            className="mr-1.5 inline-block size-2.5 rounded-[3px] align-[-1px]"
            style={{ background: 'repeating-linear-gradient(135deg,var(--color-t3) 0 2px,transparent 2px 5px)' }}
          />
          estimated
        </span>
      </Legend>
    </CardBody>
  );
}

const SOURCE: Record<string, string> = { landflow: 'Landflow AI usage', clickland: 'Clickland resource usage' };
const SOURCE_SHORT: Record<string, string> = { landflow: 'Landflow', clickland: 'Clickland' };
const sinceLabel = (iso: string) => `${dayLabel(iso.slice(0, 10))} ${iso.slice(11, 16)} UTC`;
const ago = (iso: string | null) => {
  if (!iso) return 'running';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1
    ? 'just now'
    : m < 60
      ? `${m} min ago`
      : m < 48 * 60
        ? `${Math.round(m / 60)} h ago`
        : dayLabel(iso.slice(0, 10));
};

/** Overview (docs/ui.md): is technology spend on plan this month. */
export function OverviewPage() {
  const q = useQuery({
    queryKey: ['overview'],
    queryFn: () => get<Overview>('/api/overview'),
    retry: quiet,
    refetchInterval: 300_000,
  });
  const o = q.data;
  if (!o) return q.isError ? <ErrorNote error={q.error} /> : <Lede>Loading this month’s spend…</Lede>;
  const total = o.monthToDate.total;
  const invoicedPct = share(o.monthToDate.invoiced, total);
  const f = o.forecast;
  const overBy = o.budget.amount && f.amount ? Decimal.parse(f.amount).minus(o.budget.amount) : null;
  const usedPct = o.budget.amount ? share(total, o.budget.amount) : null;
  const a = o.attribution;
  const newest = f.sources.length
    ? f.sources.reduce((x, s) => (s.since && (!x.since || s.since > x.since) ? s : x))
    : null;
  const dataSince = f.dataSince ? (
    <>
      {newest ? `${SOURCE_SHORT[newest.source] ?? newest.source} data` : 'Data'} since {sinceLabel(f.dataSince)}
    </>
  ) : null;
  return (
    <div data-testid="overview">
      <Lede>
        {monthLabel(o.month)}, day {o.dayOfMonth} of {o.daysInMonth}. All figures in USD; every one is <Estimated />{' '}
        (usage × the rate card) until an invoice makes it <Invoiced />.
      </Lede>
      <div className="mb-3.5 grid grid-cols-2 gap-2.5 lg:grid-cols-4 lg:gap-3.5">
        <Stat label="Month to date" value={usd(total)} testId="stat-mtd">
          {invoicedPct}% invoiced, {100 - invoicedPct}% estimated
          {o.monthToDate.provisional !== '0.000000' && (
            <>
              <br />
              <span className="figure">{usd(o.monthToDate.provisional)}</span> of it today, provisional
            </>
          )}
          {o.monthToDate.corrections !== '0.000000' && (
            <>
              <br />
              <span className="figure">{usd(o.monthToDate.corrections)}</span> corrections to locked months
            </>
          )}
          {dataSince && (
            <>
              <br />
              {dataSince}
            </>
          )}
        </Stat>
        {f.status === 'insufficient' ? (
          <Stat label="Forecast to month-end" value="Not enough data yet" testId="stat-forecast" small>
            A forecast needs three full observed days of each source.
            {dataSince && (
              <>
                <br />
                {dataSince}
              </>
            )}
          </Stat>
        ) : (
          <Stat label="Forecast to month-end" value={usd(f.amount)} testId="stat-forecast">
            {f.status === 'ok' && (
              <>
                <span className="figure">
                  P10–P90 {usd(f.low)} – {usd(f.high)}
                </span>
                <br />
                {[
                  { v: f.reserved, what: 'reserved' },
                  { v: f.committed, what: 'committed beyond reservations' },
                  { v: f.contracted, what: 'under contract' },
                ]
                  .filter((x) => x.v && x.v !== '0.000000')
                  .map((x) => (
                    <span key={x.what}>
                      + <span className="figure">{usd(x.v!)}</span> {x.what}
                      <br />
                    </span>
                  ))}
              </>
            )}
            {overBy && overBy.compare('0') > 0 ? (
              <Pill tone="risk">{usd(overBy.toFixed(6, 'halfEven'))} over</Pill>
            ) : overBy ? (
              <Pill tone="ok">{usd(overBy.negate().toFixed(6, 'halfEven'))} under</Pill>
            ) : f.perDay ? (
              <span className="figure">{usd(f.perDay.mid)} a day</span>
            ) : (
              'A past month: actuals only'
            )}
            {dataSince && f.status === 'ok' && (
              <>
                <br />
                {dataSince}
              </>
            )}
          </Stat>
        )}
        <Stat label="Budget" value={usd(o.budget.amount)} testId="stat-budget">
          {o.budget.versions.length ? (
            <>
              {o.budget.versions.length > 1 ? 'Versions ' : ''}
              {o.budget.versions.map((v) => `v${v}`).join(', ')} from a{' '}
              {o.budget.source === 'csv' ? 'CSV' : o.budget.source}{' '}
              {o.budget.origin === 'dev-seed' && <Tag dashed>dev seed</Tag>}
            </>
          ) : (
            'No budget imported'
          )}
          {usedPct !== null && (
            <>
              <br />
              {usedPct}% used with {f.observedShare}% of the month observed
            </>
          )}
        </Stat>
        <Stat label="Left after reservations" value={usd(o.leftAfterReservations)} testId="stat-left">
          <span className="figure">{usd(o.reserved)}</span> reserved by approved requests
        </Stat>
      </div>

      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <Card
          title="The month’s burn"
          sub={`Cumulative cost, ${dayLabel(o.burn[0]?.day ?? `${o.month}-01`)} to ${dayLabel(o.burn.at(-1)?.day ?? `${o.month}-28`)}`}
        >
          <CardBody>
            <BurnChart overview={o} />
            <Legend>
              <span>
                <Swatch color="var(--color-viz-1)" line />
                Actual
              </span>
              <span>
                <Swatch color="var(--color-viz-1)" line dashed />
                Forecast and its range
              </span>
              {o.budget.amount && (
                <span>
                  <Swatch color="var(--color-t3)" line />
                  Budget
                </span>
              )}
            </Legend>
            <p className="mt-2 text-[12px] text-t3">
              {f.basis}.{f.band && ` ${f.band}.`}
            </p>
          </CardBody>
        </Card>

        <div className="flex min-w-0 flex-col gap-3.5">
          <NeedsYou />
          <YearAhead />
          <Card title="Where the figures come from">
            <ul>
              <li className="flex gap-3 border-t border-hair px-4 py-3 first:border-t-0">
                <Scale className="mt-0.5 size-4 shrink-0 text-t3" />
                <span className="min-w-0 text-[14px]">
                  <b className="font-medium">{a.directShare}% attributed to a cost center</b>
                  <small className="block text-[12px] text-t3">
                    Shared pool <span className="figure">{usd(a.sharedPool)}</span> (idle capacity, shared services) ·
                    Unallocated <span className="figure">{usd(a.unallocated)}</span>
                  </small>
                </span>
              </li>
              <li className="flex gap-3 border-t border-hair px-4 py-3">
                <Gauge className="mt-0.5 size-4 shrink-0 text-t3" />
                <span className="min-w-0 text-[14px]">
                  <b className="font-medium">
                    Rate card {o.rateCard.version ? `v${o.rateCard.version}` : ''} {o.rateCard.status}
                  </b>
                  <small className="block text-[12px] text-t3">
                    {o.rateCard.approvedBy
                      ? `Approved by ${o.rateCard.approvedBy}`
                      : 'Waiting for a controller or the CFO to approve it'}
                  </small>
                </span>
              </li>
              {o.runs.map((r) => (
                <li key={r.source} className="flex gap-3 border-t border-hair px-4 py-3">
                  <Database className="mt-0.5 size-4 shrink-0 text-t3" />
                  <span className="min-w-0 text-[14px]">
                    <b className="font-medium">{SOURCE[r.source] ?? r.source}</b>
                    <small className="block text-[12px] text-t3">
                      {r.outcome === 'failed' ? 'Last run failed' : `Read ${ago(r.finishedAt)}`} · {dayLabel(r.day)}
                      {r.warnings.length > 0 && ` · ${r.warnings.length} note${r.warnings.length > 1 ? 's' : ''}`}
                    </small>
                  </span>
                </li>
              ))}
              <li className="border-t border-hair">
                <Link to="/explore" className="flex items-center gap-3 px-4 py-3 text-[14px] text-t2 hover:text-t1">
                  <span className="flex-1">Explore where it comes from</span>
                  <ChevronRight className="size-4" />
                </Link>
              </li>
            </ul>
          </Card>
        </div>
      </div>

      <div className="mt-3.5 flex flex-col gap-3.5">
        <Card
          title="Cost centers"
          sub="Shared pool and Unallocated are their own lines, never folded into a team"
          action={
            <CopyButton
              tsv={() =>
                toTsv(
                  ['Cost center', 'Code', 'Month to date', 'Invoiced', 'Budget', 'Forecast', 'Reserved', 'State'],
                  o.costCenters.map((c) => [
                    c.name,
                    c.code,
                    c.monthToDate,
                    c.invoiced,
                    c.budget ?? '',
                    c.forecast ?? '',
                    c.reserved,
                    c.state,
                  ]),
                )
              }
            />
          }
          testId="cost-centers"
        >
          <DataTable columns={ccColumns} rows={o.costCenters} rowKey={(c) => c.code} empty="No spend yet this month." />
        </Card>
        <div className="grid gap-3.5 md:grid-cols-2">
          <Card title="By category">
            <Split rows={o.byCategory} total={total} />
          </Card>
          <Card title="By P&L class">
            <Split rows={o.byPlClass} total={total} />
          </Card>
        </div>
      </div>
    </div>
  );
}
