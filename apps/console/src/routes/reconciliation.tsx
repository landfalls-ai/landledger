import type { InvoiceView, ReconcileStatus, ReconciliationRow, ReconciliationView } from '@landledger/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorNote, Lede } from '@/components/spend/bits';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { type Column, DataTable } from '@/components/ui/data-table';
import { Pill, type PillTone, Tag } from '@/components/ui/pill';
import { ApiError, get, quiet, send } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { dayLabel, monthLabel, pct, signed, usd } from '@/lib/format';

const STATUS: Record<ReconcileStatus, { label: string; tone: PillTone }> = {
  matched: { label: 'Within tolerance', tone: 'ok' },
  outside: { label: 'Outside tolerance', tone: 'risk' },
  not_invoiced: { label: 'Not invoiced yet', tone: 'nu' },
  no_estimate: { label: 'No estimate', tone: 'nu' },
};

/** May this person import and void invoices: a controller or the CFO, signed in (the API checks again). */
export function useFinanceAdmin(): boolean {
  const me = useMe().data;
  if (!me) return false;
  if (me.kind === 'dev') return true;
  return me.kind === 'person' && me.user.roles.some((r) => r === 'controller' || r === 'cfo');
}

const ROWS: Column<ReconciliationRow>[] = [
  {
    header: 'Provider and model',
    cell: (r) => (
      <span>
        <span className="font-medium text-t1">{r.model}</span>
        <small className="block text-t3">
          {r.provider}
          {r.invoices.length ? ` · ${r.invoices.join(', ')}` : ''}
        </small>
      </span>
    ),
  },
  { header: 'Estimated', numeric: true, cell: (r) => usd(r.estimated) },
  { header: 'Invoiced', numeric: true, cell: (r) => usd(r.invoiced) },
  {
    header: 'Variance',
    numeric: true,
    cell: (r) => (
      <span className={r.status === 'outside' ? 'text-warn' : ''}>
        {signed(r.variance)}
        {r.variancePct !== null && ` · ${pct(r.variancePct, true)}`}
      </span>
    ),
  },
  {
    header: 'Status',
    cell: (r) => (
      <Pill tone={STATUS[r.status].tone} data-testid={`status-${r.model}`}>
        {STATUS[r.status].label}
      </Pill>
    ),
  },
];

function Invoices({ invoices, canAct }: { invoices: InvoiceView[]; canAct: boolean }) {
  const qc = useQueryClient();
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const voidIt = useMutation({
    mutationFn: (id: string) => send<InvoiceView>('POST', `/api/invoices/${id}/void`, { reason }),
    onSuccess: () => {
      setVoiding(null);
      setReason('');
      void qc.invalidateQueries();
    },
  });
  if (!invoices.length)
    return <div className="px-4 py-7 text-center text-[13px] text-t3">No invoice imported for this month yet.</div>;
  return (
    <ul data-testid="invoices">
      {invoices.map((i) => (
        <li key={i.id} className="border-t border-hair px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="min-w-0">
              <span className="font-medium text-t1">
                {i.provider} · {i.number}
              </span>{' '}
              {i.origin === 'dev-fixture' && <Tag dashed>dev fixture</Tag>} {i.status === 'voided' && <Tag>voided</Tag>}{' '}
              {i.correction && <Tag>correction</Tag>}
              <small className="block text-t3">
                v{i.version} · {i.lines.length} line{i.lines.length === 1 ? '' : 's'} · imported{' '}
                {dayLabel(i.importedAt.slice(0, 10))} by {i.importedBy} · {i.posted.added} posted, {i.posted.reversed}{' '}
                reversed, {i.posted.unchanged} unchanged, {i.posted.linkedEstimates} estimates replaced
              </small>
            </span>
            <span className="figure whitespace-nowrap font-medium">{usd(i.total)}</span>
          </div>
          {canAct && i.status === 'posted' && (
            <div className="mt-2">
              {voiding === i.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="h-[30px] min-w-0 flex-1 rounded-[9px] border border-bd bg-sf px-2.5 text-[13px]"
                    placeholder="Why it is voided"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    aria-label="Reason"
                  />
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={reason.trim().length < 3 || voidIt.isPending}
                    onClick={() => voidIt.mutate(i.id)}
                  >
                    Void
                  </Button>
                  <Button size="sm" onClick={() => setVoiding(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button size="sm" onClick={() => setVoiding(i.id)}>
                  Void…
                </Button>
              )}
              {voidIt.isError && <p className="mt-1 text-[12px] text-rd">{voidIt.error.message}</p>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function Import() {
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | undefined>();
  const [fixture, setFixture] = useState(false);
  const run = useMutation({
    mutationFn: () =>
      send<{ invoices: InvoiceView[] }>('POST', '/api/invoices/import', {
        csv,
        fileName,
        origin: fixture ? 'dev-fixture' : 'entered',
      }),
    onSuccess: () => {
      setCsv('');
      void qc.invalidateQueries();
    },
  });
  const problems =
    run.error instanceof ApiError ? ((run.error.details as { problems?: string[] } | undefined)?.problems ?? []) : [];
  return (
    <Card
      title="Import an invoice"
      sub="A CSV: provider, invoice_number, period, model, sku, quantity, unit, amount, currency"
    >
      <CardBody className="grid gap-2">
        <input
          type="file"
          accept=".csv,text/csv"
          className="text-[13px]"
          aria-label="Invoice CSV file"
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
          aria-label="Invoice CSV"
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
        {run.isSuccess && (
          <p className="text-[13px] text-gn">Imported. Corrections are reversals: nothing was edited.</p>
        )}
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

/** Reconciliation (spec 005): AI estimates against the providers' invoices, per provider, model and month. */
export function ReconciliationPage() {
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? new Date().toISOString().slice(0, 7);
  const canAct = useFinanceAdmin();
  const q = useQuery({
    queryKey: ['reconciliation', month],
    queryFn: () => get<ReconciliationView>(`/api/reconciliation?month=${month}`),
    retry: quiet,
  });
  const v = q.data;
  const shift = (n: number) => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setParams({ month: d.toISOString().slice(0, 7) });
  };
  if (!v) return q.isError ? <ErrorNote error={q.error} /> : <Lede>Loading reconciliation…</Lede>;
  const t = v.totals;
  return (
    <div data-testid="reconciliation" className="grid gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => shift(-1)} aria-label="Previous month">
          ‹
        </Button>
        <span className="font-medium text-t1">{monthLabel(v.month)}</span>
        <Button size="sm" onClick={() => shift(1)} aria-label="Next month">
          ›
        </Button>
      </div>
      <Lede>
        AI usage estimated from tokens × the rate card, against what the providers invoiced. A row is within tolerance
        when the variance is at most ±{v.tolerancePct}% of the estimate. Estimates an invoice replaced are counted once,
        as invoiced, everywhere else in Landledger.
      </Lede>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {[
          ['Estimated', usd(t.estimated)],
          ['Invoiced', usd(t.invoiced)],
          ['Variance', `${signed(t.variance)}${t.variancePct === null ? '' : ` · ${pct(t.variancePct, true)}`}`],
          ['AI spend invoiced', `${t.invoicedShare}%`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[14px] border border-hair bg-sf px-3.5 py-3">
            <div className="text-[12px] text-t3">{label}</div>
            <div className="figure mt-0.5 text-[18px] font-semibold text-t1">{value}</div>
          </div>
        ))}
      </div>
      <Card
        title="By provider and model"
        sub={t.within ? 'The month is within tolerance' : 'The month is outside tolerance'}
        testId="reconciliation-table"
      >
        <DataTable
          columns={ROWS}
          rows={v.rows}
          rowKey={(r) => `${r.provider}:${r.model}`}
          empty="No AI usage or invoice in this month."
        />
      </Card>
      <Card title="Invoices" sub={`${v.invoices.length} for ${monthLabel(v.month)}`}>
        <Invoices invoices={v.invoices} canAct={canAct} />
      </Card>
      {canAct && <Import />}
    </div>
  );
}
