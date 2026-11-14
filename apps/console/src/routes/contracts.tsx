import type { ContractsView, ContractView } from '@landledger/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ErrorNote, Lede } from '@/components/spend/bits';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Pill, Tag } from '@/components/ui/pill';
import { ApiError, get, quiet, send } from '@/lib/api';
import { dayLabel, usd } from '@/lib/format';
import { useFinanceAdmin } from './reconciliation';

const longDay = (d: string) => dayLabel(d, { day: 'numeric', month: 'short', year: 'numeric' });

/** Contracts (spec 009): for Overview's Needs you, the ones inside their notice window. */
export function useContracts() {
  return useQuery({ queryKey: ['contracts'], queryFn: () => get<ContractsView>('/api/contracts'), retry: quiet });
}

function ContractItem({ c, focus }: { c: ContractView; focus: boolean }) {
  const seats = c.seats;
  return (
    <li
      className={`border-t border-hair px-4 py-3.5 first:border-t-0 ${focus ? 'bg-acdim' : ''}`}
      data-testid={`contract-${c.vendor}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="font-medium text-t1">
            {c.vendor} · {c.product}
          </span>{' '}
          {c.origin === 'dev-fixture' && <Tag dashed>dev fixture</Tag>}
          {c.origin === 'request' && c.requestId && (
            <Link to={`/approvals/${c.requestId}`}>
              <Tag>from a request</Tag>
            </Link>
          )}
          <small className="block text-[12px] text-t3">
            {c.costCenter.name} ({c.costCenter.code}) · v{c.version}
            {c.landbrightApp ? ` · grants ${c.landbrightApp} in Landbright` : ''}
          </small>
        </span>
        {c.inNoticeWindow ? (
          <Pill tone="risk" data-testid={`notice-${c.vendor}`}>
            {c.daysToNotice >= 0 ? `Notice in ${c.daysToNotice} days` : 'Notice date passed'}
          </Pill>
        ) : (
          <span className="text-[12px] text-t3">Renews {longDay(c.renewalDate)}</span>
        )}
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        <div>
          <div className="text-[11.5px] text-t3">Annual value</div>
          <div className="figure text-[15px] font-medium text-t1">{usd(c.annualValue)}</div>
          <div className="text-[11.5px] text-t3">TCV {usd(c.tcv)}</div>
        </div>
        <div>
          <div className="text-[11.5px] text-t3">Term</div>
          <div className="text-[14px] text-t1">{c.termMonths} months</div>
          <div className="text-[11.5px] text-t3">
            {longDay(c.termStart)} – {longDay(c.termEnd)}
          </div>
        </div>
        <div>
          <div className="text-[11.5px] text-t3">Seats used</div>
          <div className="figure text-[15px] font-medium text-t1">
            {seats ? `${seats.used} of ${seats.paid}` : 'No seats'}
          </div>
          {seats && (
            <div className="text-[11.5px] text-t3">
              {seats.left} left{seats.reserved ? `, ${seats.reserved} reserved` : ''}
              {c.seatPrice ? ` · ${usd(c.seatPrice)} a seat a month` : ''}
            </div>
          )}
        </div>
        <div>
          <div className="text-[11.5px] text-t3">Notice by</div>
          <div className="text-[14px] text-t1">{longDay(c.noticeDate)}</div>
          <div className="text-[11.5px] text-t3">
            {c.noticeDays} days before renewal{c.autoRenew ? ', renews itself' : ''}
          </div>
        </div>
      </div>
    </li>
  );
}

function Import() {
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | undefined>();
  const [fixture, setFixture] = useState(false);
  const run = useMutation({
    mutationFn: () =>
      send<ContractsView>('POST', '/api/contracts/import', {
        csv,
        fileName,
        origin: fixture ? 'dev-fixture' : 'entered',
      }),
    onSuccess: () => {
      setCsv('');
      void qc.invalidateQueries({ queryKey: ['contracts'] });
    },
  });
  const problems =
    run.error instanceof ApiError ? ((run.error.details as { problems?: string[] } | undefined)?.problems ?? []) : [];
  return (
    <Card
      title="Import contracts"
      sub="A CSV: vendor, product, cost_center, tcv, currency, term_start, term_end, seats_paid, seats_used, renewal_date, notice_days[, auto_renew, landbright_app]"
    >
      <CardBody className="grid gap-2">
        <input
          type="file"
          accept=".csv,text/csv"
          className="text-[13px]"
          aria-label="Contracts CSV file"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setFileName(f.name);
            setCsv(await f.text());
          }}
        />
        <textarea
          className="min-h-24 rounded-[9px] border border-bd bg-sf p-2 font-mono text-[12px]"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder="…or paste the CSV here"
          aria-label="Contracts CSV"
        />
        <label className="flex items-center gap-2 text-[13px] text-t2">
          <input type="checkbox" checked={fixture} onChange={(e) => setFixture(e.target.checked)} /> A development
          fixture (labelled as such everywhere)
        </label>
        <div>
          <Button variant="primary" disabled={!csv.trim() || run.isPending} onClick={() => run.mutate()}>
            Import
          </Button>
        </div>
        {run.isSuccess && <p className="text-[13px] text-gn">Imported. A contract imported again is a new version.</p>}
        {run.isError && (
          <div className="text-[13px] text-rd">
            {run.error.message}
            {problems.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {problems.slice(0, 20).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Contracts and renewals (spec 009): renewals inside their notice window first. */
export function ContractsPage() {
  const [params] = useSearchParams();
  const focus = params.get('id');
  const q = useContracts();
  const canAct = useFinanceAdmin();
  const v = q.data;
  if (!v) return q.isError ? <ErrorNote error={q.error} /> : <Lede>Loading contracts…</Lede>;
  const due = v.contracts.filter((c) => c.inNoticeWindow);
  const rest = v.contracts.filter((c) => !c.inNoticeWindow);
  return (
    <div data-testid="contracts" className="grid gap-3.5">
      <Lede>
        Vendor contracts and subscriptions. A contract inside its notice window (from {v.windowDays} days before its
        notice date to its renewal) comes first, and its owner hears of it once. A new contract is approved as a request
        for its total value and term; seats are what it holds.
      </Lede>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {[
          ['Annual value', usd(v.totals.annualValue)],
          ['Total contract value', usd(v.totals.tcv)],
          ['Seats used', `${v.totals.seatsUsed} of ${v.totals.seatsPaid}`],
          ['In the notice window', String(due.length)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[14px] border border-hair bg-sf px-3.5 py-3">
            <div className="text-[12px] text-t3">{label}</div>
            <div className="figure mt-0.5 text-[18px] font-semibold text-t1">{value}</div>
          </div>
        ))}
      </div>
      {due.length > 0 && (
        <Card title="Renewals to decide" sub="Inside the notice window, by notice date" testId="renewals-due">
          <ul>
            {due.map((c) => (
              <ContractItem key={c.id} c={c} focus={c.id === focus} />
            ))}
          </ul>
        </Card>
      )}
      <Card title={due.length ? 'Other contracts' : 'Contracts'} sub="By renewal date" testId="contracts-rest">
        {rest.length ? (
          <ul>
            {rest.map((c) => (
              <ContractItem key={c.id} c={c} focus={c.id === focus} />
            ))}
          </ul>
        ) : (
          <div className="px-4 py-7 text-center text-[13px] text-t3">
            {v.contracts.length ? 'Every contract is inside its notice window.' : 'No contract imported yet.'}
          </div>
        )}
      </Card>
      {canAct && <Import />}
    </div>
  );
}
