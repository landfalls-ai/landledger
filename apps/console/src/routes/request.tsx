import type { DecisionView, RequestDetail, RequestOrigin, RequestView, StepView } from '@landledger/contracts';
import { SELF_APPLIED_KINDS } from '@landledger/contracts';
import { Decimal } from '@landledger/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Card, CardBody } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Pill, Tag } from '@/components/ui/pill';
import { ApiError, get, quiet, send } from '@/lib/api';
import { initials, roleLine, useMe } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { monthLabel, usd } from '@/lib/format';
import { age, amountWords, askedBy, kindLabel, perLabel, stepTone, tierOf, when } from '@/lib/requests';
import { Tiers } from './approvals';
import { AgentEconomicsCard, ContractOrSeatCard, Lifecycle } from '@/components/requests/wave3';

const H3 = ({ children }: { children: ReactNode }) => (
  <h3 className="mb-1.5 mt-4 text-[11px] font-medium uppercase tracking-[0.08em] text-t3 first:mt-0">{children}</h3>
);

function Msg({ tone, children, testId }: { tone?: 'ok' | 'no' | 'warn'; children: ReactNode; testId?: string }) {
  return (
    <div
      className={cn(
        'rounded-[10px] border px-3 py-2.5 text-[13px]',
        !tone && 'border-hair bg-sf2 text-t2',
        tone === 'ok' && 'border-gnbd bg-gndim text-t1',
        tone === 'no' && 'border-rdbd bg-rddim text-t1',
        tone === 'warn' && 'border-warnbd bg-warndim text-t1',
      )}
      data-testid={testId}
      role={tone === 'no' ? 'status' : undefined}
    >
      {children}
    </div>
  );
}

const ORIGIN_LABEL: Record<RequestOrigin['type'], string> = {
  landflow_run: 'Landflow run',
  pull_request: 'Pull request',
  landbright_request: 'Landbright request',
  console: 'Raised in',
  mcp: 'Raised in',
  contract_import: 'Held from',
};

function originText(o: RequestOrigin): ReactNode {
  switch (o.type) {
    case 'console':
      return 'The Landledger console';
    case 'mcp':
      return 'An MCP client (an agent’s tool call)';
    case 'landflow_run': {
      const text = o.title ?? `${o.workflowId} · run ${o.executionId}`;
      return o.url ? <Ext href={o.url}>{text}</Ext> : text;
    }
    case 'pull_request':
      return <Ext href={o.url}>{o.title ?? o.url}</Ext>;
    case 'landbright_request': {
      const text = o.url ? <Ext href={o.url}>{o.title ?? o.id}</Ext> : (o.title ?? o.id);
      return o.breakGlass ? <>{text} (break-glass: granted first, approved after)</> : text;
    }
    case 'contract_import':
      return `A contracts file${o.fileName ? `, ${o.fileName}` : ''}, line ${o.line}: above the $25,000 line, held for a second person${
        o.previousTcv ? ` (it raises a TCV of $${o.previousTcv})` : ''
      }`;
  }
}

const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer noopener" className="break-words underline underline-offset-2">
    {children}
  </a>
);

function WhatAndWhy({ r, e }: { r: RequestView; e?: RequestDetail['evidence'] }) {
  const a = askedBy(r.requester);
  const commitment = e?.commitment;
  return (
    <Card title="What and why" testId="what-and-why">
      <CardBody>
        {r.note && (
          <blockquote className="mb-3.5 border-l-2 border-bd py-0.5 pl-3 text-[14px] text-t1">{r.note}</blockquote>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[14px]">
          <dt className="text-[13px] text-t3">Asked by</dt>
          <dd className="min-w-0">
            <b className="font-semibold">{a.name}</b> {a.agent && <Tag>agent</Tag>}
            <span className="block text-[12px] text-t3">
              {a.agent
                ? `Sponsor: ${a.sponsor}, who answers for it. Agents can ask; only people decide.`
                : r.requester.kind === 'person' && r.requester.person.email}
            </span>
          </dd>
          <dt className="text-[13px] text-t3">Cost center</dt>
          <dd className="min-w-0">
            <span className="font-mono text-[12.5px] font-medium">{r.costCenter.code}</span>
            <span className="block text-[12px] text-t3">
              {r.costCenter.name}
              {r.costCenter.owner && ` · owner ${r.costCenter.owner}`}
            </span>
          </dd>
          <dt className="text-[13px] text-t3">When</dt>
          <dd>
            {r.recurrence === 'monthly'
              ? `Each month from ${r.start}${r.end ? ` to ${r.end}` : ', open-ended'}`
              : `Once, on ${r.start}`}
          </dd>
          {commitment && (
            <>
              <dt className="text-[13px] text-t3">Commitment</dt>
              <dd data-testid="commitment">
                <b className="figure font-semibold">{usd(commitment.annualised, { whole: true })} a year</b>
                <span className="block text-[12px] text-t3">
                  {r.recurrence === 'monthly'
                    ? r.end
                      ? `${usd(commitment.monthly, { whole: true })} a month, ${commitment.window}`
                      : `${usd(commitment.monthly, { whole: true })} a month, open-ended: counted as twelve months`
                    : 'Once'}
                </span>
              </dd>
            </>
          )}
          {[r.origin, ...r.related].map((o, i) => (
            <div key={i} className="contents">
              <dt className="text-[13px] text-t3">{ORIGIN_LABEL[o.type]}</dt>
              <dd className="min-w-0">
                {originText(o)}{' '}
                {i === 0 && r.origin.verified === false && (
                  <Tag dashed className="ml-1" data-testid="origin-unverified">
                    as the caller said, not verified
                  </Tag>
                )}
                {i > 0 && <Tag dashed>as the caller said</Tag>}
              </dd>
            </div>
          ))}
          {r.createdBy && (
            <>
              <dt className="text-[13px] text-t3">Raised by</dt>
              <dd data-testid="created-by">
                {r.createdBy.kind === 'key' ? (
                  <>
                    API key <span className="font-mono text-[12.5px]">{r.createdBy.name}</span>
                  </>
                ) : (
                  r.createdBy.name
                )}
                <span className="block text-[12px] text-t3">Stamped by Landledger, not said by the caller</span>
              </dd>
            </>
          )}
        </dl>
      </CardBody>
    </Card>
  );
}

interface EvidenceLine {
  label: string;
  amount: string;
}

/** The requester's evidence keys the console shows (CreateRequestInput.evidence). */
function requesterEvidence(e: Record<string, unknown>) {
  const lines = Array.isArray(e.lines)
    ? (e.lines as unknown[]).flatMap((l): EvidenceLine[] => {
        if (typeof l !== 'object' || l === null) return [];
        const { label, amount } = l as Record<string, unknown>;
        return typeof label === 'string' && (typeof amount === 'string' || typeof amount === 'number')
          ? [{ label, amount: String(amount) }]
          : [];
      })
    : [];
  const links = Array.isArray(e.links)
    ? (e.links as unknown[]).flatMap((l) => {
        const { label, url } = (l ?? {}) as Record<string, unknown>;
        return typeof label === 'string' && typeof url === 'string' && /^https?:\/\//.test(url) ? [{ label, url }] : [];
      })
    : [];
  return {
    lines,
    links,
    basis: typeof e.basis === 'string' ? e.basis : null,
    match: e.match && typeof e.match === 'object' ? (e.match as Record<string, unknown>) : null,
  };
}

const safe = (a: string) => {
  try {
    return Decimal.parse(a);
  } catch {
    return null;
  }
};

function Before({
  label,
  now,
  after,
  nowWord = 'now',
  afterWord = 'with this request',
}: {
  label: string;
  now: string | null;
  after: string | null;
  nowWord?: string;
  afterWord?: string;
}) {
  const neg = after !== null && Decimal.parse(after).isNegative();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-[10px] border border-hair bg-sf2 px-3 py-2.5 [&+&]:mt-2">
      <div>
        <small className="block text-[12px] text-t3">
          {label} · {nowWord}
        </small>
        <span className="figure text-[16px] font-semibold">{usd(now, { whole: true })}</span>
      </div>
      <span className="text-t3" aria-hidden>
        →
      </span>
      <div className="text-right">
        <small className="block text-[12px] text-t3">{afterWord}</small>
        <span className={cn('figure text-[16px] font-semibold', neg && 'text-rd')}>{usd(after, { whole: true })}</span>
      </div>
    </div>
  );
}

function Evidence({ d }: { d: RequestDetail }) {
  const r = d.request;
  const e = d.evidence;
  const mine = requesterEvidence(r.evidence);
  const total = mine.lines.reduce((s, l) => s.plus(safe(l.amount) ?? '0'), Decimal.parse('0'));
  const month = monthLabel(e.month);
  const counted = r.status === 'approved' || r.status === 'applied';
  const ffm = e.firstFullMonth ?? null;
  const over = e.stateWith === 'over' || ffm?.stateWith === 'over';
  const forecastMsg =
    e.budget === null
      ? `${r.costCenter.code} has no budget for ${month}.`
      : e.stateWith === 'over'
        ? `With this request ${r.costCenter.code} goes over its ${month} budget.`
        : ffm?.stateWith === 'over'
          ? `With this request ${r.costCenter.code} goes over its ${monthLabel(ffm.month)} budget, the first full month.`
          : e.stateNow === 'risk' || e.stateNow === 'over'
            ? `${r.costCenter.code} is ${e.stateNow === 'over' ? 'over' : 'at risk'} in ${month} already.`
            : `${r.costCenter.code} stays on track in ${month} with this request.`;
  return (
    <Card title="The evidence" testId="evidence">
      <CardBody>
        <H3>Cost change</H3>
        <div className="flex flex-col text-[14px]">
          {mine.lines.map((l, i) => (
            <div key={i} className="flex justify-between gap-3 border-t border-hair py-[7px] first:border-t-0">
              <span className="min-w-0">{l.label}</span>
              <span className="figure whitespace-nowrap">{safe(l.amount) ? usd(l.amount) : l.amount}</span>
            </div>
          ))}
          <div className="flex justify-between gap-3 border-t border-bd py-[7px] font-semibold">
            <span>{r.recurrence === 'monthly' ? 'Each month' : 'Total'}</span>
            <span className="figure">{usd(mine.lines.length ? total.toString() : r.amount.amount)}</span>
          </div>
        </div>
        {mine.basis && <p className="mt-1.5 text-[12.5px] text-t3">{mine.basis}</p>}
        {mine.match && (
          <p className="mt-1.5 text-[12.5px] text-t3">
            Consumes its reservation:{' '}
            <span className="font-mono text-[12px] text-t2">
              {Object.entries(mine.match)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(' ')}
            </span>
          </p>
        )}
        {mine.links.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-1 text-[13px]">
            {mine.links.map((l) => (
              <li key={l.url}>
                <Ext href={l.url}>{l.label}</Ext>
              </li>
            ))}
          </ul>
        )}

        <H3>Budget and forecast</H3>
        <Before
          label={`Budget left · ${monthLabel(e.month).split(' ')[0]}`}
          now={e.leftNow}
          after={e.leftAfter}
          nowWord={counted ? 'without it' : 'now'}
          afterWord={counted ? 'with its reservation' : 'with this request'}
        />
        {e.forecastNow !== null && (
          <Before
            label="Forecast"
            now={e.forecastNow}
            after={e.forecastWith}
            nowWord={counted ? 'without it' : 'now'}
            afterWord={counted ? 'with it' : 'with this request'}
          />
        )}
        {ffm && (
          <div className="mt-2" data-testid="first-full-month">
            <Before
              label={`Budget left · ${monthLabel(ffm.month).split(' ')[0]}, first full month`}
              now={
                ffm.budget === null
                  ? null
                  : Decimal.parse(ffm.leftAfter ?? '0')
                      .plus(ffm.adds)
                      .toString()
              }
              after={ffm.leftAfter}
              nowWord={counted ? 'without it' : 'now'}
              afterWord={counted ? 'with it' : 'with this request'}
            />
            <p className="mt-1.5 text-[12.5px] text-t3">
              Adds {usd(ffm.adds)} in {monthLabel(ffm.month)}, its first whole month
              {ffm.budget === null ? `; ${monthLabel(ffm.month)} has no budget yet.` : '.'}
            </p>
          </div>
        )}
        <p className="mt-1.5 text-[12.5px] text-t3">
          Adds {usd(e.adds)} in {month}. Spent {usd(e.actual, { whole: true })} so far
          {e.reserved !== '0.000000' && `, ${usd(e.reserved, { whole: true })} reserved by approved requests`}.
          {e.rateCard &&
            ` Priced on rate card v${e.rateCard.version}${e.rateCard.approvedBy ? `, approved by ${e.rateCard.approvedBy}` : ''}.`}
        </p>
        <div className="mt-2.5">
          <Msg tone={over || e.stateNow === 'over' || e.stateNow === 'risk' ? 'warn' : undefined}>{forecastMsg}</Msg>
        </div>
        {e.budgetMissing && (
          <div className="mt-2" data-testid="budget-missing">
            <Msg tone="warn">{e.budgetMissing}.</Msg>
          </div>
        )}
        {e.committed && e.committed !== '0.000000' && (
          <p className="mt-1.5 text-[12.5px] text-t3" data-testid="committed">
            Approved monthly requests beyond their reserved months commit {usd(e.committed)} more to {r.costCenter.code}{' '}
            this month; the forecast counts it.
          </p>
        )}
        {e.automaticThisMonth && e.automaticThisMonth.costCenter !== '0.000000' && (
          <p className="mt-1.5 text-[12.5px] text-t3" data-testid="automatic-this-month">
            Approved by policy on {r.costCenter.code} this month: {usd(e.automaticThisMonth.costCenter)}
            {e.automaticThisMonth.agent && `; for this agent: ${usd(e.automaticThisMonth.agent)}`}. It counts toward the
            automatic threshold.
          </p>
        )}
        {e.rateCardChange && (
          <p className="mt-1.5 text-[12.5px] text-t3">
            The version’s {e.rateCardChange.lines} lines are frozen while it is decided: sha256{' '}
            <span className="font-mono text-[12px]">{e.rateCardChange.linesSha256.slice(0, 16)}…</span>
          </p>
        )}

        {e.similar.length > 0 && (
          <>
            <H3>Similar past requests</H3>
            <div className="flex flex-col text-[14px]">
              {e.similar.map((s) => (
                <div key={s.id} className="flex justify-between gap-3 border-t border-hair py-[7px] first:border-t-0">
                  <span className="min-w-0">
                    <Link to={`/approvals/${s.id}`} className="font-medium text-t1 hover:underline">
                      {s.title}
                    </Link>
                    <small className="block text-[12px] text-t3">
                      {s.number} · {s.status}
                      {s.decidedAt && ` ${when(s.decidedAt)}`}
                    </small>
                  </span>
                  <span className="figure whitespace-nowrap">
                    {amountWords(s.amount)} {s.recurrence === 'monthly' ? '/mo' : ''}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

const who = (s: StepView) => {
  if (s.decision) return s.decision.person.name;
  const owner = s.approvers.costCenterOwner;
  const groups = s.escalatedTo.length ? s.escalatedTo : s.approvers.groups;
  const people = s.approvers.people.map((p) => p.name);
  const base = owner ? owner.name : groups.join(' or ');
  return people.length && !owner ? `${base}: ${people.slice(0, 4).join(', ')}${people.length > 4 ? ', …' : ''}` : base;
};

function StepDot({ s }: { s: StepView }) {
  const base =
    'grid size-[23px] shrink-0 place-items-center rounded-full border-[1.5px] font-mono text-[11px] font-semibold';
  if (s.status === 'approved')
    return (
      <span className={cn(base, 'border-gn bg-gn text-sf')}>
        <Check className="size-[13px]" strokeWidth={2.5} />
      </span>
    );
  if (s.status === 'rejected' || s.status === 'expired')
    return (
      <span className={cn(base, 'border-rd bg-rd text-sf')}>
        <X className="size-[13px]" strokeWidth={2.5} />
      </span>
    );
  return (
    <span
      className={cn(
        base,
        s.status === 'pending'
          ? 'border-t1 bg-sf text-t1 shadow-[0_0_0_3px_var(--color-acdim)]'
          : 'border-bd bg-sf text-t3',
      )}
    >
      {s.position}
    </span>
  );
}

function Path({ r, why }: { r: RequestView; why: string }) {
  const selfApplied = SELF_APPLIED_KINDS.includes(r.kind);
  return (
    <Card title="The path" testId="path">
      <CardBody>
        {!selfApplied && (
          <div className="mb-2.5">
            <Tiers on={r.automatic ? 0 : tierOf(r.thresholdAmount)} />
          </div>
        )}
        <p className="text-[12.5px] text-t3">
          {r.status === 'awaiting_confirmation' && (
            <b className="font-medium text-t2" data-testid="path-if-confirmed">
              If confirmed now, policy is re-run:{' '}
            </b>
          )}
          {r.policy?.reason || why}
        </p>
        {r.automatic ? (
          <div className="mt-3">
            <Msg tone="ok">Approved by policy: below the automatic threshold, so no person needed to decide.</Msg>
          </div>
        ) : (
          <ol className="mt-3.5 flex flex-col">
            {r.steps.map((s, i) => (
              <li key={s.position} className="relative flex gap-3 pb-4 last:pb-0" data-testid={`step-${s.position}`}>
                {i < r.steps.length - 1 && (
                  <span className="absolute bottom-0.5 left-[11px] top-[26px] w-px bg-bd" aria-hidden />
                )}
                <StepDot s={s} />
                <div className="min-w-0 flex-1 text-[14px]">
                  <b
                    className={cn(
                      'font-semibold',
                      (s.status === 'waiting' || s.status === 'skipped') && 'font-medium text-t3',
                    )}
                  >
                    {s.label}
                  </b>{' '}
                  {s.status === 'pending' && <Pill tone="risk">Now</Pill>}
                  {s.status === 'skipped' && <span className="text-[12px] text-t3">not reached</span>}
                  {s.escalatedAt && (
                    <Pill tone="over" className="ml-1">
                      Escalated
                    </Pill>
                  )}
                  <small className="block text-[12px] text-t3">{who(s)}</small>
                  {(s.note ?? s.approvers.fallback) && (
                    <small className="block text-[12px] text-warn" data-testid={`step-note-${s.position}`}>
                      {s.note ?? s.approvers.fallback}
                    </small>
                  )}
                  {s.decision && (
                    <small className="block text-[12px] text-t3">
                      {s.decision.outcome === 'approve' ? 'Approved' : 'Rejected'} {when(s.decision.at)}
                      {s.decision.via === 'relay' && (
                        <>
                          {' '}
                          <Tag data-testid="relayed">
                            relayed from{' '}
                            {s.decision.relay?.kind === 'slack' || s.decision.channel === 'slack'
                              ? 'Slack'
                              : (s.decision.channel ?? 'a relay')}
                          </Tag>
                        </>
                      )}
                      {s.key === 'budget_owner' && s.decision.ownerRole === 'deputy' && (
                        <>
                          {' '}
                          <Tag>deputy</Tag>
                        </>
                      )}
                      {s.key === 'budget_owner' && s.decision.ownerRole === 'not_owner' && (
                        <>
                          {' '}
                          <Tag dashed data-testid="not-owner">
                            not the cost center’s owner
                          </Tag>
                        </>
                      )}
                    </small>
                  )}
                  {s.status === 'pending' && (s.approvers.serviceAccounts?.length ?? 0) > 0 && (
                    <small className="block text-[12px] text-t3" data-testid={`service-accounts-${s.position}`}>
                      Not approvers (service accounts in the group):{' '}
                      {s.approvers.serviceAccounts.map((p) => p.email ?? p.name).join(', ')}
                    </small>
                  )}
                  {s.status === 'pending' && s.deadlineAt && (
                    <small className="block text-[12px] text-t3">
                      {s.escalatedAt ? 'Expires' : 'Escalates'} {when(s.deadlineAt)}
                    </small>
                  )}
                  {s.decision?.comment && <small className="block text-[12px] text-t2">“{s.decision.comment}”</small>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

const ENDED_WORDS: Record<string, string> = {
  awaiting_confirmation: 'Awaiting confirmation',
  approved: 'Approved',
  applied: 'Approved and applied',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired: nobody decided in time',
};

function lastDecision(r: RequestView): DecisionView | null {
  return r.decisions.at(-1) ?? null;
}

function Decide({ d }: { d: RequestDetail }) {
  const r = d.request;
  const me = useMe().data;
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [err, setErr] = useState(false);
  const decide = useMutation({
    mutationFn: (outcome: 'approve' | 'reject') =>
      send('POST', `/api/requests/${r.id}/decisions`, {
        outcome,
        comment,
        evidenceSha256: d.evidenceSha256,
        ...(r.currentStep ? { step: r.currentStep } : {}),
      }),
    onSuccess: () => {
      setComment('');
      void qc.invalidateQueries({ queryKey: ['request', r.id] });
      void qc.invalidateQueries({ queryKey: ['requests'] });
    },
  });
  let body: ReactNode;
  if (r.status === 'awaiting_confirmation') {
    body = <Confirmation r={r} />;
  } else if (r.status !== 'pending' && r.status !== 'draft') {
    const last = lastDecision(r);
    body = (
      <>
        <Msg tone={r.status === 'approved' || r.status === 'applied' ? 'ok' : 'no'} testId="decided">
          <b className="font-semibold">
            {ENDED_WORDS[r.status]}
            {last && ` by ${last.person.name}`}
            {r.automatic && ' by policy'}
            {r.decidedAt && `, ${when(r.decidedAt)}`}
          </b>
          {last && (
            <>
              <br />A snapshot of the evidence that person saw is saved with the decision.
              <br />
              <a
                href={`/api/requests/${r.id}/evidence/${last.evidenceSha256}`}
                className="font-mono text-[12px] text-t2 underline underline-offset-2"
                target="_blank"
                rel="noreferrer"
              >
                sha256 {last.evidenceSha256.slice(0, 16)}…
              </a>
            </>
          )}
          {r.confirmation?.status === 'declined' && (
            <>
              <br />
              Declined by {r.confirmation.person.name}: “{r.confirmation.reason}”
            </>
          )}
          {r.reservations.length > 0 && (
            <>
              <br />
              Reserved{' '}
              {r.reservations.map((x) => `${usd(x.amount, { whole: true })} in ${monthLabel(x.month)}`).join(', ')}.
            </>
          )}
        </Msg>
        <Link
          to="/approvals"
          className="mt-3 inline-flex h-9 w-full items-center justify-center rounded-[9px] border border-bd text-[14px] font-medium hover:bg-acdim"
        >
          Back to the inbox
        </Link>
      </>
    );
  } else if (!r.you.canDecide) {
    const now = r.steps.find((s) => s.status === 'pending');
    body = (
      <Msg testId="cannot-decide">
        {r.you.isRequester || r.you.isSponsor ? (
          <>
            You {r.you.isRequester ? 'raised' : 'sponsor'} this request, so you can’t decide it.
            {now && (
              <>
                {' '}
                It’s with <b className="font-semibold">{who(now)}</b>.
              </>
            )}
          </>
        ) : (
          (r.you.reason ?? 'You can’t decide this step.')
        )}
      </Msg>
    );
  } else {
    const tooShort = comment.trim().length < 3;
    body = (
      <>
        {me && (
          <div className="mb-3 flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-full bg-acdim text-[12px] font-semibold text-t1">
              {initials(me.user.name)}
            </span>
            <div className="text-[14px]">
              <b className="font-semibold">Deciding as {me.user.name}</b>
              <small className="block text-[12px] text-t3">{roleLine(me)}</small>
            </div>
          </div>
        )}
        <label htmlFor="cmt" className="mb-1 block text-[12px] text-t3">
          Comment (needed to reject)
        </label>
        <textarea
          id="cmt"
          value={comment}
          onChange={(e) => {
            setComment(e.target.value);
            setErr(false);
          }}
          placeholder="What the requester should know"
          aria-describedby="cmth"
          aria-invalid={err}
          rows={3}
          className={cn(
            'w-full rounded-[10px] border bg-sf px-3 py-2 text-[14px] text-t1 outline-none focus:border-t2',
            err ? 'border-rd' : 'border-bd',
          )}
        />
        {err && (
          <p className="mt-1 text-[12.5px] text-rd" role="alert">
            Say why, so the requester knows what to change.
          </p>
        )}
        <div className="mt-2.5 grid grid-cols-[2fr_1fr] gap-2">
          <Button
            variant="primary"
            size="lg"
            disabled={decide.isPending}
            onClick={() => decide.mutate('approve')}
            data-testid="approve"
          >
            Approve {amountWords(r.amount.amount)}
          </Button>
          <Button
            variant="danger"
            size="lg"
            disabled={decide.isPending}
            onClick={() => (tooShort ? setErr(true) : decide.mutate('reject'))}
            data-testid="reject"
          >
            Reject
          </Button>
        </div>
        {decide.error && (
          <p className="mt-2 text-[12.5px] text-rd" role="alert">
            {decide.error instanceof ApiError ? decide.error.message : 'The decision didn’t go through.'}
          </p>
        )}
        <p id="cmth" className="mt-2.5 text-[12px] text-t3">
          Your decision saves a snapshot of the evidence shown here (sha256 {d.evidenceSha256.slice(0, 12)}…).
        </p>
      </>
    );
  }
  return (
    <Card title={r.status === 'awaiting_confirmation' ? 'Confirm' : 'Decide'} testId="decide">
      <CardBody>{body}</CardBody>
    </Card>
  );
}

/**
 * A request a key raised naming a person waits for that person (review of wave 2): they confirm it (it enters the
 * policy) or decline it (cancelled), from their own session. Everyone else sees who it waits on.
 */
export function Confirmation({ r, compact }: { r: RequestView; compact?: boolean }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [declining, setDeclining] = useState(false);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['request', r.id] });
    void qc.invalidateQueries({ queryKey: ['requests'] });
  };
  const confirm = useMutation({
    mutationFn: () => send('POST', `/api/requests/${r.id}/confirm`, {}),
    onSuccess: done,
  });
  const decline = useMutation({
    mutationFn: () => send('POST', `/api/requests/${r.id}/decline`, { reason }),
    onSuccess: done,
  });
  const c = r.confirmation;
  const by = r.createdBy?.kind === 'key' ? `API key ${r.createdBy.name}` : (r.createdBy?.name ?? 'An API key');
  if (!r.you.canConfirm)
    return (
      <Msg testId="awaiting-confirmation">
        {by} raised this naming <b className="font-semibold">{c?.person.name ?? 'a person'}</b>. It waits for them to
        confirm it from their own session before anyone decides it.
      </Msg>
    );
  const error = confirm.error ?? decline.error;
  return (
    <div data-testid="confirm-card">
      <Msg tone="warn">
        <b className="font-semibold">{by} raised this in your name.</b>{' '}
        {r.requester.kind === 'agent'
          ? `It says you sponsor ${r.requester.agent.name}.`
          : 'It says you are asking for it.'}{' '}
        Nobody decides it until you confirm it; decline it if you didn’t ask for it.
      </Msg>
      {!compact && (
        <p className="mt-2 text-[12.5px] text-t3">
          {usd(r.amount.amount)} {perLabel(r)} for {r.costCenter.code}
          {r.origin.verified === false && ', from an origin the key gave and Landledger hasn’t verified'}.
        </p>
      )}
      {declining && (
        <>
          <label htmlFor={`why-${r.id}`} className="mb-1 mt-2.5 block text-[12px] text-t3">
            Why you decline it
          </label>
          <textarea
            id={`why-${r.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full rounded-[10px] border border-bd bg-sf px-3 py-2 text-[14px] text-t1 outline-none focus:border-t2"
          />
        </>
      )}
      <div className="mt-2.5 grid grid-cols-[2fr_1fr] gap-2">
        <Button
          variant="primary"
          size="lg"
          disabled={confirm.isPending || declining}
          onClick={() => confirm.mutate()}
          data-testid="confirm"
        >
          Confirm, it’s mine
        </Button>
        <Button
          variant="danger"
          size="lg"
          disabled={decline.isPending || (declining && reason.trim().length < 3)}
          onClick={() => (declining ? decline.mutate() : setDeclining(true))}
          data-testid="decline"
        >
          Decline
        </Button>
      </div>
      {error && (
        <p className="mt-2 text-[12.5px] text-rd" role="alert">
          {error.message}
        </p>
      )}
    </div>
  );
}

/** Away from Approve and Reject: cancel (asked twice) and the evidence pack. */
function Manage({ r }: { r: RequestView }) {
  const qc = useQueryClient();
  const [sure, setSure] = useState(false);
  const cancel = useMutation({
    mutationFn: () => send('POST', `/api/requests/${r.id}/cancel`, { reason: 'Cancelled in the console' }),
    onSuccess: () => {
      setSure(false);
      void qc.invalidateQueries({ queryKey: ['request', r.id] });
      void qc.invalidateQueries({ queryKey: ['requests'] });
    },
  });
  return (
    <Card title="This request" testId="manage">
      <CardBody>
        <p className="text-[13px] text-t2">
          The evidence pack has the request, every snapshot shown and to whom, the decisions, the audit entries and the
          chain’s proof.{' '}
          <a
            href={`/api/requests/${r.id}/evidence-pack?format=html`}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
            data-testid="evidence-pack"
          >
            Open it
          </a>{' '}
          ·{' '}
          <a href={`/api/requests/${r.id}/evidence-pack`} className="underline underline-offset-2">
            JSON
          </a>
        </p>
        {r.you.canCancel &&
          (sure ? (
            <div
              className="mt-3 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px]"
              data-testid="cancel-confirm"
            >
              Cancel {r.number}? Nobody can decide it after this, and it can’t be reopened.
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                  Yes, cancel it
                </Button>
                <Button size="sm" onClick={() => setSure(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" className="mt-3" onClick={() => setSure(true)} data-testid="cancel">
              Cancel this request…
            </Button>
          ))}
        {cancel.error && <p className="mt-2 text-[12.5px] text-rd">{cancel.error.message}</p>}
      </CardBody>
    </Card>
  );
}

/** One request (docs/ui.md, `#request`): what and why, the evidence, the path, and Decide after the evidence. */
export function RequestPage() {
  const { id = '' } = useParams();
  const detail = useQuery({
    queryKey: ['request', id],
    queryFn: () => get<RequestDetail>(`/api/requests/${encodeURIComponent(id)}`),
    retry: quiet,
    refetchOnWindowFocus: false,
  });
  const back = (
    <Link to="/approvals" className="mb-2.5 inline-flex items-center gap-1 py-1 text-[14px] text-t2">
      <ChevronLeft className="size-4" />
      Approvals
    </Link>
  );
  if (detail.isError)
    return (
      <div data-testid="request">
        {back}
        <Msg tone="no">{detail.error.message}</Msg>
      </div>
    );
  if (!detail.data)
    return (
      <div data-testid="request">
        {back}
        <p className="text-[13px] text-t3">Loading…</p>
      </div>
    );
  const d = detail.data;
  const r = d.request;
  const pending = r.status === 'pending';
  const tone = stepTone(r, (pending && r.you.canDecide) || !!r.you.canConfirm);
  const stepLabel = pending
    ? `Step ${r.currentStep} of ${r.steps.length} · ${r.steps.find((s) => s.position === r.currentStep)?.label ?? ''}`
    : (ENDED_WORDS[r.status] ?? r.status);
  return (
    <div data-testid="request">
      {back}
      <div className="mb-3.5 flex flex-wrap items-end gap-x-5 gap-y-2.5">
        <div className="min-w-0 flex-[1_1_260px]">
          <h2 className="text-[20px] font-semibold leading-tight tracking-[-0.01em]">{r.title}</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill tone={tone}>{stepLabel}</Pill>
            <Pill>{kindLabel(r.kind)}</Pill>
            <Pill>
              {r.number} · raised {age(r.submittedAt ?? r.createdAt)} ago
            </Pill>
          </div>
        </div>
        <div>
          <div className="figure text-[24px] font-semibold tracking-[-0.02em]">
            +{amountWords(r.amount.amount)}{' '}
            <small className="font-sans text-[13px] font-normal text-t3">
              {perLabel(r)} · {r.amount.currency}
            </small>
          </div>
          <div className="mt-1 text-[12px] text-t3">
            <Tag dashed>estimate</Tag> the requester’s figure
          </div>
        </div>
      </div>
      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-3.5">
          <WhatAndWhy r={r} e={d.evidence} />
          <Evidence d={d} />
          <ContractOrSeatCard d={d} />
          <AgentEconomicsCard d={d} />
          <Lifecycle r={r} />
          <Manage r={r} />
        </div>
        <div className="flex min-w-0 flex-col gap-3.5">
          <Path r={r} why={d.evidence.why} />
          <Decide d={d} />
        </div>
      </div>
    </div>
  );
}
