import type { ExceptionsReport, RequestSummary } from '@landledger/contracts';
import { Decimal } from '@landledger/money';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Card, CardBody } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { Pill, Tag } from '@/components/ui/pill';
import { get, quiet } from '@/lib/api';
import { toTsv } from '@/lib/copy';
import { monthLabel, usd } from '@/lib/format';
import { age, amountWords, askedBy, kindLabel, perLabel, stepTone, TIERS, useRequests } from '@/lib/requests';

const columns = (mine: boolean): Column<RequestSummary>[] => [
  {
    header: 'Request',
    cell: (r) => (
      <span>
        <Link to={`/approvals/${r.id}`} className="font-medium text-t1 underline-offset-2 hover:underline">
          {r.title}
        </Link>
        <span className="block text-[12px] text-t3">
          {r.number} · {kindLabel(r.kind)}
        </span>
      </span>
    ),
  },
  {
    header: 'Amount',
    numeric: true,
    cell: (r) => (
      <span>
        <b className="font-semibold">+{amountWords(r.amount.amount)}</b>{' '}
        <span className="font-sans text-[12px] text-t3">{perLabel(r)}</span>
      </span>
    ),
  },
  {
    header: 'Cost center',
    cell: (r) => <span className="font-mono text-[12px] font-medium tracking-[-0.01em]">{r.costCenter.code}</span>,
  },
  {
    header: 'Budget left after',
    numeric: true,
    cell: (r) =>
      r.budgetLeftAfter === null ? (
        <span className="text-t3">No budget</span>
      ) : (
        <span className={Decimal.parse(r.budgetLeftAfter).isNegative() ? 'text-rd' : ''}>
          {usd(r.budgetLeftAfter, { whole: true })}
        </span>
      ),
  },
  {
    header: 'Asked by',
    cell: (r) => {
      const a = askedBy(r.requester);
      return (
        <span>
          {a.name} {a.agent && <Tag>agent</Tag>}
          {a.sponsor && <span className="block text-[12px] text-t3">Sponsor {a.sponsor}</span>}
        </span>
      );
    },
  },
  { header: 'Age', cell: (r) => age(r.submittedAt ?? r.createdAt) },
  { header: 'Step', full: true, cell: (r) => <Pill tone={stepTone(r, mine)}>{r.stepLabel}</Pill> },
];

const tsvOf = (rows: RequestSummary[]) =>
  toTsv(
    [
      'Number',
      'Request',
      'Kind',
      'Amount',
      'Per',
      'Currency',
      'Cost center',
      'Budget left after',
      'Asked by',
      'Sponsor',
      'Step',
      'Raised',
    ],
    rows.map((r) => {
      const a = askedBy(r.requester);
      return [
        r.number,
        r.title,
        kindLabel(r.kind),
        r.amount.amount,
        perLabel(r),
        r.amount.currency,
        r.costCenter.code,
        r.budgetLeftAfter ?? '',
        a.name,
        a.sponsor ?? '',
        r.stepLabel,
        r.submittedAt ?? r.createdAt,
      ];
    }),
  );

function Section({
  title,
  rows,
  mine,
  empty,
  loading,
  testId,
}: {
  title: string;
  rows: RequestSummary[];
  mine: boolean;
  empty: string;
  loading: boolean;
  testId: string;
}) {
  return (
    <section className="mt-5 first:mt-0" data-testid={testId}>
      <h2 className="mb-2.5 flex items-center gap-2 text-[15px] font-semibold text-t1">
        {title}
        {rows.length > 0 && (
          <span className="figure grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-ac px-[5px] text-[11px] font-semibold text-on-ac">
            {rows.length}
          </span>
        )}
      </h2>
      {rows.length > 0 ? (
        <Card>
          <DataTable columns={columns(mine)} rows={rows} rowKey={(r) => r.id} />
        </Card>
      ) : (
        <div className="rounded-[14px] border border-hair bg-sf px-4 py-7 text-center text-[13px] text-t3">
          {loading ? 'Loading…' : empty}
        </div>
      )}
    </section>
  );
}

/** The default tiers (docs/approvals.md); the real policies are on Rates and rules. */
export function Tiers({ on }: { on?: number }) {
  return (
    <div className="grid grid-cols-4 gap-1">
      {TIERS.map(([who, limit], i) => (
        <div
          key={who}
          className={`rounded-lg border px-1.5 py-[7px] text-center text-[11.5px] leading-tight ${i === on ? 'border-t1 text-t1' : 'border-hair text-t3'}`}
        >
          <b className={`block ${i === on ? 'font-semibold text-t1' : 'font-medium text-t2'}`}>{who}</b>
          {limit}
        </div>
      ))}
    </div>
  );
}

const exceptionColumns: Column<ExceptionsReport['rows'][number]>[] = [
  {
    header: 'Cost center',
    cell: (e) => (
      <span>
        <span className="font-mono text-[12px] font-medium tracking-[-0.01em]">{e.costCenter}</span>
        <span className="block text-[12px] text-t3">
          {e.name} · {monthLabel(e.month)}
        </span>
      </span>
    ),
  },
  { header: 'Spent', numeric: true, cell: (e) => usd(e.actual, { whole: true }) },
  { header: 'Covered by requests', numeric: true, cell: (e) => usd(e.covered, { whole: true }) },
  {
    header: 'Not covered',
    numeric: true,
    cell: (e) => <b className="font-semibold text-rd">{usd(e.uncovered, { whole: true })}</b>,
  },
  { header: 'Owner', cell: (e) => e.owner ?? <span className="text-t3">No owner</span> },
];

/** Spend above the automatic threshold that no approved request covers (the weekly exceptions report). */
function Exceptions() {
  const report = useQuery({
    queryKey: ['exceptions'],
    queryFn: () => get<ExceptionsReport>('/api/exceptions'),
    retry: quiet,
  });
  const rows = report.data?.rows ?? [];
  return (
    <Card
      title="Spend no request covers"
      sub={
        report.data
          ? `${monthLabel(report.data.from)}${report.data.to !== report.data.from ? ` to ${monthLabel(report.data.to)}` : ''}: spend above a cost center’s automatic threshold with no approved request behind it. Sent to Finance weekly.`
          : 'The weekly exceptions report'
      }
      action={
        rows.length > 0 && (
          <CopyButton
            tsv={() =>
              toTsv(
                ['Month', 'Cost center', 'Name', 'Owner', 'Spent', 'Covered', 'Not covered', 'Threshold', 'Requests'],
                rows.map((e) => [
                  e.month,
                  e.costCenter,
                  e.name,
                  e.owner ?? '',
                  e.actual,
                  e.covered,
                  e.uncovered,
                  e.threshold,
                  e.requests.map((q) => q.number).join(' '),
                ]),
              )
            }
          />
        )
      }
      className="mt-5"
      testId="exceptions"
    >
      {report.isError ? (
        <CardBody className="text-[13px] text-rd">{report.error.message}</CardBody>
      ) : (
        <DataTable
          columns={exceptionColumns}
          rows={rows}
          rowKey={(e) => `${e.month}:${e.costCenter}`}
          empty={
            report.isLoading ? 'Loading…' : 'Every cost center’s spend above its threshold has an approved request.'
          }
        />
      )}
    </Card>
  );
}

/** Approvals (docs/ui.md, `#approvals`): waiting on you, then what you raised, then what was decided. */
export function ApprovalsPage() {
  const waiting = useRequests('waiting');
  const mine = useRequests('mine');
  const decided = useRequests('decided');
  const all = [...(waiting.data?.requests ?? []), ...(mine.data?.requests ?? []), ...(decided.data?.requests ?? [])];
  const unique = [...new Map(all.map((r) => [r.id, r])).values()];
  const error = waiting.error ?? mine.error ?? decided.error;
  return (
    <div data-testid="approvals">
      <div className="mb-3.5 flex flex-wrap items-start justify-between gap-2.5">
        <p className="min-w-0 flex-[1_1_240px] text-[13px] text-t2">
          Spend that needs a person. Open a request to see its evidence before you decide. Agents request; people
          decide. All figures in USD.
        </p>
        {unique.length > 0 && <CopyButton tsv={() => tsvOf(unique)} />}
      </div>
      {error && <p className="mb-3 text-[13px] text-rd">{error.message}</p>}
      <Section
        title="Waiting on you"
        rows={waiting.data?.requests ?? []}
        mine
        empty="Nothing is waiting on you."
        loading={waiting.isLoading}
        testId="box-waiting"
      />
      <Section
        title="You raised"
        rows={mine.data?.requests ?? []}
        mine={false}
        empty="You haven’t raised anything."
        loading={mine.isLoading}
        testId="box-mine"
      />
      <Section
        title="Decided"
        rows={decided.data?.requests ?? []}
        mine={false}
        empty="Nothing decided yet."
        loading={decided.isLoading}
        testId="box-decided"
      />
      <Card
        title="Who decides what"
        sub="Per month, for infra and AI budget requests (one-off amounts on the same lines). A cost center that is at risk or over adds Finance."
        action={
          <Link
            to="/rules"
            className="inline-flex h-[30px] items-center rounded-[9px] border border-bd px-2.5 text-[12.5px] font-medium text-t1 hover:bg-acdim"
          >
            All policies
          </Link>
        }
        className="mt-5"
      >
        <CardBody>
          <Tiers />
        </CardBody>
      </Card>
      <Exceptions />
    </div>
  );
}
