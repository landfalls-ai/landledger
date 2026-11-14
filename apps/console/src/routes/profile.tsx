import type { PersonLinkView } from '@landledger/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { get, quiet, send } from '@/lib/api';
import { roleLine, useMe } from '@/lib/auth';
import { when } from '@/lib/requests';

/**
 * Your profile (review of wave 2): who you are here, and Link Slack. A Slack button press decides as you only once you
 * link your Slack user id yourself, from your own session; nobody else, and no key, can make that link.
 */
export function ProfilePage() {
  const me = useMe().data;
  const qc = useQueryClient();
  const [slackId, setSlackId] = useState('');
  const links = useQuery({
    queryKey: ['me', 'links'],
    queryFn: () => get<{ links: PersonLinkView[] }>('/api/me/links'),
    retry: quiet,
    enabled: me?.kind === 'person',
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['me', 'links'] });
  const link = useMutation({
    mutationFn: () => send('POST', '/api/me/links', { kind: 'slack', externalId: slackId.trim() }),
    onSuccess: () => {
      setSlackId('');
      refresh();
    },
  });
  const unlink = useMutation({
    mutationFn: (id: string) => send('DELETE', `/api/me/links/${id}`),
    onSuccess: refresh,
  });
  const slack = links.data?.links.find((l) => l.kind === 'slack') ?? null;
  const valid = /^[UW][A-Z0-9_]+$/.test(slackId.trim());
  return (
    <div data-testid="profile" className="flex max-w-[640px] flex-col gap-3.5">
      <Card title="You">
        <CardBody>
          {me ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[14px]">
              <dt className="text-[13px] text-t3">Name</dt>
              <dd>{me.user.name}</dd>
              <dt className="text-[13px] text-t3">Email</dt>
              <dd className="break-words">{me.user.email ?? '—'}</dd>
              <dt className="text-[13px] text-t3">Role</dt>
              <dd>{roleLine(me)}</dd>
            </dl>
          ) : (
            <p className="text-[13px] text-t3">Loading…</p>
          )}
        </CardBody>
      </Card>
      <Card
        title="Link Slack"
        sub="So a budget owner’s Approve on a Slack card decides as you. Only you link it, signed in here."
        testId="link-slack"
      >
        <CardBody>
          {me?.kind !== 'person' ? (
            <p className="text-[13px] text-t3">Sign in with Landbright to link your Slack account.</p>
          ) : slack ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-[14px]" data-testid="slack-linked">
              <span>
                Linked to Slack user <span className="font-mono text-[13px]">{slack.externalId}</span>
                <small className="block text-[12px] text-t3">since {when(slack.createdAt)}</small>
              </span>
              <Button size="sm" disabled={unlink.isPending} onClick={() => unlink.mutate(slack.id)}>
                Unlink
              </Button>
            </div>
          ) : (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) link.mutate();
              }}
            >
              <label htmlFor="slack-id" className="text-[12px] text-t3">
                Your Slack member ID (Slack: your profile → ⋮ → Copy member ID), like U012AB3CD
              </label>
              <input
                id="slack-id"
                value={slackId}
                onChange={(e) => setSlackId(e.target.value.toUpperCase())}
                placeholder="U012AB3CD"
                autoComplete="off"
                className="h-10 rounded-[10px] border border-bd bg-sf px-3 font-mono text-[14px] text-t1 outline-none focus:border-t2"
              />
              <Button
                type="submit"
                variant="primary"
                disabled={!valid || link.isPending}
                data-testid="link-slack-submit"
              >
                Link Slack
              </Button>
            </form>
          )}
          {(link.error ?? unlink.error ?? links.error) && (
            <p className="mt-2 text-[12.5px] text-rd" role="alert">
              {(link.error ?? unlink.error ?? links.error)!.message}
            </p>
          )}
          <p className="mt-3 text-[12px] text-t3">
            A relay never decides Finance’s or the CFO’s step, nor rate card, rule set or policy changes: those are
            decided here. Every relayed decision is sent back to you and marked in the audit log.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
