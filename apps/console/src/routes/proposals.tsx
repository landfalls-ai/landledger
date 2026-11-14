import type {
  PolicyStepDef,
  PolicyView,
  ProposalCreated,
  ProposalPreview,
  RateCardVersion,
  RequestSummary,
  RuleSetVersionView,
} from '@landledger/contracts';
import { REQUEST_KIND_LABEL } from '@landledger/contracts';
import { Decimal } from '@landledger/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { get, quiet, send } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { toTsv } from '@/lib/copy';
import { signed, usd } from '@/lib/format';
import { amountWords, useRequests } from '@/lib/requests';
import { unitWords } from './rules';

const input =
  'h-9 w-full min-w-0 rounded-[9px] border border-bd bg-sf px-2.5 text-[14px] text-t1 outline-none focus:border-t2';
const label = 'mb-1 block text-[12px] text-t3';

/** Tomorrow in UTC: the earliest day a proposal can take effect from without rewriting today. */
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** May the signed-in caller raise a proposal (a person with `requests:write`)? */
function useCanPropose(): boolean {
  const me = useMe().data;
  return !!me && me.kind === 'person' && (me.scopes.includes('requests:write') || me.scopes.includes('admin'));
}

// Policies -------------------------------------------------------------------------------------------------------------

/** A step's condition in words: `from $500`, `above $5,000, or at risk`, `always`. */
export function whenWords(s: PolicyStepDef): string {
  const w = s.when;
  if (w.always) return 'Always';
  const parts = [
    w.amountAtLeast && `from ${amountWords(w.amountAtLeast)}`,
    w.amountAbove && `above ${amountWords(w.amountAbove)}`,
    w.costCenterAtRisk && 'when at risk or over',
  ].filter(Boolean);
  return parts.length ? parts.join(', or ') : 'Never';
}

const approversWords = (s: PolicyStepDef) =>
  [s.approvers.costCenterOwner && 'the cost center’s owner', ...s.approvers.groups].filter(Boolean).join(', else ');

function PolicyRows({ policies }: { policies: PolicyView[] }) {
  const labels = [...new Set(policies.flatMap((p) => p.steps.map((s) => s.label)))];
  const columns: Column<PolicyView>[] = [
    {
      header: 'Request kind',
      cell: (p) => (
        <span>
          <b className="font-semibold">{REQUEST_KIND_LABEL[p.kind]}</b>
          <span className="block text-[12px] text-t3">
            {p.costCenter ?? 'Every cost center'} · v{p.version}
          </span>
        </span>
      ),
    },
    { header: 'Automatic', cell: (p) => (p.automaticBelow ? `under ${amountWords(p.automaticBelow)}` : 'Never') },
    ...labels.map((l): Column<PolicyView> => ({
      header: l,
      cell: (p) => {
        const s = p.steps.find((x) => x.label === l);
        return s ? <span title={approversWords(s)}>{whenWords(s)}</span> : <span className="text-t3">—</span>;
      },
    })),
  ];
  return <DataTable columns={columns} rows={policies} rowKey={(p) => p.id} testId="policies-table" />;
}

/** The policies in effect, from the API, and any proposed change waiting as a request. */
export function PoliciesCard() {
  const q = useQuery({
    queryKey: ['policies'],
    queryFn: () => get<{ policies: PolicyView[] }>('/api/policies'),
    retry: quiet,
  });
  const all = q.data?.policies ?? [];
  const current = all.filter((p) => p.current);
  const proposed = all.filter((p) => p.status === 'proposed');
  return (
    <Card
      title="Policies"
      sub="Who decides each kind of request. Amounts per month, or the one-off amount. A cost center that is at risk or over adds Finance. Steps escalate to the CFO after 24 business hours."
      action={
        current.length > 0 && (
          <CopyButton
            tsv={() =>
              toTsv(
                ['Kind', 'Cost center', 'Version', 'Automatic below', 'Step', 'Approvers', 'When'],
                current.flatMap((p) =>
                  p.steps.map((s) => [
                    REQUEST_KIND_LABEL[p.kind],
                    p.costCenter ?? '',
                    String(p.version),
                    p.automaticBelow ?? '',
                    s.label,
                    approversWords(s),
                    whenWords(s),
                  ]),
                ),
              )
            }
          />
        )
      }
      testId="policies"
    >
      {q.isError ? (
        <CardBody className="text-[13px] text-rd">{q.error.message}</CardBody>
      ) : (
        <PolicyRows policies={current} />
      )}
      {proposed.length > 0 && (
        <CardBody className="border-t border-hair">
          {proposed.map((p) => (
            <Msg key={p.id}>
              A change is a request: {REQUEST_KIND_LABEL[p.kind]} policy v{p.version}{' '}
              {p.requestId ? (
                <Link to={`/approvals/${p.requestId}`} className="font-semibold underline underline-offset-2">
                  is waiting on its approvers
                </Link>
              ) : (
                'is waiting'
              )}
              .
            </Msg>
          ))}
        </CardBody>
      )}
    </Card>
  );
}

// Proposals ------------------------------------------------------------------------------------------------------------

function Msg({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'no' }) {
  return (
    <div
      className={cn(
        'rounded-[10px] border px-3 py-2.5 text-[13px] [&+&]:mt-2',
        !tone && 'border-hair bg-sf2 text-t2',
        tone === 'ok' && 'border-gnbd bg-gndim text-t1',
        tone === 'warn' && 'border-warnbd bg-warndim text-t1',
        tone === 'no' && 'border-rdbd bg-rddim text-t1',
      )}
    >
      {children}
    </div>
  );
}

/** Change requests of a kind still waiting, as links: "A change is a request. … is waiting on Finance." */
export function OpenChanges({ kind }: { kind: 'rate_card_change' | 'rule_set_change' }) {
  const open = useRequests('open');
  const rows = (open.data?.requests ?? []).filter((r: RequestSummary) => r.kind === kind);
  if (rows.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-col">
      {rows.map((r) => (
        <Msg key={r.id}>
          A change is a request.{' '}
          <Link to={`/approvals/${r.id}`} className="font-semibold text-t1 underline underline-offset-2">
            {r.title}
          </Link>{' '}
          is at {r.stepLabel}.
        </Msg>
      ))}
    </div>
  );
}

/** The effect of a proposal on the open month (spec 003 T010): totals, by cost center, by line or rule. */
export function PreviewView({ p }: { p: ProposalPreview }) {
  const delta = Decimal.parse(p.delta);
  const rows = p.byCostCenter.filter((c) => !Decimal.parse(c.delta).isZero());
  return (
    <div className="mt-3" data-testid="preview">
      <p className="text-[12.5px] text-t3">{p.basis}</p>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-[10px] border border-hair bg-sf2 px-3 py-2.5">
        <div>
          <small className="block text-[12px] text-t3">As booked</small>
          <span className="figure text-[16px] font-semibold">{usd(p.current, { whole: true })}</span>
        </div>
        <span className="text-t3" aria-hidden>
          →
        </span>
        <div className="text-right">
          <small className="block text-[12px] text-t3">With the proposal</small>
          <span className="figure text-[16px] font-semibold">{usd(p.proposed, { whole: true })}</span>
        </div>
      </div>
      <p
        className={cn(
          'mt-1.5 text-[13px] font-medium',
          delta.isNegative() ? 'text-gn' : delta.isZero() ? 'text-t2' : 'text-rd',
        )}
      >
        {delta.isZero() ? 'No change to the open month.' : `${signed(p.delta)} on the open month`}
      </p>
      {rows.length > 0 && (
        <div className="mt-2 flex flex-col text-[13px]">
          {rows.map((c) => (
            <div key={c.code} className="flex justify-between gap-3 border-t border-hair py-1.5 first:border-t-0">
              <span className="min-w-0">
                <span className="font-mono text-[12px] font-medium">{c.code}</span>{' '}
                <span className="text-t3">{c.name}</span>
              </span>
              <span className="figure whitespace-nowrap">{signed(c.delta)}</span>
            </div>
          ))}
        </div>
      )}
      {p.byLine.length > 0 && (
        <details className="mt-2 text-[13px]">
          <summary className="cursor-pointer text-t2">Line by line</summary>
          <div className="mt-1 flex flex-col">
            {p.byLine.map((l) => (
              <div key={l.key} className="flex justify-between gap-3 border-t border-hair py-1.5 first:border-t-0">
                <span className="min-w-0">
                  {l.label}
                  <span className="block text-[12px] text-t3">{l.detail}</span>
                </span>
                <span className="figure whitespace-nowrap">{signed(l.delta)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      {p.warnings.map((w) => (
        <p key={w} className="mt-1.5 text-[12.5px] text-warn">
          {w}
        </p>
      ))}
    </div>
  );
}

function Raised({ created }: { created: ProposalCreated }) {
  return (
    <div className="mt-3">
      <Msg tone="ok">
        Raised as a request:{' '}
        <Link to={`/approvals/${created.request.id}`} className="font-semibold underline underline-offset-2">
          {created.request.number} {created.request.title}
        </Link>
        . Finance and then the CFO decide; it applies when the last approves.
      </Msg>
    </div>
  );
}

/** Propose a rate card version: new prices for some lines from a day, previewed on the open month, then raised. */
export function RateCardProposal({ current }: { current: RateCardVersion | null }) {
  const can = useCanPropose();
  const qc = useQueryClient();
  const [from, setFrom] = useState(tomorrow);
  const [changes, setChanges] = useState<{ skuPriceId: string; unitPrice: string }[]>([]);
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const body = () => ({ effectiveFrom: from, changes });
  const preview = useMutation({
    mutationFn: () => send<ProposalPreview>('POST', '/api/rate-cards/proposals/preview', body()),
  });
  const raise = useMutation({
    mutationFn: () => send<ProposalCreated>('POST', '/api/rate-cards/proposals', { ...body(), note }),
    onSuccess: () => {
      setChanges([]);
      void qc.invalidateQueries({ queryKey: ['rate-cards'] });
      void qc.invalidateQueries({ queryKey: ['requests'] });
    },
  });
  if (!current || current.status !== 'approved') return null;
  if (!can) return null;
  const lines = current.lines;
  const lineOf = (id: string) => lines.find((l) => l.skuPriceId === id);
  const valid =
    changes.length > 0 && changes.every((c) => /^\d+(\.\d+)?$/.test(c.unitPrice)) && /^\d{4}-\d{2}-\d{2}$/.test(from);
  return (
    <Card
      title={`Propose rate card v${current.version + 1}`}
      sub="New prices from a day. See the effect on the open month, then raise it as a request."
      testId="rate-card-proposal"
    >
      <CardBody>
        <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <div>
            <label className={label} htmlFor="rc-line">
              Line
            </label>
            <select id="rc-line" className={input} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a line…</option>
              {lines
                .filter((l) => !changes.some((c) => c.skuPriceId === l.skuPriceId))
                .map((l) => (
                  <option key={l.skuPriceId} value={l.skuPriceId}>
                    {l.label}
                    {l.provider ? ` · ${l.provider}/${l.model ?? '*'}` : ''} · $
                    {Decimal.parse(l.unitPrice).normalize().toString()} per {unitWords(l.pricingUnit)}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="rc-from">
              Effective from
            </label>
            <input id="rc-from" type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
        </div>
        <Button
          size="sm"
          className="mt-2"
          disabled={!pick}
          onClick={() => {
            const l = lineOf(pick);
            if (l)
              setChanges([
                ...changes,
                { skuPriceId: l.skuPriceId, unitPrice: Decimal.parse(l.unitPrice).normalize().toString() },
              ]);
            setPick('');
          }}
        >
          <Plus className="size-3.5" />
          Change this price
        </Button>
        {changes.length > 0 && (
          <ul className="mt-3 flex flex-col">
            {changes.map((c, i) => {
              const l = lineOf(c.skuPriceId);
              return (
                <li key={c.skuPriceId} className="flex items-center gap-2 border-t border-hair py-2 first:border-t-0">
                  <span className="min-w-0 flex-1 text-[14px]">
                    {l?.provider && `${l.provider}/${l.model ?? '*'} · `}
                    {l?.label ?? c.skuPriceId}
                    <span className="block text-[12px] text-t3">
                      now ${l?.unitPrice ? Decimal.parse(l.unitPrice).normalize().toString() : '?'} per{' '}
                      {unitWords(l?.pricingUnit ?? '')}
                    </span>
                  </span>
                  <input
                    aria-label={`New price for ${l?.label ?? c.skuPriceId}`}
                    className={cn(input, 'w-28 text-right font-mono')}
                    inputMode="decimal"
                    value={c.unitPrice}
                    onChange={(e) =>
                      setChanges(changes.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value.trim() } : x)))
                    }
                  />
                  <button
                    type="button"
                    aria-label="Remove"
                    className="grid size-8 place-items-center rounded-lg text-t3 hover:bg-acdim"
                    onClick={() => setChanges(changes.filter((_, j) => j !== i))}
                  >
                    <X className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <label className={cn(label, 'mt-3')} htmlFor="rc-note">
          Why
        </label>
        <textarea
          id="rc-note"
          rows={2}
          className={cn(input, 'h-auto py-2')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What changed: a new contract, a provider's price list"
        />
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button disabled={!valid || preview.isPending} onClick={() => preview.mutate()} data-testid="rc-preview">
            Preview the open month
          </Button>
          <Button
            variant="primary"
            disabled={!valid || !preview.data || raise.isPending}
            onClick={() => raise.mutate()}
            data-testid="rc-raise"
          >
            Raise as a request
          </Button>
        </div>
        {(preview.error ?? raise.error) && (
          <p className="mt-2 text-[12.5px] text-rd" role="alert">
            {(preview.error ?? raise.error)!.message}
          </p>
        )}
        {preview.data && <PreviewView p={preview.data} />}
        {raise.data && <Raised created={raise.data} />}
      </CardBody>
    </Card>
  );
}

/** Propose a rule set version: the whole ordered list as JSON, previewed on the open month, then raised. */
export function RuleSetProposal({ ruleSet }: { ruleSet: RuleSetVersionView | null }) {
  const can = useCanPropose();
  const qc = useQueryClient();
  const [from, setFrom] = useState(tomorrow);
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const json = text ?? JSON.stringify({ rules: ruleSet?.rules ?? [], shares: ruleSet?.shares ?? [] }, null, 2);
  let parsed: { rules: unknown[]; shares: unknown[] } | null = null;
  let parseError: string | null = null;
  try {
    const v = JSON.parse(json) as { rules?: unknown; shares?: unknown };
    if (!Array.isArray(v.rules)) parseError = 'Give "rules": the whole ordered list.';
    else parsed = { rules: v.rules, shares: Array.isArray(v.shares) ? v.shares : [] };
  } catch (e) {
    parseError = (e as Error).message;
  }
  const body = () => ({ effectiveFrom: from, ...parsed });
  const preview = useMutation({
    mutationFn: () => send<ProposalPreview>('POST', '/api/allocation/rule-sets/proposals/preview', body()),
  });
  const raise = useMutation({
    mutationFn: () => send<ProposalCreated>('POST', '/api/allocation/rule-sets/proposals', { ...body(), note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rule-sets'] });
      void qc.invalidateQueries({ queryKey: ['requests'] });
    },
  });
  if (!can || !ruleSet) return null;
  return (
    <Card
      title={`Propose allocation rules v${ruleSet.version + 1}`}
      sub="The whole ordered list, as JSON. See where the open month would land, then raise it as a request."
      testId="rule-set-proposal"
    >
      <CardBody>
        <label className={label} htmlFor="rs-from">
          Effective from
        </label>
        <input
          id="rs-from"
          type="date"
          className={cn(input, 'max-w-[10rem]')}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <label className={cn(label, 'mt-3')} htmlFor="rs-json">
          Rules and shares
        </label>
        <textarea
          id="rs-json"
          rows={10}
          spellCheck={false}
          className={cn(input, 'h-auto py-2 font-mono text-[12px]', parseError && 'border-rd')}
          value={json}
          onChange={(e) => {
            setText(e.target.value);
            preview.reset();
          }}
        />
        {parseError && <p className="mt-1 text-[12.5px] text-rd">{parseError}</p>}
        <label className={cn(label, 'mt-3')} htmlFor="rs-note">
          Why
        </label>
        <textarea
          id="rs-note"
          rows={2}
          className={cn(input, 'h-auto py-2')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What moves where, and why"
        />
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button disabled={!parsed || preview.isPending} onClick={() => preview.mutate()} data-testid="rs-preview">
            Preview the open month
          </Button>
          <Button
            variant="primary"
            disabled={!parsed || !preview.data || raise.isPending}
            onClick={() => raise.mutate()}
            data-testid="rs-raise"
          >
            Raise as a request
          </Button>
        </div>
        {(preview.error ?? raise.error) && (
          <p className="mt-2 text-[12.5px] text-rd" role="alert">
            {(preview.error ?? raise.error)!.message}
          </p>
        )}
        {preview.data && <PreviewView p={preview.data} />}
        {raise.data && <Raised created={raise.data} />}
      </CardBody>
    </Card>
  );
}
