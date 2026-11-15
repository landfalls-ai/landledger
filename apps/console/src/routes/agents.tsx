import type { AgentRow, AgentSuggestion, AgentsView } from '@landledger/contracts';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { ErrorNote, Lede } from '@/components/spend/bits';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pill, type PillTone, Tag } from '@/components/ui/pill';
import { get, quiet } from '@/lib/api';
import { monthLabel, usd } from '@/lib/format';

export const SUGGESTION: Record<AgentSuggestion, { label: string; tone: PillTone }> = {
  scale: { label: 'Scale', tone: 'ok' },
  keep: { label: 'Keep', tone: 'nu' },
  review: { label: 'Review', tone: 'risk' },
  retire: { label: 'Retire', tone: 'over' },
  not_measured: { label: 'Outcomes not measured', tone: 'nu' },
};

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-t3">{label}</div>
      <div className="figure text-[15px] font-medium text-t1">{value}</div>
      {sub && <div className="text-[11.5px] text-t3">{sub}</div>}
    </div>
  );
}

function AgentCard({ a }: { a: AgentRow }) {
  const s = SUGGESTION[a.suggestion];
  return (
    <li className="border-t border-hair px-4 py-3.5 first:border-t-0" data-testid={`agent-${a.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="font-medium text-t1">{a.name}</span>
          <small className="block text-[12px] text-t3">
            {a.costCenter ? `${a.costCenter.name} (${a.costCenter.code})` : 'No cost center yet'}
            {a.owner ? ` · owner ${a.owner}` : ''}
          </small>
        </span>
        <Pill tone={s.tone} data-testid={`suggestion-${a.id}`}>
          {s.label}
        </Pill>
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        <Figure
          label="Cost"
          value={usd(a.cost.total)}
          sub={a.cost.invoiced !== '0.000000' ? `${usd(a.cost.invoiced)} invoiced` : 'estimated'}
        />
        <Figure
          label="Runs · outcomes"
          value={
            a.value ? (a.measured ? `${a.value.runs} · ${a.value.outcomes}` : `${a.value.runs} · not measured`) : '—'
          }
          sub={
            a.value && a.measured
              ? `self-reported${a.value.successRate ? `, ${Math.round(Number(a.value.successRate) * 100)}% succeeded` : ''}`
              : undefined
          }
        />
        <Figure
          label="Cost per outcome"
          value={a.costPerOutcome ? usd(a.costPerOutcome) : '—'}
          sub={a.measured ? undefined : 'outcomes not measured'}
        />
        <Figure
          label="Capacity freed"
          value={a.value ? `${a.value.hoursSaved} h` : '—'}
          sub={a.value ? `${usd(a.value.value)} of capacity` : undefined}
        />
      </div>
      <p className="mt-2 text-[12.5px] text-t2" data-testid={`why-${a.id}`}>
        {a.why}.
      </p>
    </li>
  );
}

/** Agents (spec 008): each AI agent's month as a unit, and a suggestion an owner decides on. */
export function AgentsPage() {
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? new Date().toISOString().slice(0, 7);
  const q = useQuery({
    queryKey: ['agents', month],
    queryFn: () => get<AgentsView>(`/api/agents?month=${month}`),
    retry: quiet,
  });
  const v = q.data;
  const shift = (n: number) => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    setParams({ month: new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7) });
  };
  if (!v) return q.isError ? <ErrorNote error={q.error} /> : <Lede>Loading agents…</Lede>;
  const t = v.totals;
  return (
    <div data-testid="agents" className="grid gap-3.5">
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
        Each agent’s month: what it cost (Landledger’s ledger), what it did (Clickland’s Agent Value), what one outcome
        costs, and the time it gave back. Outcomes are <Tag dashed>self-reported</Tag> by the agents’ own telemetry, and
        an agent no outcome definition covers says “Outcomes not measured” rather than Retire. Capacity freed is{' '}
        <Tag dashed>capacity, not cash</Tag>. The suggestion is a rule, shown beside it; the agent’s owner decides.
      </Lede>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        {[
          ['Agents’ cost', usd(t.cost)],
          ['Outcomes (measured)', String(t.outcomes)],
          ['Hours freed', t.hoursSaved],
          ['Capacity', usd(t.capacity)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[14px] border border-hair bg-sf px-3.5 py-3">
            <div className="text-[12px] text-t3">{label}</div>
            <div className="figure mt-0.5 text-[18px] font-semibold text-t1">{value}</div>
          </div>
        ))}
      </div>
      <p className="text-[12.5px] text-t3" data-testid="clickland-note">
        {v.clickland.status !== 'ok' && (
          <Tag>{v.clickland.status === 'unconfigured' ? 'no Clickland key' : 'Clickland down'}</Tag>
        )}{' '}
        {v.clickland.note}. {v.computeNote}.
      </p>
      <Card title="Agents" sub={`${v.agents.length} in ${monthLabel(v.month)}, by cost`} testId="agents-list">
        {v.agents.length ? (
          <ul>
            {v.agents.map((a) => (
              <AgentCard key={a.id} a={a} />
            ))}
          </ul>
        ) : (
          <div className="px-4 py-7 text-center text-[13px] text-t3">No agent cost or runs in this month.</div>
        )}
      </Card>
    </div>
  );
}
