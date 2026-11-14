import type { AuditEntry, AuditVerify } from '@landledger/contracts';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { Pill } from '@/components/ui/pill';
import { get, quiet } from '@/lib/api';
import { toTsv } from '@/lib/copy';
import { cn } from '@/lib/cn';
import { when } from '@/lib/requests';

const PAGE = 50;

/** An action in words: `request.decided` → `Request decided`, `rate_card.version_approved` → `Rate card version approved`. */
export function actionWords(action: string): string {
  const s = action.replace(/[._]/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Who can do what: keys, roles, relay channels and links, owners. Shown beside the decisions they made possible. */
export const isAccessChange = (a: string) =>
  /^(api_key\.|scim\.user_|scim\.token_|relay_channel\.|person_link\.|cost_center\.owners_set|auth\.signed_in|auth\.backchannel_logout)/.test(
    a,
  );
const isDecision = (a: string) =>
  /^request\.(step_approved|step_rejected|approved|rejected|confirmed|declined|cancelled|expired|step_escalated)$/.test(
    a,
  );

/** What the record names, from its data when it carries a title, a number or an outcome. */
function detail(e: AuditEntry): string {
  const d = e.data as Record<string, unknown>;
  if (e.action.startsWith('api_key.'))
    return `${String(d.name ?? e.subjectId)}${Array.isArray(d.scopes) ? ` · ${(d.scopes as string[]).join(', ')}` : ''}`;
  if (e.action === 'auth.signed_in' && Array.isArray(d.roles))
    return `roles ${(d.roles as string[]).join(', ') || 'none'}${Array.isArray(d.groups) ? ` · groups ${(d.groups as string[]).join(', ')}` : ''}`;
  if (d.relayed === true)
    return `${e.subjectId} · step ${String(d.step)} · relayed from ${String(d.channel ?? 'a relay')} user ${String(d.externalUserId ?? '')} by key ${String(d.relayedBy ?? '').replace(/^key:/, '')}`;
  const bits = [d.number, d.title, d.outcome, d.costCenter]
    .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
    .map(String);
  return bits.length ? bits.join(' · ') : `${e.subjectType} ${e.subjectId}`;
}

const columns: Column<AuditEntry>[] = [
  {
    header: 'What',
    cell: (e) => (
      <span>
        <b className="font-medium">{actionWords(e.action)}</b>
        {(e.data as Record<string, unknown>).relayed === true && (
          <Pill tone="risk" className="ml-1.5" data-testid="audit-relayed">
            Relayed
          </Pill>
        )}
        {isAccessChange(e.action) && <Pill className="ml-1.5">Access</Pill>}
        <span className="block break-words text-[12px] text-t3">{detail(e)}</span>
      </span>
    ),
  },
  {
    header: 'Who',
    full: true,
    cell: (e) => (
      <span className="break-words">
        {e.actor} <span className="text-t3">· {e.actorKind}</span>
      </span>
    ),
  },
  { header: 'Kind', cell: (e) => <Pill>{e.subjectType}</Pill> },
  { header: 'When', cell: (e) => <span className="whitespace-nowrap">{when(e.at)}</span> },
  { header: 'Hash', cell: (e) => <span className="font-mono text-[12px] text-t2">{e.hash.slice(0, 12)}</span> },
  {
    header: 'Chain',
    numeric: true,
    cell: (e) => (
      <span>
        #{e.seq.toLocaleString('en-US')} <span className="text-t3">← {e.prevHash.slice(0, 6)}</span>
      </span>
    ),
  },
];

/** Audit (docs/ui.md, `#audit`): every record, newest first, and Verify chain. */
export function AuditPage() {
  const pages = useInfiniteQuery({
    queryKey: ['audit'],
    queryFn: ({ pageParam }) =>
      get<{ entries: AuditEntry[]; total: number }>(
        `/api/audit?limit=${PAGE}${pageParam ? `&before=${pageParam}` : ''}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.entries.length === PAGE && last.entries.at(-1)!.seq > 1 ? last.entries.at(-1)!.seq : undefined,
    retry: quiet,
  });
  const verify = useMutation({ mutationFn: () => get<AuditVerify>('/api/audit/verify') });
  const [only, setOnly] = useState(false);
  const all = pages.data?.pages.flatMap((p) => p.entries) ?? [];
  const entries = only ? all.filter((e) => isDecision(e.action) || isAccessChange(e.action)) : all;
  const total = pages.data?.pages[0]?.total ?? 0;
  const v = verify.data;
  return (
    <div data-testid="audit">
      <p className="mb-3.5 text-[13px] text-t2">
        Every decision, rule, rate and period change, newest first. Auditors see this screen, Explore and Budgets,
        read-only.
      </p>
      <div
        className={cn(
          'mb-3.5 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border px-3 py-2.5 text-[13px]',
          v ? (v.ok ? 'border-gnbd bg-gndim text-t1' : 'border-rdbd bg-rddim text-t1') : 'border-hair bg-sf2 text-t2',
        )}
        aria-live="polite"
        data-testid="verify"
      >
        <span>
          {verify.isPending ? (
            'Checking each record against the one before it…'
          ) : v ? (
            v.ok ? (
              <>
                <b className="font-semibold">Chain intact.</b> {v.checked.toLocaleString('en-US')} records, each one’s
                hash matches the next. Checked just now.
                {v.anchor && ` Anchored outside the database at #${v.anchor.seq.toLocaleString('en-US')}.`}
              </>
            ) : (
              <>
                <b className="font-semibold">Chain broken at record {v.brokenAt}.</b> {v.reason}
              </>
            )
          ) : verify.isError ? (
            verify.error.message
          ) : (
            <>
              <b className="font-semibold">{total.toLocaleString('en-US')} records.</b> Each carries the hash of the one
              before, so a changed record breaks the chain.
            </>
          )}
        </span>
        <Button size="sm" disabled={verify.isPending} onClick={() => verify.mutate()}>
          <ShieldCheck className="size-3.5" />
          Verify chain
        </Button>
      </div>
      <div className="mb-2.5 flex gap-1.5" role="group" aria-label="Show">
        <Button size="sm" variant={only ? 'default' : 'primary'} onClick={() => setOnly(false)}>
          Everything
        </Button>
        <Button
          size="sm"
          variant={only ? 'primary' : 'default'}
          onClick={() => setOnly(true)}
          data-testid="audit-decisions-access"
        >
          Decisions and access changes
        </Button>
      </div>
      <Card
        title="Records"
        sub={
          total ? `The latest ${entries.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}` : undefined
        }
        action={
          entries.length > 0 && (
            <CopyButton
              tsv={() =>
                toTsv(
                  [
                    'Seq',
                    'When',
                    'Action',
                    'Actor',
                    'Actor kind',
                    'Subject type',
                    'Subject id',
                    'Hash',
                    'Previous hash',
                  ],
                  entries.map((e) => [
                    String(e.seq),
                    e.at,
                    e.action,
                    e.actor,
                    e.actorKind,
                    e.subjectType,
                    e.subjectId,
                    e.hash,
                    e.prevHash,
                  ]),
                )
              }
            />
          )
        }
        testId="audit-records"
      >
        {pages.isError ? (
          <CardBody className="text-[13px] text-rd">{pages.error.message}</CardBody>
        ) : (
          <DataTable
            columns={columns}
            rows={entries}
            rowKey={(e) => String(e.seq)}
            empty={pages.isLoading ? 'Loading…' : 'No records yet.'}
          />
        )}
        {pages.hasNextPage && (
          <CardBody className="border-t border-hair">
            <Button size="sm" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
              Older records
            </Button>
          </CardBody>
        )}
      </Card>
    </div>
  );
}
