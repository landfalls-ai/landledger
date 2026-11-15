import type { AnomalyOutcome, AnomalyRule, AnomalyView } from '@landledger/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ErrorNote, Lede } from '@/components/spend/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pill, Tag } from '@/components/ui/pill';
import { get, quiet, send } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { dayLabel, usd } from '@/lib/format';

export const RULE_LABEL: Record<AnomalyRule, string> = {
  cost_jump: 'Cost jump',
  split: 'Split under the threshold',
  automatic_ratchet: 'Automatic again and again',
  fast_relay: 'Decided seconds after the card',
  same_pair: 'One approver for one requester',
};

const DIMENSION_LABEL: Record<string, string> = {
  costCenter: 'Cost center',
  service: 'Service',
  agent: 'Agent',
  model: 'Model',
  requester: 'Requester',
  approver: 'Approver',
  request: 'Request',
};

/** Open anomalies (not closed, however old): for Overview's Needs you, which shows the unacknowledged and yours. */
export function useOpenAnomalies() {
  return useQuery({
    queryKey: ['anomalies', 'open'],
    queryFn: () => get<{ anomalies: AnomalyView[] }>('/api/anomalies?status=open&limit=50'),
    retry: quiet,
    refetchInterval: 300_000,
  });
}

/** The signed-in person's id when they may act on anomalies (not only an auditor); the API checks again. */
function useActor(): string | null {
  const me = useMe().data;
  if (!me || me.kind !== 'person') return null;
  return me.user.roles.some((r) => r !== 'auditor') ? me.user.id : null;
}

const OUTCOME_LABEL: Record<AnomalyOutcome, string> = {
  expected: 'Expected',
  fixed: 'Fixed',
  false_positive: 'False positive',
};

const field = 'h-[30px] min-w-0 rounded-[9px] border border-bd bg-sf px-2.5 text-[13px]';

/** Acknowledge, assign or close: one form at a time, each with a note, each audited. */
function Actions({ a }: { a: AnomalyView }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<null | 'acknowledge' | 'assign' | 'close'>(null);
  const [note, setNote] = useState('');
  const [email, setEmail] = useState('');
  const [outcome, setOutcome] = useState<AnomalyOutcome>('expected');
  const act = useMutation({
    mutationFn: () =>
      send<AnomalyView>(
        'POST',
        `/api/anomalies/${a.id}/${mode}`,
        mode === 'assign'
          ? { assignee: { email: email.trim() }, note }
          : mode === 'close'
            ? { outcome, note }
            : { note },
      ),
    onSuccess: () => {
      setMode(null);
      setNote('');
      void qc.invalidateQueries({ queryKey: ['anomalies'] });
    },
  });
  if (!mode)
    return (
      <div className="flex flex-wrap gap-2">
        {!a.acknowledged && (
          <Button size="sm" onClick={() => setMode('acknowledge')} data-testid={`ack-${a.id}`}>
            Acknowledge…
          </Button>
        )}
        <Button size="sm" onClick={() => setMode('assign')} data-testid={`assign-${a.id}`}>
          {a.assignee ? 'Reassign…' : 'Assign…'}
        </Button>
        <Button size="sm" onClick={() => setMode('close')} data-testid={`close-${a.id}`}>
          Close…
        </Button>
      </div>
    );
  const ready = note.trim().length >= 3 && (mode !== 'assign' || /.+@.+/.test(email.trim())) && !act.isPending;
  return (
    <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">
      {mode === 'assign' && (
        <input
          className={`${field} sm:w-56`}
          placeholder="name@landbright.test"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Assign to (email)"
        />
      )}
      {mode === 'close' && (
        <select
          className={`${field} sm:w-40`}
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as AnomalyOutcome)}
          aria-label="Outcome"
        >
          {(Object.keys(OUTCOME_LABEL) as AnomalyOutcome[]).map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABEL[o]}
            </option>
          ))}
        </select>
      )}
      <input
        className={`${field} sm:flex-1`}
        placeholder={
          mode === 'assign' ? 'What to look at' : mode === 'close' ? 'What it was, and what was done' : 'What you saw'
        }
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label="Note"
      />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={!ready} onClick={() => act.mutate()}>
          {mode === 'assign' ? 'Assign' : mode === 'close' ? 'Close' : 'Acknowledge'}
        </Button>
        <Button size="sm" onClick={() => setMode(null)}>
          Cancel
        </Button>
      </div>
      {act.isError && <p className="w-full text-[12px] text-rd">{act.error.message}</p>}
    </div>
  );
}

export function AnomalyItem({ a, me, highlight }: { a: AnomalyView; me: string | null; highlight?: boolean }) {
  const escalated = a.alerts > 1 || a.current !== a.observed;
  return (
    <li
      className={`border-t border-hair px-4 py-3 first:border-t-0 ${highlight ? 'bg-acdim' : ''}`}
      data-testid={`anomaly-${a.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={a.status === 'closed' ? 'nu' : a.kind === 'cost' ? 'risk' : 'over'}>{RULE_LABEL[a.rule]}</Pill>
        <Tag>{a.status === 'closed' ? 'Closed' : a.status === 'acknowledged' ? 'Acknowledged' : 'Open'}</Tag>
        {a.alerts > 1 && <Tag>Alerted {a.alerts}×</Tag>}
        {a.dev && <Tag dashed>dev test</Tag>}
      </div>
      <p className="mt-1 text-[12px] text-t3">
        {DIMENSION_LABEL[a.dimension] ?? a.dimension} · {a.label} · {dayLabel(a.windowStart.slice(0, 10))}
      </p>
      <p className="mt-1 text-[14px] text-t1">{a.summary}.</p>
      {a.kind === 'cost' && a.observed && (
        <p className="figure mt-0.5 text-[12px] text-t3">
          {escalated && a.current ? (
            <>
              Now {usd(a.current)} (first seen at {usd(a.observed)}) against a median of {usd(a.baseline)}
            </>
          ) : (
            <>
              {usd(a.observed)} against a median of {usd(a.baseline)}
            </>
          )}
          {a.score ? ` · robust score ${a.score}` : ''}
        </p>
      )}
      {a.requests.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-x-3 text-[13px]">
          {a.requests.map((r) => (
            <Link key={r.id} to={`/approvals/${r.id}`} className="underline decoration-hair underline-offset-2">
              {r.number} {r.title}
            </Link>
          ))}
        </p>
      )}
      <div className="mt-2 grid gap-1 text-[12px] text-t3">
        {a.acknowledged && (
          <p>
            Acknowledged by {a.acknowledged.by} on {dayLabel(a.acknowledged.at.slice(0, 10))}: {a.acknowledged.note}
          </p>
        )}
        {a.assignee && !a.closed && (
          <p data-testid={`assignee-${a.id}`}>
            Assigned to {a.assignee.name} by {a.assignee.by} on {dayLabel(a.assignee.at.slice(0, 10))}
          </p>
        )}
        {a.closed && (
          <p data-testid={`closed-${a.id}`}>
            Closed as {OUTCOME_LABEL[a.closed.outcome].toLowerCase()} by {a.closed.by} on{' '}
            {dayLabel(a.closed.at.slice(0, 10))}: {a.closed.note}
          </p>
        )}
      </div>
      {!a.closed && me && (
        <div className="mt-2">
          {a.named.includes(me) ? (
            <p className="text-[12px] text-t3">
              This pattern names you: someone else acknowledges, assigns or closes it.
            </p>
          ) : (
            <Actions a={a} />
          )}
        </div>
      )}
    </li>
  );
}

/** Anomalies (spec 007): cost jumps against a robust baseline, and approval patterns, with who acknowledged each. */
export function AnomaliesPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') === 'all' ? 'all' : 'open';
  const focus = params.get('id');
  const me = useActor();
  const q = useQuery({
    queryKey: ['anomalies', status],
    queryFn: () => get<{ anomalies: AnomalyView[] }>(`/api/anomalies?status=${status}&limit=200`),
    retry: quiet,
  });
  if (!q.data) return q.isError ? <ErrorNote error={q.error} /> : <Lede>Loading anomalies…</Lede>;
  const all = q.data.anomalies;
  const cost = all.filter((a) => a.kind === 'cost');
  const approval = all.filter((a) => a.kind === 'approval');
  return (
    <div data-testid="anomalies" className="grid gap-3.5">
      <Lede>
        Cost per cost center, service, agent and model, checked every hour against the 14 days before (median and MAD);
        and approval patterns that look like a control being worked around. Each goes out as a webhook and, for cost, to
        Clickland’s alert, and again when the figure doubles. A person acknowledges, assigns and closes each with an
        outcome and a note; it stays open until closed, however old. Nobody acts on a pattern that names them.
      </Lede>
      <div className="flex gap-2">
        <Button size="sm" variant={status === 'open' ? 'primary' : undefined} onClick={() => setParams({})}>
          Open
        </Button>
        <Button
          size="sm"
          variant={status === 'all' ? 'primary' : undefined}
          onClick={() => setParams({ status: 'all' })}
        >
          All
        </Button>
      </div>
      {[
        { title: 'Cost', rows: cost, empty: 'No cost anomaly.', testId: 'cost-anomalies' },
        { title: 'Approval patterns', rows: approval, empty: 'No approval pattern.', testId: 'approval-anomalies' },
      ].map((g) => (
        <Card
          key={g.title}
          title={g.title}
          sub={`${g.rows.length} ${status === 'open' ? 'open' : 'in all'}`}
          testId={g.testId}
        >
          {g.rows.length ? (
            <ul>
              {g.rows.map((a) => (
                <AnomalyItem key={a.id} a={a} me={me} highlight={a.id === focus} />
              ))}
            </ul>
          ) : (
            <div className="px-4 py-7 text-center text-[13px] text-t3">{g.empty}</div>
          )}
        </Card>
      ))}
    </div>
  );
}
