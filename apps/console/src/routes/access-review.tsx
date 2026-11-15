import type { AccessItemKind, AccessItemView, AccessReviewView } from '@landledger/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorNote, Lede } from '@/components/spend/bits';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { get, quiet, send } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { dayLabel } from '@/lib/format';

type ReviewList = { quarter: string; due: boolean; reviews: Omit<AccessReviewView, 'items'>[] };

const KIND: Record<AccessItemKind, { title: string; sub: string }> = {
  person: { title: 'People with roles', sub: 'Their roles come from their Landbright groups' },
  key: { title: 'API keys', sub: 'Scopes, bound workflows, last used' },
  link: { title: 'Slack links', sub: 'Decisions relayed from these accounts count as the person’s' },
  relay_channel: { title: 'Relay channels', sub: 'Chats that relay decisions into Landledger' },
  owner: { title: 'Cost center owners', sub: 'Owners and deputies decide their cost center’s requests' },
};
const ORDER: AccessItemKind[] = ['person', 'key', 'link', 'relay_channel', 'owner'];

/** The controller or the CFO, signed in (the API checks again, and refuses an item about yourself). */
function useAttester(): { can: boolean; userId: string | null } {
  const me = useMe().data;
  if (!me || me.kind !== 'person') return { can: false, userId: null };
  return { can: me.user.roles.some((r) => r === 'controller' || r === 'cfo'), userId: me.user.id };
}

function Attest({ reviewId, item }: { reviewId: string; item: AccessItemView }) {
  const qc = useQueryClient();
  const [revoking, setRevoking] = useState(false);
  const [comment, setComment] = useState('');
  const run = useMutation({
    mutationFn: (decision: 'keep' | 'revoke') =>
      send<AccessReviewView>('POST', `/api/access-reviews/${reviewId}/items/${item.id}/attest`, { decision, comment }),
    onSuccess: (v) => {
      qc.setQueryData(['access-review', reviewId], v);
      void qc.invalidateQueries({ queryKey: ['access-reviews'] });
    },
  });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {!revoking ? (
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={run.isPending}
            onClick={() => run.mutate('keep')}
            data-testid={`keep-${item.id}`}
          >
            Keep
          </Button>
          <Button size="sm" onClick={() => setRevoking(true)} data-testid={`revoke-${item.id}`}>
            Revoke…
          </Button>
        </>
      ) : (
        <>
          <input
            className="h-[30px] min-w-0 flex-1 rounded-[9px] border border-bd bg-sf px-2.5 text-[13px]"
            placeholder="Why it should go"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            aria-label="Why revoke"
          />
          <Button
            size="sm"
            variant="primary"
            disabled={comment.trim().length < 3 || run.isPending}
            onClick={() => run.mutate('revoke')}
          >
            Revoke
          </Button>
          <Button size="sm" onClick={() => setRevoking(false)}>
            Cancel
          </Button>
        </>
      )}
      {run.isError && <p className="w-full text-[12px] text-rd">{run.error.message}</p>}
    </div>
  );
}

function Item({ reviewId, item, open }: { reviewId: string; item: AccessItemView; open: boolean }) {
  const { can, userId } = useAttester();
  const mine = !!userId && item.about.includes(userId);
  const a = item.attestation;
  return (
    <li className="border-t border-hair px-4 py-3 first:border-t-0" data-testid={`item-${item.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-t1">{item.label}</span>
        {a ? (
          <Pill tone={a.decision === 'keep' ? 'ok' : 'over'} data-testid={`attested-${item.id}`}>
            {a.decision === 'keep' ? 'Kept' : 'Revoke'}
          </Pill>
        ) : (
          <Pill tone="nu">To attest</Pill>
        )}
      </div>
      <p className="mt-0.5 text-[12.5px] text-t2">{item.detail}</p>
      {a && (
        <p className="mt-1 text-[12px] text-t3">
          {a.by}, {dayLabel(a.at.slice(0, 10))}
          {a.comment ? `: ${a.comment}` : ''}
        </p>
      )}
      {!a && open && can && !mine && <Attest reviewId={reviewId} item={item} />}
      {!a && open && mine && (
        <p className="mt-1 text-[12px] text-t3" data-testid={`yours-${item.id}`}>
          About you: another controller or the CFO attests it.
        </p>
      )}
    </li>
  );
}

function Review({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['access-review', id],
    queryFn: () => get<AccessReviewView>(`/api/access-reviews/${id}`),
    retry: quiet,
  });
  const v = q.data;
  if (!v) return q.isError ? <ErrorNote error={q.error} /> : <Lede>Loading the review…</Lede>;
  const open = v.status === 'open';
  return (
    <div className="grid gap-3.5" data-testid="access-review">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-medium text-t1">{v.quarter}</span>
        <Pill tone={open ? 'risk' : 'ok'} data-testid="review-status">
          {open ? `${v.counts.attested} of ${v.counts.total} attested` : 'Complete'}
        </Pill>
        <span className="text-[12px] text-t3">
          Opened by {v.openedBy}, {dayLabel(v.openedAt.slice(0, 10))}
          {v.completedAt ? ` · completed ${dayLabel(v.completedAt.slice(0, 10))}` : ''}
          {v.counts.revoke ? ` · ${v.counts.revoke} to revoke` : ''}
        </span>
      </div>
      {ORDER.map((kind) => {
        const items = v.items.filter((i) => i.kind === kind);
        if (!items.length) return null;
        return (
          <Card key={kind} title={KIND[kind].title} sub={KIND[kind].sub} testId={`review-${kind}`}>
            <ul>
              {items.map((i) => (
                <Item key={i.id} reviewId={v.id} item={i} open={open} />
              ))}
            </ul>
          </Card>
        );
      })}
      {v.counts.revoke > 0 && (
        <p className="text-[12.5px] text-t3">
          A revoke is recorded here; the key, link or channel is then revoked where it lives (Settings, the person’s
          profile, or Landbright for roles).
        </p>
      )}
    </div>
  );
}

/** The access review (spec 011): each quarter, who holds what, kept or revoked by a person. */
export function AccessReviewPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { can } = useAttester();
  const list = useQuery({
    queryKey: ['access-reviews'],
    queryFn: () => get<ReviewList>('/api/access-reviews'),
    retry: quiet,
  });
  const openNew = useMutation({
    mutationFn: () => send<AccessReviewView>('POST', '/api/access-reviews'),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: ['access-reviews'] });
      setParams({ id: v.id });
    },
  });
  const l = list.data;
  if (!l) return list.isError ? <ErrorNote error={list.error} /> : <Lede>Loading access reviews…</Lede>;
  const current = l.reviews.find((r) => r.quarter === l.quarter);
  const id = params.get('id') ?? current?.id ?? null;
  return (
    <div className="grid gap-3.5" data-testid="access-reviews">
      <Lede>
        Each quarter the controller or the CFO confirms who holds what: people’s roles, keys and their scopes, Slack
        links, relay channels and cost center owners. Each item is kept or revoked, never by the person it is about, and
        every attestation is in the audit log.
      </Lede>
      {!current && (
        <Card title={`The ${l.quarter} review is due`} testId="review-due">
          <CardBody>
            {can ? (
              <Button variant="primary" disabled={openNew.isPending} onClick={() => openNew.mutate()}>
                Open the {l.quarter} review
              </Button>
            ) : (
              <p className="text-[13px] text-t3">The controller or the CFO opens it.</p>
            )}
            {openNew.isError && <p className="mt-1 text-[12px] text-rd">{openNew.error.message}</p>}
          </CardBody>
        </Card>
      )}
      {id && <Review id={id} />}
      {l.reviews.length > 1 && (
        <Card title="Earlier reviews">
          <ul>
            {l.reviews
              .filter((r) => r.id !== id)
              .map((r) => (
                <li key={r.id} className="border-t border-hair px-4 py-2.5 first:border-t-0">
                  <button
                    type="button"
                    className="text-[13.5px] font-medium text-t1 underline"
                    onClick={() => setParams({ id: r.id })}
                  >
                    {r.quarter}
                  </button>{' '}
                  <span className="text-[12px] text-t3">
                    {r.status === 'completed' ? 'complete' : 'open'} · {r.counts.attested} of {r.counts.total}
                    {r.counts.revoke ? `, ${r.counts.revoke} to revoke` : ''}
                  </span>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
