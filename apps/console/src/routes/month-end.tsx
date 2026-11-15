import type {
  AccrualRollForward,
  AccrualsView,
  AccrualView,
  CloseStepView,
  CoaMappingsView,
  CloseView,
  DatarailsPullView,
  DatarailsStatus,
  JournalView,
  LockResult,
  MonthEndPackage,
  NotesView,
  NoteView,
} from '@landledger/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link, NavLink, useSearchParams } from 'react-router';
import { ErrorNote, Lede, Stat } from '@/components/spend/bits';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Pill, type PillTone, Tag } from '@/components/ui/pill';
import { get, quiet, send } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { monthLabel, usd } from '@/lib/format';

// Shared --------------------------------------------------------------------------------------------------------------

/** The last month that ended (UTC): what Month-end opens on. */
const lastEnded = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
};
const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1 + by, 1)).toISOString().slice(0, 7);
};
const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      }) + ' UTC'
    : '';
const short = (sha: string | null | undefined) => (sha ? `${sha.slice(0, 12)}…` : '—');

function useRoles() {
  const me = useMe().data;
  const roles = me?.kind === 'person' ? me.user.roles : [];
  return {
    person: me?.kind === 'person',
    controller: roles.includes('controller'),
    cfo: roles.includes('cfo'),
    fpa: roles.includes('fpa'),
    signer: roles.includes('controller') || roles.includes('cfo'),
    analyst: roles.includes('controller') || roles.includes('fpa'),
    email: me?.user.email ?? null,
    id: me?.user.id ?? null,
  };
}

function useMonth(): [string, (m: string) => void] {
  const [params, setParams] = useSearchParams();
  const asked = params.get('month');
  const month = asked && /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : lastEnded();
  return [month, (m) => setParams({ month: m })];
}

const TABS = [
  { to: '/close', label: 'Checklist', end: true },
  { to: '/close/accruals', label: 'Accruals' },
  { to: '/close/notes', label: 'Variance notes' },
  { to: '/close/datarails', label: 'Datarails' },
  { to: '/close/package', label: 'Package' },
];

function MonthBar({ month, setMonth, right }: { month: string; setMonth: (m: string) => void; right?: ReactNode }) {
  return (
    <div className="mb-3.5 grid gap-2.5">
      <nav className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0" aria-label="Month-end">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={`${t.to}?month=${month}`}
            end={t.end}
            className={({ isActive }) =>
              cn(
                'inline-flex h-8 flex-none items-center rounded-2xl border border-bd bg-sf px-3 text-[13px] text-t2',
                isActive && 'border-ac2 bg-ac2 font-medium text-on-ac',
              )
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
          ‹
        </Button>
        <span className="font-medium text-t1" data-testid="month">
          {monthLabel(month)}
        </span>
        <Button size="sm" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
          ›
        </Button>
        {right}
      </div>
    </div>
  );
}

const STATE: Record<CloseStepView['state'], { tone: PillTone; label: string }> = {
  done: { tone: 'ok', label: 'Done' },
  explained: { tone: 'risk', label: 'Explained' },
  red: { tone: 'over', label: 'Red' },
  waiting: { tone: 'nu', label: 'Waiting' },
};

function statusPill(c: Pick<CloseView, 'status' | 'reopened' | 'round' | 'dryRun'>) {
  if (c.reopened) return <Pill tone="risk">Reopened · round {c.round}</Pill>;
  if (c.status === 'locked') return <Pill tone="ok">Locked</Pill>;
  if (c.status === 'closing') return <Pill tone="risk">Closing</Pill>;
  return <Pill tone="nu">Open · dry run</Pill>;
}

function useClose(month: string) {
  return useQuery({
    queryKey: ['close', month],
    queryFn: () => get<CloseView>(`/api/close?month=${month}`),
    retry: quiet,
  });
}

function Err({ m }: { m: { isError: boolean; error: Error | null } }) {
  return m.isError ? <p className="mt-1 w-full text-[12px] text-rd">{m.error?.message}</p> : null;
}

const input = 'h-[30px] min-w-0 flex-1 rounded-[9px] border border-bd bg-sf px-2.5 text-[13px]';

// The checklist (spec 012) ----------------------------------------------------------------------------------------

function Explain({ month, step, rowKey }: { month: string; step: CloseStepView; rowKey?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const run = useMutation({
    mutationFn: () => send<CloseView>('POST', `/api/close/${month}/explain`, { step: step.key, rowKey, note }),
    onSuccess: (v) => qc.setQueryData(['close', month], v),
  });
  if (!open)
    return (
      <Button size="sm" onClick={() => setOpen(true)} data-testid={`explain-${step.key}${rowKey ? `-${rowKey}` : ''}`}>
        Explain…
      </Button>
    );
  return (
    <div className="mt-2 flex w-full flex-wrap items-center gap-2">
      <input
        className={input}
        placeholder="Why this is fine for the close"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label="Explanation"
      />
      <Button
        size="sm"
        variant="primary"
        disabled={note.trim().length < 3 || run.isPending}
        onClick={() => run.mutate()}
      >
        Explain
      </Button>
      <Button size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      <Err m={run} />
    </div>
  );
}

function Step({
  month,
  s,
  canAct,
  canExplain,
}: {
  month: string;
  s: CloseStepView;
  canAct: boolean;
  canExplain: boolean;
}) {
  const st = STATE[s.state];
  return (
    <li className="border-t border-hair px-4 py-3 first:border-t-0" data-testid={`step-${s.key}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-t1">
          <span className="mr-1.5 text-t3">{s.number}.</span>
          {s.title}
        </span>
        <Pill tone={st.tone} data-testid={`state-${s.key}`}>
          {st.label}
        </Pill>
      </div>
      <p className="mt-0.5 text-[12.5px] text-t2">{s.summary}</p>
      {s.problems.length > 0 && s.state !== 'explained' && (
        <ul className="mt-1 list-disc pl-5 text-[12.5px] text-rd">
          {s.problems.slice(0, 6).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {s.rows && s.rows.length > 0 && (
        <ul className="mt-1.5 grid gap-1">
          {s.rows.map((r) => (
            <li key={r.key} className="rounded-[9px] border border-hair px-2.5 py-1.5 text-[12.5px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-t1">
                  {r.provider} · {r.model}
                </span>
                <Pill tone={r.ok ? 'ok' : r.explained ? 'risk' : 'over'}>
                  {r.ok ? 'Needs nothing' : r.explained ? 'Explained' : r.status.replace('_', ' ')}
                </Pill>
              </div>
              <span className="text-t3">
                estimated {usd(r.estimated)} · invoiced {usd(r.invoiced)}
              </span>
              {!r.ok && !r.explained && canAct && canExplain && <Explain month={month} step={s} rowKey={r.key} />}
            </li>
          ))}
        </ul>
      )}
      {s.by && (
        <p className="mt-1 text-[12px] text-t3">
          {s.by}
          {s.at ? `, ${when(s.at)}` : ''}
        </p>
      )}
      {s.explanations.map((e) => (
        <p key={e.id} className="mt-1 text-[12px] text-t2">
          <i>
            Explained{e.rowKey ? ` (${e.rowKey.replace('|', ' · ')})` : ''}: “{e.note}”
          </i>{' '}
          <span className="text-t3">
            {e.by}, {when(e.at)}
          </span>
        </p>
      ))}
      {s.state === 'red' && s.explainable && !s.rows && canAct && canExplain && (
        <div className="mt-2">
          <Explain month={month} step={s} />
        </div>
      )}
    </li>
  );
}

function LockCard({ month, c }: { month: string; c: CloseView }) {
  const qc = useQueryClient();
  const r = useRoles();
  const [reason, setReason] = useState('');
  const sign = useMutation({
    // Review of wave 4 (should-fix 1): the signature names the snapshot this page shows.
    mutationFn: () =>
      send<LockResult>('POST', `/api/close/${month}/lock`, { snapshotSha256: c.snapshot?.sha256 ?? null }),
    onSuccess: (v) => qc.setQueryData(['close', month], v.close),
  });
  const reopen = useMutation({
    mutationFn: () => send<{ close: CloseView }>('POST', `/api/close/${month}/reopen`, { reason }),
    onSuccess: (v) => qc.setQueryData(['close', month], v.close),
  });
  const lockStep = c.steps.find((s) => s.key === 'locked');
  const signed = c.signoffs.some((s) => s.person.id === r.id);
  const lockable =
    !c.dryRun && (c.status === 'closing' || c.reopened) && c.roundStarted !== false && lockStep?.state === 'red';
  return (
    <Card title="The lock" sub="Two people sign: a controller and the CFO" testId="lock-card">
      <CardBody className="grid gap-2 text-[13px]">
        {c.signoffs.length > 0 && (
          <ul className="grid gap-1" data-testid="signoffs">
            {c.signoffs.map((s) => (
              <li key={s.person.id}>
                <b>{s.person.name}</b> <span className="text-t3">({s.role === 'cfo' ? 'CFO' : 'controller'})</span>,{' '}
                {when(s.at)}
                {s.snapshotSha256 && (
                  <span className="block text-[12px] text-t3">
                    on snapshot <code>{short(s.snapshotSha256)}</code>
                    {s.seenAt ? `, shown to them ${when(s.seenAt)}` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {c.duties && (c.status !== 'locked' || c.reopened) && (
          <p className="text-[12.5px] text-t2" data-testid="duties">
            Duties: started by {c.duties.startedBy ?? '—'} · accrual accepted by {c.duties.accrualAcceptedBy ?? '—'} ·
            controller’s signature {c.duties.controllerSignedBy ?? '—'}.{' '}
            <span className="text-t3">At least two different people do these three, besides the CFO.</span>
          </p>
        )}
        {lockable && r.signer && !signed && (
          <div>
            <Button variant="primary" disabled={sign.isPending} onClick={() => sign.mutate()} data-testid="sign-lock">
              Sign the lock as {r.cfo && !c.signoffs.some((s) => s.role === 'cfo') ? 'the CFO' : 'a controller'}
            </Button>
            <p className="mt-1 text-[12px] text-t3">
              {c.snapshot
                ? `You sign snapshot ${short(c.snapshot.sha256)}, as this page shows it.`
                : 'No snapshot yet: your signature freezes one.'}
            </p>
            <Err m={sign} />
          </div>
        )}
        {lockable && signed && (
          <p className="text-t3">You signed: the other role signs next, from their own session.</p>
        )}
        {c.locks.map((l) => (
          <div key={l.round} className="rounded-[9px] border border-hair p-2.5" data-testid={`lock-${l.round}`}>
            <p className="font-medium text-t1">
              Locked{l.round ? ` again (round ${l.round})` : ''}, {when(l.at)}
            </p>
            <p className="text-t2">
              {l.signoffs.map((s) => `${s.person.name} (${s.role === 'cfo' ? 'CFO' : 'controller'})`).join(' and ')}
            </p>
            <p className="break-all text-[12px] text-t3">
              Audit entry {l.auditSeq} <code>{l.auditHash}</code>
            </p>
            <p className="break-all text-[12px] text-t3" data-testid={`lock-${l.round}-package`}>
              {l.packageSha256 ? (
                <>
                  Package stored, manifest <code>{l.packageSha256}</code>
                </>
              ) : (
                'No stored package (locked before the review of wave 4)'
              )}
            </p>
            <p className="break-all text-[12px] text-t3">
              {l.anchor ? (
                <>
                  Anchored at entry {l.anchor.seq} <code>{l.anchor.hash}</code>, {when(l.anchor.at)}
                </>
              ) : (
                'Not anchored yet'
              )}
            </p>
          </div>
        ))}
        {c.reopens.map((o) => (
          <p key={o.round} className="text-[12.5px] text-t2">
            Reopened (round {o.round}) on request {o.number ? `R-${o.number}` : o.requestId}: “{o.reason}”, asked by{' '}
            {o.requestedBy}, approved by {o.approvedBy}, {when(o.at)}
          </p>
        ))}
        {c.pendingReopen && (
          <p className="text-[12.5px] text-warn">
            A request to reopen is waiting for the CFO:{' '}
            <Link className="underline" to={`/requests/${c.pendingReopen.requestId}`}>
              {c.pendingReopen.number ? `R-${c.pendingReopen.number}` : 'open it'}
            </Link>
          </p>
        )}
        {c.status === 'locked' && !c.reopened && !c.pendingReopen && r.controller && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={input}
              placeholder="Why the locked month must reopen (the CFO decides)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="Reason to reopen"
            />
            <Button size="sm" disabled={reason.trim().length < 10 || reopen.isPending} onClick={() => reopen.mutate()}>
              Ask to reopen
            </Button>
            <Err m={reopen} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Month-end (spec 012): the close as a checklist, in order; its gates computed, never ticked by hand. */
export function ClosePage() {
  const [month, setMonth] = useMonth();
  const qc = useQueryClient();
  const r = useRoles();
  const q = useClose(month);
  const start = useMutation({
    mutationFn: () => send<CloseView>('POST', `/api/close/${month}/start`, {}),
    onSuccess: (v) => qc.setQueryData(['close', month], v),
  });
  const c = q.data;
  return (
    <div data-testid="close-page">
      <MonthBar month={month} setMonth={setMonth} right={c && statusPill(c)} />
      {!c ? (
        q.isError ? (
          <ErrorNote error={q.error} />
        ) : (
          <Lede>Loading the close…</Lede>
        )
      ) : (
        <div className="grid gap-3.5">
          <Lede className="mb-0">
            {c.dryRun
              ? `A dry run: what each gate says about ${monthLabel(month)} today. Nothing is acted on until the month has ended and a controller or the CFO starts its close.`
              : c.status === 'locked' && !c.reopened
                ? 'Locked: the checklist as it stood at the lock. Corrections post to the open month; reopening is a request the CFO decides.'
                : 'Each gate is computed by Landledger. A red step is fixed at its source, or explained with a note (never step 4 or 10). The lock takes a controller and the CFO.'}
          </Lede>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Stat label="Steps done" value={`${c.done} of 10`} testId="close-done" />
            <Stat label="Next" value={c.next ? c.steps.find((s) => s.key === c.next)!.title : 'Nothing'} small />
            <Stat label="Snapshot" value={short(c.snapshot?.sha256)} small>
              {c.snapshot ? (c.snapshot.current ? 'current' : 'the figures moved') : 'frozen at step 7'}
            </Stat>
            <Stat label="Unallocated limit" value={`${c.unallocatedLimitPct}%`} small />
          </div>
          {((c.status === 'open' && c.ended) || (c.reopened && c.roundStarted === false)) && (r.signer || r.fpa) && (
            <div>
              <Button
                variant="primary"
                disabled={start.isPending}
                onClick={() => start.mutate()}
                data-testid="start-close"
              >
                {c.reopened ? `Start round ${c.round} of the close` : `Start ${monthLabel(month)}’s close`}
              </Button>
              <Err m={start} />
            </div>
          )}
          <Card title="Checklist" sub="In order; steps 7–10 wait for the ones before them" testId="checklist">
            <ul>
              {c.steps.map((s) => (
                <Step
                  key={s.key}
                  month={month}
                  s={s}
                  canAct={
                    !c.dryRun &&
                    (c.status === 'closing' ||
                      (c.reopened && c.roundStarted !== false && (s.number > 6 || s.number === 2 || s.number === 5)))
                  }
                  canExplain={r.signer || r.fpa}
                />
              ))}
            </ul>
          </Card>
          <LockCard month={month} c={c} />
        </div>
      )}
    </div>
  );
}

// Accruals (spec 013) -----------------------------------------------------------------------------------------------

function AccrualCard({ a, month }: { a: AccrualView; month: string }) {
  const qc = useQueryClient();
  const r = useRoles();
  const accept = useMutation({
    mutationFn: () => send<AccrualView>('POST', `/api/accruals/${a.id}/accept`, { sha256: a.sha256 }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accruals', month] });
      void qc.invalidateQueries({ queryKey: ['close', month] });
      void qc.invalidateQueries({ queryKey: ['journal', month] });
      void qc.invalidateQueries({ queryKey: ['roll-forward', month] });
    },
  });
  return (
    <Card
      title={`Proposal v${a.version}`}
      sub={`${a.proposedBy}, ${when(a.proposedAt)}`}
      action={
        <Pill
          tone={a.status === 'accepted' ? 'ok' : a.status === 'superseded' ? 'nu' : 'risk'}
          data-testid="accrual-status"
        >
          {a.status === 'accepted' ? 'Accepted' : a.status === 'superseded' ? 'Superseded' : 'Proposed'}
        </Pill>
      }
      testId="accrual"
    >
      <CardBody className="grid gap-2.5 text-[13px]">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="figure text-[24px] font-semibold text-t1" data-testid="accrual-total">
            {usd(a.total)}
          </span>
          <Tag dashed>accrued liability: not yet invoiced</Tag>
        </div>
        {a.prepaidTotal && Number(a.prepaidTotal) !== 0 && (
          <p className="text-t2" data-testid="accrual-prepaid">
            Prepaid amortised in the month: <b className="figure">{usd(a.prepaidTotal)}</b>{' '}
            <span className="text-t3">(a prepaid expense, not in the liability)</span>
          </p>
        )}
        {a.acceptedBy && (
          <p className="text-t2">
            Accepted by {a.acceptedBy}, {when(a.acceptedAt)}. Snapshot <code>{short(a.snapshotSha256)}</code>
          </p>
        )}
        <ul className="grid gap-1.5">
          {a.lines.map((l) => (
            <li key={l.line} className="rounded-[9px] border border-hair px-2.5 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-t1">
                  {l.provider} · {l.item}
                </span>
                <span className="figure text-t1">{usd(l.amount)}</span>
              </div>
              <p className="text-[12px] text-t3">
                {l.costCenterName} ({l.costCenter}) · P&amp;L {l.plClass} ·{' '}
                {l.kind === 'usage' ? `${l.estimates} estimate(s)` : l.kind === 'prepaid' ? 'prepaid' : 'contract'} ·{' '}
                {l.basis}
              </p>
              {l.reversal && (
                <p className="text-[12px] text-gn">
                  Reversed in {monthLabel(l.reversal.month)} by invoice {l.reversal.invoice}
                </p>
              )}
            </li>
          ))}
          {!a.lines.length && (
            <li className="text-t3">
              Nothing to accrue: no estimate left uninvoiced, and no contract value waiting for its invoice, comes to a
              cent.
            </li>
          )}
        </ul>
        <p className="break-all text-[12px] text-t3">
          sha256 <code>{a.sha256}</code>
        </p>
        {a.status === 'proposed' && r.controller && (
          <div>
            <Button
              variant="primary"
              disabled={accept.isPending}
              onClick={() => accept.mutate()}
              data-testid="accept-accrual"
            >
              Accept as shown
            </Button>
            <p className="mt-1 text-[12px] text-t3">
              Accepting freezes the month’s snapshot and asks Landflow for variance notes.
            </p>
            <Err m={accept} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function AccrualsPage() {
  const [month, setMonth] = useMonth();
  const qc = useQueryClient();
  const r = useRoles();
  const q = useQuery({
    queryKey: ['accruals', month],
    queryFn: () => get<AccrualsView>(`/api/accruals?month=${month}`),
    retry: quiet,
  });
  const propose = useMutation({
    mutationFn: () => send<AccrualView>('POST', `/api/accruals/${month}/propose`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['accruals', month] }),
  });
  const v = q.data;
  return (
    <div data-testid="accruals-page">
      <MonthBar month={month} setMonth={setMonth} />
      <Lede>
        What is known but not yet invoiced at month-end: AI usage estimates per provider, model and cost center, and
        each contract billed monthly in arrears when its vendor hasn’t invoiced it; prepaid contracts amortise apart. A
        controller accepts it, which freezes the month’s journal; it reverses in the month its invoice posts. Landledger
        never posts to a GL: the journal is for the controller to book.
      </Lede>
      {!v ? (
        q.isError ? (
          <ErrorNote error={q.error} />
        ) : (
          <Lede>Loading accruals…</Lede>
        )
      ) : (
        <div className="grid gap-3.5">
          <div className="flex flex-wrap gap-2">
            {(r.signer || r.fpa) && (!v.current || v.current.status !== 'accepted') && (
              <Button
                variant="primary"
                disabled={propose.isPending}
                onClick={() => propose.mutate()}
                data-testid="propose-accrual"
              >
                {v.current ? 'Propose again' : 'Propose the accrual'}
              </Button>
            )}
            <a
              className="inline-flex h-9 items-center rounded-[9px] border border-bd bg-sf px-[13px] text-[14px] text-t1"
              href={`/api/accruals/journal.csv?month=${month}`}
            >
              Journal entry (CSV)
            </a>
          </div>
          <Err m={propose} />
          {v.current ? (
            <AccrualCard a={v.current} month={month} />
          ) : (
            <Lede>No accrual proposed for {monthLabel(month)} yet.</Lede>
          )}
          {v.reversalsIn.length > 0 && (
            <Card title="Reversed in this month" sub="Earlier accruals whose invoices posted here">
              <ul>
                {v.reversalsIn.map((l) => (
                  <li
                    key={`${l.accrualId}-${l.line}`}
                    className="border-t border-hair px-4 py-2 text-[13px] first:border-t-0"
                  >
                    {monthLabel(l.month)} accrual, line {l.line}: {usd(l.amount)} reversed by invoice {l.invoice}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <JournalCard month={month} />
          <RollForwardCard month={month} />
          <CoaCard />
          {v.history.filter((h) => h.id !== v.current?.id).length > 0 && (
            <Card title="Earlier versions">
              <ul>
                {v.history
                  .filter((h) => h.id !== v.current?.id)
                  .map((h) => (
                    <li key={h.id} className="border-t border-hair px-4 py-2 text-[13px] first:border-t-0">
                      v{h.version} · {h.status} · {usd(h.total)} · {h.proposedBy}
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

/** The month's journal (review of wave 4): entry ids, the GL account by the mapping, frozen at acceptance. */
function JournalCard({ month }: { month: string }) {
  const q = useQuery({
    queryKey: ['journal', month],
    queryFn: () => get<JournalView>(`/api/accruals/journal?month=${month}`),
    retry: quiet,
  });
  const j = q.data;
  const entries = new Map<string, JournalView['lines']>();
  for (const l of j?.lines ?? []) entries.set(l.entryId, [...(entries.get(l.entryId) ?? []), l]);
  return (
    <Card
      title="Journal"
      sub={
        j
          ? j.frozen
            ? `Frozen ${when(j.frozenAt)} by ${j.frozenBy} · mapping v${j.coaVersion}`
            : `Not frozen: what accepting would freeze now · mapping v${j.coaVersion}`
          : 'Loading…'
      }
      action={
        <a className="text-[13px] underline" href={`/api/accruals/journal.csv?month=${month}`}>
          CSV
        </a>
      }
      testId="journal"
    >
      <CardBody className="grid gap-2 text-[13px]">
        {j && (
          <p className="text-t2" data-testid="journal-totals">
            Debits <b className="figure">{usd(j.debits)}</b> · credits <b className="figure">{usd(j.credits)}</b> ·{' '}
            {entries.size} entr{entries.size === 1 ? 'y' : 'ies'}
          </p>
        )}
        {[...entries.entries()].map(([id, lines]) => (
          <div key={id} className="rounded-[9px] border border-hair px-2.5 py-2" data-testid="journal-entry">
            <p className="flex flex-wrap items-center justify-between gap-2">
              <code className="text-[12.5px] text-t1">{id}</code>
              <span className="text-[12px] text-t3">
                {lines[0]!.kind} · {lines[0]!.journalDate}
              </span>
            </p>
            <p className="text-[12px] text-t3">{lines[0]!.memo}</p>
            <ul className="mt-1 grid gap-0.5">
              {lines.map((l) => (
                <li key={l.line} className="flex justify-between gap-2 text-[12.5px]">
                  <span>
                    {Number(l.debit) ? 'Dr' : 'Cr'} {l.glAccount} {l.glName}{' '}
                    <span className="text-t3">
                      ({l.account}, {l.costCenter})
                    </span>
                  </span>
                  <span className="figure">{usd(Number(l.debit) ? l.debit : l.credit)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {j && !j.lines.length && <p className="text-t3">No entry for the month.</p>}
        {q.isError && <ErrorNote error={q.error} />}
      </CardBody>
    </Card>
  );
}

/** The accrued liability's roll-forward (review of wave 4): opening, additions, reversals, closing, with aging. */
function RollForwardCard({ month }: { month: string }) {
  const q = useQuery({
    queryKey: ['roll-forward', month],
    queryFn: () => get<AccrualRollForward>(`/api/accruals/roll-forward?month=${month}`),
    retry: quiet,
  });
  const f = q.data;
  const row = (label: string, value: string | undefined, bold = false) => (
    <p className={cn('flex justify-between gap-2', bold && 'font-semibold text-t1')}>
      <span>{label}</span>
      <span className="figure">{usd(value)}</span>
    </p>
  );
  return (
    <Card
      title="Accrued liability: roll-forward"
      sub={f ? (f.frozen ? 'From the frozen journal' : 'This month as accepting would freeze it') : 'Loading…'}
      testId="roll-forward"
    >
      <CardBody className="grid gap-1 text-[13px]">
        {f && (
          <>
            {row('Opening', f.opening)}
            {row('Additions (accrued this month)', f.additions)}
            {row('Superseded versions reversed', f.superseded === '0.000000' ? f.superseded : `-${f.superseded}`)}
            {row('Reversed by invoices', f.reversals === '0.000000' ? f.reversals : `-${f.reversals}`)}
            {row('Closing', f.closing, true)}
            <p className="mt-2 text-[12px] font-medium text-t2">Closing balance by age</p>
            {f.aging.map((a) => (
              <p key={a.bucket} className="flex justify-between gap-2 text-[12.5px]">
                <span>
                  {a.label} <span className="text-t3">({a.lines} line(s))</span>
                </span>
                <span className="figure">{usd(a.amount)}</span>
              </p>
            ))}
            {Number(f.prepaidAmortised) !== 0 && (
              <p className="mt-1 text-[12px] text-t3">
                Prepaid amortised in the month (apart): {usd(f.prepaidAmortised)}
              </p>
            )}
          </>
        )}
        {q.isError && <ErrorNote error={q.error} />}
      </CardBody>
    </Card>
  );
}

/** The chart-of-accounts mapping: read here; a controller proposes a new version, decided as a request. */
function CoaCard() {
  const qc = useQueryClient();
  const r = useRoles();
  const q = useQuery({ queryKey: ['coa'], queryFn: () => get<CoaMappingsView>('/api/coa'), retry: quiet });
  const [edit, setEdit] = useState<Record<string, { gl: string; name: string }> | null>(null);
  const [note, setNote] = useState('');
  const propose = useMutation({
    mutationFn: () => send('POST', '/api/coa/proposals', { mapping: edit, note }),
    onSuccess: () => {
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ['coa'] });
    },
  });
  const m = q.data;
  const pending = m?.versions.find((v) => v.status === 'proposed');
  return (
    <Card
      title="Chart-of-accounts mapping"
      sub={m ? `v${m.current.version}, approved${m.current.decidedBy ? ` by ${m.current.decidedBy}` : ''}` : 'Loading…'}
      testId="coa"
    >
      <CardBody className="grid gap-1 text-[12.5px]">
        {m &&
          !edit &&
          m.accounts.map((a) => (
            <p key={a} className="flex justify-between gap-2">
              <span className="text-t3">{a}</span>
              <span>
                {m.current.mapping[a]?.gl} {m.current.mapping[a]?.name}
              </span>
            </p>
          ))}
        {edit &&
          m!.accounts.map((a) => (
            <div key={a} className="flex flex-wrap items-center gap-2">
              <span className="w-[150px] text-t3">{a}</span>
              <input
                className={cn(input, 'max-w-[90px]')}
                value={edit[a]?.gl ?? ''}
                onChange={(e) => setEdit({ ...edit, [a]: { gl: e.target.value, name: edit[a]?.name ?? '' } })}
                aria-label={`${a} GL account`}
              />
              <input
                className={input}
                value={edit[a]?.name ?? ''}
                onChange={(e) => setEdit({ ...edit, [a]: { gl: edit[a]?.gl ?? '', name: e.target.value } })}
                aria-label={`${a} GL name`}
              />
            </div>
          ))}
        {pending && (
          <p className="text-warn">
            v{pending.version} is waiting for a decision{' '}
            {pending.requestId && (
              <Link className="underline" to={`/requests/${pending.requestId}`}>
                (the request)
              </Link>
            )}
          </p>
        )}
        {m && r.controller && !pending && !edit && (
          <div>
            <Button size="sm" onClick={() => setEdit({ ...m.current.mapping })}>
              Propose a new mapping
            </Button>
          </div>
        )}
        {edit && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={input}
              placeholder="Why (a controller or the CFO who isn't you decides)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-label="Why the mapping changes"
            />
            <Button size="sm" disabled={note.trim().length < 3 || propose.isPending} onClick={() => propose.mutate()}>
              Propose
            </Button>
            <Button size="sm" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Err m={propose} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// Variance notes (spec 015) ---------------------------------------------------------------------------------------

function NoteCard({ n, month }: { n: NoteView; month: string }) {
  const qc = useQueryClient();
  const r = useRoles();
  const last = n.versions.at(-1)!;
  const [text, setText] = useState(last.text);
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['notes', month] });
    void qc.invalidateQueries({ queryKey: ['close', month] });
  };
  const accept = useMutation({
    mutationFn: () =>
      send<NoteView>('POST', `/api/notes/${n.id}/accept`, {
        version: last.version,
        ...(editing && text.trim() !== last.text.trim() ? { text } : {}),
        comment,
      }),
    onSuccess: done,
  });
  const reject = useMutation({
    mutationFn: () => send<NoteView>('POST', `/api/notes/${n.id}/reject`, { version: last.version, reason: comment }),
    onSuccess: done,
  });
  const mine = last.sponsor?.id === r.id;
  const canDecide = r.analyst && !last.decision && n.current && !mine;
  return (
    <Card
      title={n.name}
      sub={n.costCenter === 'TOTAL' ? 'The month as a whole' : n.costCenter}
      action={
        <Pill
          tone={n.status === 'accepted' ? 'ok' : n.status === 'rejected' ? 'over' : 'risk'}
          data-testid={`note-status-${n.costCenter}`}
        >
          {n.status === 'accepted' ? `Accepted v${n.accepted}` : n.status === 'rejected' ? 'Rejected' : 'Draft'}
        </Pill>
      }
      testId={`note-${n.costCenter}`}
    >
      <CardBody className="grid gap-2 text-[13px]">
        {[...n.versions].reverse().map((v) => (
          <div
            key={v.version}
            className={cn('rounded-[9px] border border-hair p-2.5', v.version !== last.version && 'opacity-70')}
          >
            <p className="mb-1 flex flex-wrap items-center gap-1.5 text-[12px] text-t3">
              <Tag dashed={v.kind !== 'edit'}>
                v{v.version} {v.kind}
              </Tag>
              {v.agent ? `${v.agent.name} (${v.agent.system})` : v.by}
              {v.sponsor ? ` · sponsor ${v.sponsor.name}` : ''} · {when(v.at)}
            </p>
            <p className="whitespace-pre-wrap text-t1">{v.text}</p>
            {v.cites.length > 0 && (
              <p className="mt-1 text-[12px] text-t3">
                Cites{' '}
                {v.cites
                  .map((c) => `${c.figure.replace('_', ' ')}${c.key ? ` ${c.key}` : ''} ${usd(c.amount)}`)
                  .join(' · ')}
                , checked against <code>{short(v.snapshotSha256)}</code>
              </p>
            )}
            {v.decision && (
              <p className="mt-1 text-[12px] text-t2">
                {v.decision.outcome === 'accepted' ? 'Accepted' : 'Rejected'} by {v.decision.by}, {when(v.decision.at)}
                {v.decision.comment ? `: “${v.decision.comment}”` : ''}
              </p>
            )}
          </div>
        ))}
        {canDecide && (
          <div className="grid gap-2">
            {editing && (
              <textarea
                className="min-h-24 rounded-[9px] border border-bd bg-sf p-2.5 text-[13px]"
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-label="Edited note"
              />
            )}
            <input
              className={input}
              placeholder="Comment (a reason to reject)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              aria-label="Comment"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={accept.isPending}
                onClick={() => accept.mutate()}
                data-testid={`accept-note-${n.costCenter}`}
              >
                {editing ? 'Accept edited' : 'Accept'}
              </Button>
              <Button size="sm" onClick={() => setEditing((e) => !e)}>
                {editing ? 'Keep the draft' : 'Edit…'}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={comment.trim().length < 3 || reject.isPending}
                onClick={() => reject.mutate()}
              >
                Reject
              </Button>
            </div>
            <Err m={accept} />
            <Err m={reject} />
          </div>
        )}
        {mine && !last.decision && (
          <p className="text-[12px] text-t3">You sponsor the agent that drafted it: another analyst decides.</p>
        )}
      </CardBody>
    </Card>
  );
}

export function NotesPage() {
  const [month, setMonth] = useMonth();
  const qc = useQueryClient();
  const r = useRoles();
  const q = useQuery({
    queryKey: ['notes', month],
    queryFn: () => get<NotesView>(`/api/notes?month=${month}`),
    retry: quiet,
  });
  const template = useMutation({
    mutationFn: () => send('POST', `/api/notes/${month}/template`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notes', month] }),
  });
  const v = q.data;
  const missing = v ? v.needed.filter((f) => !v.notes.some((n) => n.costCenter === f.costCenter && n.current)) : [];
  return (
    <div data-testid="notes-page">
      <MonthBar month={month} setMonth={setMonth} />
      <Lede>
        Actual against budget and against the day-10 forecast, with the drivers. Landflow’s agent drafts each note with
        a <code>notes:draft</code> key; every figure it cites is checked against the frozen snapshot. An analyst
        (FP&amp;A or a controller, never the agent’s sponsor) accepts, edits or rejects; every version is kept.
      </Lede>
      {!v ? (
        q.isError ? (
          <ErrorNote error={q.error} />
        ) : (
          <Lede>Loading notes…</Lede>
        )
      ) : !v.snapshotSha256 ? (
        <Lede>No snapshot for {monthLabel(month)} yet: accepting the accrual (step 7) freezes it.</Lede>
      ) : (
        <div className="grid gap-3.5">
          <p className="text-[12.5px] text-t3">
            Snapshot <code>{short(v.snapshotSha256)}</code>
            {v.requestedAt ? ` · drafts asked of Landflow ${when(v.requestedAt)}` : ''}
          </p>
          {missing.length > 0 && r.person && (
            <Card
              title={`${missing.length} note(s) with no draft`}
              sub="When no agent answers, draft them from the template"
            >
              <CardBody>
                <p className="mb-2 text-[13px] text-t2">{missing.map((m) => m.name).join(', ')}</p>
                <Button
                  size="sm"
                  disabled={template.isPending}
                  onClick={() => template.mutate()}
                  data-testid="template-notes"
                >
                  Draft from the template
                </Button>
                <Err m={template} />
              </CardBody>
            </Card>
          )}
          {v.notes.map((n) => (
            <NoteCard key={n.id} n={n} month={month} />
          ))}
          <Card title="Figures a note may cite" sub="From the snapshot">
            <ul>
              {v.needed.map((f) => (
                <li key={f.costCenter} className="border-t border-hair px-4 py-2 text-[12.5px] first:border-t-0">
                  <b className="text-t1">{f.name}</b>: actual {usd(f.actual)}
                  {f.notional && Number(f.notional) !== 0 ? ` (notional ${usd(f.notional)}, never booked)` : ''} ·
                  budget {usd(f.budget)} · last forecast stored by day 10 {usd(f.forecastDay10)}
                  {f.drivers.length
                    ? ` · drivers ${f.drivers.map((d) => `${d.label} ${usd(d.change)}`).join(', ')}`
                    : ''}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

// Datarails (spec 017) ---------------------------------------------------------------------------------------------

function PullCard({ p }: { p: DatarailsPullView }) {
  const qc = useQueryClient();
  const r = useRoles();
  const [reason, setReason] = useState('');
  const done = () => void qc.invalidateQueries({ queryKey: ['datarails'] });
  const accept = useMutation({
    mutationFn: () => send('POST', `/api/datarails/budgets/pulls/${p.id}/accept`, { sha256: p.sha256 }),
    onSuccess: done,
  });
  const reject = useMutation({
    mutationFn: () => send('POST', `/api/datarails/budgets/pulls/${p.id}/reject`, { reason }),
    onSuccess: done,
  });
  return (
    <Card
      title={p.dataModel}
      sub={`${p.rows} rows · ${p.months.map(monthLabel).join(', ')}`}
      action={
        <Pill
          tone={p.status === 'accepted' ? 'ok' : p.status === 'rejected' ? 'over' : 'risk'}
          data-testid={`pull-status-${p.id}`}
        >
          {p.status === 'accepted' ? `Budget v${p.budgetVersion}` : p.status === 'rejected' ? 'Rejected' : 'Pending'}
        </Pill>
      }
      testId="pull"
    >
      <CardBody className="grid gap-2 text-[13px]">
        <p className="text-t2">
          Pulled by {p.pulledBy}, {when(p.pulledAt)} · total {usd(p.total)}
          {p.decidedBy ? ` · ${p.status} by ${p.decidedBy}, ${when(p.decidedAt)}` : ''}
        </p>
        <p className="break-all text-[12px] text-t3">
          sha256 <code>{p.sha256}</code>
        </p>
        <ul className="grid gap-1">
          {p.preview
            .filter((x) => x.month === p.months[0])
            .map((x) => (
              <li key={`${x.costCenter}-${x.month}`} className="flex justify-between gap-2 text-[12.5px]">
                <span>{x.costCenter}</span>
                <span className="figure">
                  {usd(x.amount)} <span className="text-t3">(now {usd(x.current)})</span>
                </span>
              </li>
            ))}
        </ul>
        <p className="text-[12px] text-t3">{monthLabel(p.months[0]!)} shown; the other months follow the same rows.</p>
        {p.status === 'pending' && r.signer && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={accept.isPending}
              onClick={() => accept.mutate()}
              data-testid="accept-pull"
            >
              Accept as a budget version
            </Button>
            <input
              className={input}
              placeholder="Why reject"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="Why reject"
            />
            <Button
              size="sm"
              variant="danger"
              disabled={reason.trim().length < 3 || reject.isPending}
              onClick={() => reject.mutate()}
            >
              Reject
            </Button>
            <Err m={accept} />
            <Err m={reject} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function DatarailsPage() {
  const [month, setMonth] = useMonth();
  const qc = useQueryClient();
  const r = useRoles();
  const [scenario, setScenario] = useState('Budget FY27');
  const q = useQuery({ queryKey: ['datarails'], queryFn: () => get<DatarailsStatus>('/api/datarails'), retry: quiet });
  const upload = useMutation({
    mutationFn: () => send('POST', '/api/datarails/uploads', { month }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['datarails'] });
      void qc.invalidateQueries({ queryKey: ['close', month] });
    },
  });
  const pull = useMutation({
    mutationFn: () => send('POST', '/api/datarails/budgets/pull', { dataModel: 'Budget', scenario, note: '' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['datarails'] }),
  });
  const v = q.data;
  const uploads = v?.uploads.filter((u) => u.month === month) ?? [];
  return (
    <div data-testid="datarails-page">
      <MonthBar month={month} setMonth={setMonth} />
      <Lede>
        Budgets come in from Datarails as a pending change a controller or the CFO accepts; the month’s actuals go out
        from the frozen snapshot with the accepted notes (step 9). This is the fake on this machine: a real tenant is
        wave 5 and needs <code>LANDLEDGER_DATARAILS_REAL=true</code>.
      </Lede>
      {!v ? (
        q.isError ? (
          <ErrorNote error={q.error} />
        ) : (
          <Lede>Loading Datarails…</Lede>
        )
      ) : (
        <div className="grid gap-3.5">
          <Card
            title="Connection"
            action={<Pill tone={v.loopback ? 'ok' : 'over'}>{v.loopback ? 'This machine' : 'Remote'}</Pill>}
          >
            <CardBody className="grid gap-1 break-all text-[12.5px] text-t2">
              <span>MCP {v.mcpUrl}</span>
              <span>Upload {v.uploadUrl}</span>
              <span>
                FileBox {v.filebox} · {v.configured ? 'credentials set' : 'credentials missing'} · real tenant{' '}
                {v.real ? 'on' : 'off'}
              </span>
            </CardBody>
          </Card>
          <Card
            title={`Actuals for ${monthLabel(month)}`}
            sub="The snapshot’s figures by cost center and the accepted notes"
            testId="uploads"
          >
            <CardBody className="grid gap-2 text-[13px]">
              {r.signer && (
                <div>
                  <Button
                    variant="primary"
                    disabled={upload.isPending}
                    onClick={() => upload.mutate()}
                    data-testid="upload"
                  >
                    Upload to Datarails
                  </Button>
                  <Err m={upload} />
                </div>
              )}
              {uploads.map((u) => (
                <div key={u.id} className="rounded-[9px] border border-hair p-2.5">
                  <p className="font-medium text-t1">
                    <Pill tone={u.ok ? 'ok' : 'over'}>{u.ok ? 'Uploaded' : 'Failed'}</Pill> HTTP {u.status} ·{' '}
                    {u.uploadedBy}, {when(u.uploadedAt)}
                  </p>
                  <p className="mt-1 break-all text-[12px] text-t3">
                    Snapshot <code>{u.snapshotSha256}</code>
                  </p>
                  <ul className="mt-1 text-[12px] text-t2">
                    {u.files.map((f) => (
                      <li key={f.name} className="break-all">
                        {f.name} ({f.rows} rows) <code className="text-t3">{short(f.sha256)}</code>
                      </li>
                    ))}
                  </ul>
                  {typeof u.response.upload_id === 'string' && (
                    <p className="text-[12px] text-t3">Datarails upload {u.response.upload_id}</p>
                  )}
                </div>
              ))}
              {!uploads.length && <p className="text-t3">Nothing uploaded for {monthLabel(month)}.</p>}
            </CardBody>
          </Card>
          <Card
            title="Budgets from Datarails"
            sub="Pulled over MCP, read tools only; nothing changes until a person accepts"
            testId="pulls"
          >
            <CardBody className="grid gap-2">
              {r.signer && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className={input}
                    value={scenario}
                    onChange={(e) => setScenario(e.target.value)}
                    aria-label="Scenario"
                  />
                  <Button size="sm" disabled={pull.isPending} onClick={() => pull.mutate()} data-testid="pull">
                    Pull the budget
                  </Button>
                  <Err m={pull} />
                </div>
              )}
            </CardBody>
          </Card>
          {v.pulls.map((p) => (
            <PullCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}

// The package (spec 018) --------------------------------------------------------------------------------------------

export function PackagePage() {
  const [month, setMonth] = useMonth();
  const q = useQuery({
    queryKey: ['package', month],
    queryFn: () => get<MonthEndPackage>(`/api/close/${month}/package`),
    retry: quiet,
  });
  const p = q.data;
  return (
    <div data-testid="package-page">
      <MonthBar month={month} setMonth={setMonth} right={p && statusPill(p.close)} />
      <Lede>
        One page and one download for the auditors: the snapshot, the checklist, reconciliation, the accrual and its
        journal entry, the accepted notes, exceptions, anomalies closed, decisions in the month, the Datarails upload
        and the chain proof.
      </Lede>
      {!p ? (
        q.isError ? (
          <ErrorNote error={q.error} />
        ) : (
          <Lede>Building the package…</Lede>
        )
      ) : (
        <div className="grid gap-3.5">
          <div className="flex flex-wrap gap-2">
            <a
              className="inline-flex h-9 items-center rounded-[9px] border border-ac2 bg-ac2 px-[13px] text-[14px] font-medium text-on-ac"
              href={`/api/close/${month}/package?format=html`}
              target="_blank"
              rel="noreferrer"
            >
              Open the printable page
            </a>
            <a
              className="inline-flex h-9 items-center rounded-[9px] border border-bd bg-sf px-[13px] text-[14px] text-t1"
              href={`/api/close/${month}/package.zip`}
            >
              Download the zip
            </a>
          </div>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Stat label="Total" value={usd(p.snapshot?.figures.total.total)}>
              {p.snapshot ? 'from the snapshot' : 'no snapshot yet'}
            </Stat>
            <Stat label="Accrued" value={usd(p.accrual?.total)}>
              {p.accrual?.status ?? 'none'}
            </Stat>
            <Stat
              label="Notes accepted"
              value={`${p.notes.filter((n) => n.status === 'accepted').length} of ${p.snapshot?.figures.notes.length ?? 0}`}
              small
            />
            <Stat label="Chain" value={p.chain.ok ? 'Whole' : 'Broken'} small>
              {p.chain.checked} entries checked
            </Stat>
          </div>
          <Card
            title="Snapshot"
            sub={p.snapshot ? `Frozen ${when(p.snapshot.frozenAt)} by ${p.snapshot.frozenBy}` : 'Frozen at step 7'}
          >
            <CardBody className="grid gap-1.5 text-[13px]">
              <p className="break-all text-[12px] text-t3">
                sha256 <code>{p.snapshot?.sha256 ?? '—'}</code>
              </p>
              {p.snapshot?.figures.byCostCenter.map((c) => (
                <p key={c.code} className="flex justify-between gap-2">
                  <span>{c.name}</span>
                  <span className="figure">{usd(c.total)}</span>
                </p>
              ))}
            </CardBody>
          </Card>
          <Card title="Stored package" testId="stored-package">
            <CardBody className="grid gap-1 break-all text-[12.5px] text-t2">
              {p.stored ? (
                <>
                  <span>
                    Stored when round {p.stored.round} locked, {when(p.stored.builtAt)} ({p.stored.builtBy})
                  </span>
                  <span>
                    Manifest sha256 <code data-testid="package-sha">{p.stored.sha256}</code>
                  </span>
                  <span className="text-t3">
                    The lock’s audit entry records this hash; the files below are served as stored.
                  </span>
                </>
              ) : (
                <span className="text-t3">
                  Built now: the month isn’t locked
                  {p.close.locks.length ? ' (or was locked before the review of wave 4)' : ''}, so nothing is stored
                  yet.
                </span>
              )}
            </CardBody>
          </Card>
          <Card title="Chain proof" testId="chain">
            <CardBody className="grid gap-1 break-all text-[12.5px] text-t2">
              <span>
                Head <code>{p.chain.head}</code>
              </span>
              <span>
                Lock entry{' '}
                {p.chain.lock ? (
                  <>
                    {p.chain.lock.seq} <code>{p.chain.lock.hash}</code>
                  </>
                ) : (
                  '— (not locked)'
                )}
              </span>
              <span>
                Anchor{' '}
                {p.chain.anchor ? (
                  <>
                    {p.chain.anchor.seq} <code>{p.chain.anchor.hash}</code>, {when(p.chain.anchor.at)}
                  </>
                ) : (
                  '—'
                )}
              </span>
            </CardBody>
          </Card>
          <Card title="Decisions in the month" sub={`${p.decisions.length}`}>
            <ul>
              {p.decisions.slice(0, 20).map((d) => (
                <li
                  key={`${d.requestId}-${d.step}`}
                  className="border-t border-hair px-4 py-2 text-[12.5px] first:border-t-0"
                >
                  {d.number ? `R-${d.number}` : d.requestId} {d.title}: step {d.step} {d.outcome} by {d.person}
                </li>
              ))}
              {!p.decisions.length && <li className="px-4 pb-3 text-[12.5px] text-t3">None.</li>}
            </ul>
          </Card>
          <Card title="Files" sub="Each with its sha256 (manifest.csv in the zip)">
            <ul>
              {p.files.map((f) => (
                <li key={f.name} className="break-all border-t border-hair px-4 py-2 text-[12.5px] first:border-t-0">
                  {f.name} <span className="text-t3">({f.rows} rows)</span>{' '}
                  <code className="text-t3">{short(f.sha256)}</code>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}
