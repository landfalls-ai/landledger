import type { AnomalyRule, AnomalyView } from '@landledger/contracts';
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

/** Open anomalies (not acknowledged, the last 14 days): for Overview's Needs you. */
export function useOpenAnomalies() {
  return useQuery({
    queryKey: ['anomalies', 'open'],
    queryFn: () => get<{ anomalies: AnomalyView[] }>('/api/anomalies?status=open&limit=50'),
    retry: quiet,
    refetchInterval: 300_000,
  });
}

/** May this person acknowledge: signed in, and not only an auditor (the API checks again). */
function useCanAcknowledge(): boolean {
  const me = useMe().data;
  if (!me || me.kind !== 'person') return false;
  return me.user.roles.some((r) => r !== 'auditor');
}

function Acknowledge({ a }: { a: AnomalyView }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const ack = useMutation({
    mutationFn: () => send<AnomalyView>('POST', `/api/anomalies/${a.id}/acknowledge`, { note }),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['anomalies'] });
    },
  });
  if (!open)
    return (
      <Button size="sm" onClick={() => setOpen(true)} data-testid={`ack-${a.id}`}>
        Acknowledge…
      </Button>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="h-[30px] min-w-0 flex-1 rounded-[9px] border border-bd bg-sf px-2.5 text-[13px]"
        placeholder="What it was, or what you did"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label="Note"
      />
      <Button
        size="sm"
        variant="primary"
        disabled={note.trim().length < 3 || ack.isPending}
        onClick={() => ack.mutate()}
      >
        Acknowledge
      </Button>
      <Button size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {ack.isError && <p className="w-full text-[12px] text-rd">{ack.error.message}</p>}
    </div>
  );
}

export function AnomalyItem({ a, canAct, highlight }: { a: AnomalyView; canAct: boolean; highlight?: boolean }) {
  return (
    <li
      className={`border-t border-hair px-4 py-3 first:border-t-0 ${highlight ? 'bg-acdim' : ''}`}
      data-testid={`anomaly-${a.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={a.acknowledged ? 'nu' : a.kind === 'cost' ? 'risk' : 'over'}>{RULE_LABEL[a.rule]}</Pill>
        <span className="text-[12px] text-t3">
          {DIMENSION_LABEL[a.dimension] ?? a.dimension} · {a.label} · {dayLabel(a.windowStart.slice(0, 10))}
        </span>
        {a.dev && <Tag dashed>dev test</Tag>}
      </div>
      <p className="mt-1 text-[14px] text-t1">{a.summary}.</p>
      {a.kind === 'cost' && a.observed && (
        <p className="figure mt-0.5 text-[12px] text-t3">
          {usd(a.observed)} against a median of {usd(a.baseline)}
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
      <div className="mt-2">
        {a.acknowledged ? (
          <p className="text-[12px] text-t3">
            Acknowledged by {a.acknowledged.by} on {dayLabel(a.acknowledged.at.slice(0, 10))}: {a.acknowledged.note}
          </p>
        ) : (
          canAct && <Acknowledge a={a} />
        )}
      </div>
    </li>
  );
}

/** Anomalies (spec 007): cost jumps against a robust baseline, and approval patterns, with who acknowledged each. */
export function AnomaliesPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') === 'all' ? 'all' : 'open';
  const focus = params.get('id');
  const canAct = useCanAcknowledge();
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
        Clickland’s alert. A person acknowledges each with a note.
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
                <AnomalyItem key={a.id} a={a} canAct={canAct} highlight={a.id === focus} />
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
