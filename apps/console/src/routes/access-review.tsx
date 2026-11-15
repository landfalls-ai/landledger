import type { AccessItemKind, AccessItemView, AccessReviewView } from '@landledger/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorNote, Lede } from '@/components/spend/bits';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Pill, Tag } from '@/components/ui/pill';
import { get, quiet, send } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { dayLabel } from '@/lib/format';

type ReviewList = { quarter: string; due: boolean; reviews: Omit<AccessReviewView, 'items'>[]; missed?: string[] };

const KIND: Record<AccessItemKind, { title: string; sub: string }> = {
  person: { title: 'People with roles', sub: 'Their roles come from their Landbright groups' },
  key: { title: 'API keys', sub: 'Scopes, bound workflows, last used' },
  link: { title: 'Slack links', sub: 'Decisions relayed from these accounts count as the person’s' },
  relay_channel: { title: 'Relay channels', sub: 'Chats that relay decisions into Landledger' },
  owner: { title: 'Cost center owners', sub: 'Owners and deputies decide their cost center’s requests' },
  webhook: { title: 'Webhooks', sub: 'Where Landledger’s events go, and who subscribed them' },
  session: { title: 'Signed-in sessions', sub: 'Each person signed in to the console now' },
};
const ORDER: AccessItemKind[] = ['person', 'key', 'link', 'session', 'relay_channel', 'webhook', 'owner'];
/** A confirmed revoke of these ends the access at once; any other is tracked until the access is gone. */
const AT_ONCE: readonly AccessItemKind[] = ['key', 'link', 'session'];
const AT_ONCE_WORDS: Partial<Record<AccessItemKind, string>> = {
  key: 'This revokes the key now: whatever uses it stops working.',
  link: 'This removes the Slack link now: decisions relayed from that account stop counting.',
  session: 'This signs the person out of every console session now.',
};

/** The controller or the CFO, signed in (the API checks again, and refuses an item about yourself). */
function useAttester(): { can: boolean; cfo: boolean; userId: string | null } {
  const me = useMe().data;
  if (!me || me.kind !== 'person') return { can: false, cfo: false, userId: null };
  return {
    can: me.user.roles.some((r) => r === 'controller' || r === 'cfo'),
    cfo: me.user.roles.includes('cfo'),
    userId: me.user.id,
  };
}

function Attest({ reviewId, item }: { reviewId: string; item: AccessItemView }) {
  const qc = useQueryClient();
  const [revoking, setRevoking] = useState(false);
  const [comment, setComment] = useState('');
  const [confirm, setConfirm] = useState(false);
  const atOnce = AT_ONCE.includes(item.kind);
  const run = useMutation({
    mutationFn: (decision: 'keep' | 'revoke') =>
      send<AccessReviewView>('POST', `/api/access-reviews/${reviewId}/items/${item.id}/attest`, {
        decision,
        comment,
        ...(decision === 'revoke' && atOnce ? { confirm } : {}),
      }),
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
          {atOnce && (
            <label className="flex w-full items-start gap-2 text-[12.5px] text-t2">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
              <span>{AT_ONCE_WORDS[item.kind]}</span>
            </label>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={comment.trim().length < 3 || (atOnce && !confirm) || run.isPending}
            onClick={() => run.mutate('revoke')}
          >
            {atOnce ? 'Revoke now' : 'Revoke'}
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
  const { can, cfo, userId } = useAttester();
  const mine = !!userId && item.about.includes(userId);
  const a = item.attestation;
  const allowed = can && !mine && (!item.cfoOnly || cfo);
  return (
    <li className="border-t border-hair px-4 py-3 first:border-t-0" data-testid={`item-${item.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-t1">{item.label}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          {item.addedAt && <Tag dashed>added {dayLabel(item.addedAt.slice(0, 10))}</Tag>}
          {item.cfoOnly && <Tag>CFO attests</Tag>}
          {a ? (
            <Pill
              tone={a.decision === 'keep' ? 'ok' : item.outstanding ? 'risk' : 'over'}
              data-testid={`attested-${item.id}`}
            >
              {a.decision === 'keep' ? 'Kept' : item.outstanding ? 'Revoke outstanding' : 'Revoked'}
            </Pill>
          ) : (
            <Pill tone="nu">To attest</Pill>
          )}
        </span>
      </div>
      <p className="mt-0.5 text-[12.5px] text-t2">{item.detail}</p>
      {a && (
        <p className="mt-1 text-[12px] text-t3">
          {a.by}, {dayLabel(a.at.slice(0, 10))}
          {a.comment ? `: ${a.comment}` : ''}
        </p>
      )}
      {item.revocation && (
        <p className="mt-0.5 text-[12px] text-t3" data-testid={`revocation-${item.id}`}>
          {item.revocation.how}, {dayLabel(item.revocation.at.slice(0, 10))}
        </p>
      )}
      {item.outstanding && (
        <p className="mt-0.5 text-[12px] text-warn" data-testid={`outstanding-${item.id}`}>
          Still there: the review completes once it is gone ({item.kind === 'person' ? 'in Landbright' : 'in Settings'}
          ).
        </p>
      )}
      {!a && open && allowed && <Attest reviewId={reviewId} item={item} />}
      {!a && open && can && !mine && item.cfoOnly && !cfo && (
        <p className="mt-1 text-[12px] text-t3">No person in Landledger stands behind it: the CFO attests it.</p>
      )}
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
          {open
            ? v.counts.attested === v.counts.total && v.counts.outstanding
              ? `${v.counts.outstanding} revoke${v.counts.outstanding === 1 ? '' : 's'} outstanding`
              : `${v.counts.attested} of ${v.counts.total} attested`
            : 'Complete'}
        </Pill>
        <span className="text-[12px] text-t3">
          Opened by {v.openedBy}, {dayLabel(v.openedAt.slice(0, 10))}
          {v.completedAt ? ` · completed ${dayLabel(v.completedAt.slice(0, 10))}` : ''}
          {v.counts.revoke ? ` · ${v.counts.revoke} revoked` : ''}
          {v.counts.added ? ` · ${v.counts.added} added since it opened` : ''}
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
          A key, a Slack link or a person’s sessions are revoked here, at once, when the attester confirms. Anything
          else (roles in Landbright, a relay channel, a webhook, a cost center’s owners) is tracked until it is gone,
          and the review completes only then.
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
        links, signed-in sessions, relay channels, webhooks and cost center owners, including anything granted after the
        review opened. Each item is kept or revoked, never by the person it is about, and every attestation is in the
        audit log. A reminder goes out each week until it is complete; a quarter that ends without one is recorded.
      </Lede>
      {(l.missed ?? []).length > 0 && (
        <p className="text-[13px] text-rd" data-testid="missed-quarters">
          Missed: {(l.missed ?? []).join(', ')} ended without a completed review.
        </p>
      )}
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
                    {r.counts.revoke ? `, ${r.counts.revoke} revoked` : ''}
                    {r.counts.outstanding ? `, ${r.counts.outstanding} outstanding` : ''}
                  </span>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
