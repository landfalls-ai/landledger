import type { CostCenter, RateCard, RateLine, RuleSetVersionView } from '@landledger/contracts';
import { formatDecimal } from '@landledger/money';
import { useQuery } from '@tanstack/react-query';
import { Card, CardBody } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { Pill, Tag } from '@/components/ui/pill';
import { get, quiet } from '@/lib/api';
import { toTsv } from '@/lib/copy';

const date = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** A unit price with every digit it was set with: `$0.0045`, `$0.10`. Exact: from the decimal string, never a float. */
export const unitPrice = (r: Pick<RateLine, 'unitPrice' | 'currency'>) =>
  r.currency === 'USD' ? `$${formatDecimal(r.unitPrice, 2)}` : `${r.currency} ${formatDecimal(r.unitPrice, 2)}`;

const UNIT_WORDS: Record<string, string> = {
  'Core-Hours': 'core-hour',
  'GiB-Hours': 'GiB-hour',
  'GB-Hours': 'GB-hour',
  'GB-Months': 'GB-month',
  '1000000 Tokens': 'million tokens',
  '1000 Tokens': 'thousand tokens',
};
/** A FOCUS pricing unit in words (`Core-Hours` → `core-hour`); an unknown unit as it is. */
export const unitWords = (unit: string) => UNIT_WORDS[unit] ?? unit;

const notApplied = (l: RateLine) => l.details?.['Applied'] === false;

const rateColumns: Column<RateLine>[] = [
  {
    header: 'Rate',
    cell: (r) => (
      <span>
        {r.label}
        <span className="block text-[12px] text-t3">
          per {unitWords(r.pricingUnit)}
          {notApplied(r) && ' · not applied yet'}
        </span>
      </span>
    ),
  },
  { header: 'Price', numeric: true, cell: (r) => unitPrice(r) },
];

const ccColumns: Column<CostCenter>[] = [
  {
    header: 'Cost center',
    cell: (c) => (
      <span>
        <span className="font-mono text-[12px] font-medium tracking-[-0.01em]">{c.code}</span>
        <span className="block text-[12px] text-t3">{c.name}</span>
      </span>
    ),
  },
  { header: 'Owner', cell: (c) => c.ownerName ?? <span className="text-t3">No owner</span> },
  { header: 'Since', cell: (c) => <span className="whitespace-nowrap">{date(c.validFrom)}</span> },
  {
    header: 'Source',
    cell: (c) => (c.origin === 'dev-seed' ? <Tag dashed>dev seed</Tag> : <Tag>{c.origin}</Tag>),
  },
];

const TIERS = [
  ['Automatic', 'under $500'],
  ['Budget owner', 'to $5,000'],
  ['Finance', 'to $25,000'],
  ['CFO', 'above'],
] as const;

/** Rates and rules (docs/ui.md, `#rules`): the real rate card and cost centers from the API. */
export function RulesPage() {
  const cards = useQuery({
    queryKey: ['rate-cards'],
    queryFn: () => get<{ rateCards: RateCard[] }>('/api/rate-cards'),
    retry: quiet,
  });
  const ccs = useQuery({
    queryKey: ['cost-centers'],
    queryFn: () => get<{ costCenters: CostCenter[] }>('/api/cost-centers'),
    retry: quiet,
  });
  const rules = useQuery({
    queryKey: ['rule-sets'],
    queryFn: () => get<{ versions: RuleSetVersionView[] }>('/api/allocation/rule-sets'),
    retry: quiet,
  });
  const ruleSet = rules.data?.versions.find((v) => v.status === 'approved') ?? rules.data?.versions[0] ?? null;
  const card = cards.data?.rateCards[0];
  // The version in effect, else the newest proposal (rate card v1 waits for a person's approval, spec 002).
  const current = card ? (card.current ?? card.versions[0] ?? null) : null;
  const proposed = current?.status === 'proposed';
  // The cluster's lines in the table; the AI lines (Landflow's price table, per model and meter) summed up under it.
  const clusterLines = current?.lines.filter((l) => l.provider === null) ?? [];
  const aiLines = current?.lines.filter((l) => l.provider !== null) ?? [];
  const costCenters = ccs.data?.costCenters ?? [];
  const devSeed = costCenters.some((c) => c.origin === 'dev-seed');

  return (
    <div data-testid="rules">
      <p className="mb-3.5 text-[13px] text-t2">
        How usage becomes cost, where it lands, and who decides. Prices in {card?.currency ?? 'USD'}.
      </p>
      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <Card
          title={current ? `Rate card v${current.version}` : 'Rate card'}
          sub={
            current
              ? proposed
                ? `Proposed for ${date(current.effectiveFrom)}; waits for a person to approve it`
                : `In effect since ${date(current.effectiveFrom)}`
              : cards.isLoading
                ? 'Loading…'
                : 'No version in effect today'
          }
          action={
            current && (
              <span className="flex items-center gap-2">
                {proposed ? <Pill tone="risk">Proposed</Pill> : <Pill tone="ok">Approved</Pill>}
                <CopyButton
                  tsv={() =>
                    toTsv(
                      ['Rate', 'Unit', 'Price', 'Currency'],
                      current.lines.map((l) => [l.label, l.pricingUnit, l.unitPrice, l.currency]),
                    )
                  }
                />
              </span>
            )
          }
          testId="rate-card"
        >
          {cards.isError ? (
            <CardBody className="text-[13px] text-rd">{cards.error.message}</CardBody>
          ) : (
            <DataTable
              columns={rateColumns}
              rows={clusterLines}
              rowKey={(r) => r.id}
              empty="No rates yet. Run pnpm db:seed."
            />
          )}
          {aiLines.length > 0 && (
            <CardBody className="border-t border-hair text-[13px] text-t2">
              <b className="font-medium text-t1">{aiLines.length} AI lines</b> per million tokens for{' '}
              {new Set(aiLines.map((l) => `${l.provider}/${l.model ?? '*'}`)).size} models (input, cache read, cache
              write, output, and the long-context tier), from Landflow&apos;s price table. Local models (Ollama) at $0.
            </CardBody>
          )}
          {card && (
            <CardBody className="border-t border-hair">
              <div className="flex flex-col">
                {card.versions.map((v) => (
                  <div
                    key={v.id}
                    className="flex justify-between gap-3 border-t border-hair py-[7px] text-[14px] first:border-t-0"
                  >
                    <span className="text-t2">
                      v{v.version} <span className="text-t3">· {v.status}</span>
                    </span>
                    <span className="text-t3">
                      {date(v.effectiveFrom)} – {v.effectiveTo ? date(v.effectiveTo) : 'now'}
                    </span>
                  </div>
                ))}
              </div>
              {current?.note && <p className="mt-2.5 text-[12px] text-t3">{current.note}</p>}
              <p className="mt-2.5 rounded-[10px] border border-hair bg-sf2 px-3 py-2.5 text-[13px] text-t2">
                A change is a request, approved by Finance (wave 2).
              </p>
            </CardBody>
          )}
        </Card>

        <div className="flex flex-col gap-3.5">
          <Card title="Shared costs">
            <CardBody>
              <p className="text-[14px] text-t2">
                Whatever no rule matches lands in <b className="font-semibold text-t1">Shared pool</b>: cluster idle,
                ingress, monitoring and backups. It stays its own row and is never folded into a team.
              </p>
            </CardBody>
          </Card>
          <Card title="Not a general ledger">
            <CardBody>
              <p className="text-[14px] text-t2">
                Landledger is a cost subledger for management reporting. Nothing here posts journals. Month-end figures
                go to Datarails.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="mt-3.5 flex flex-col gap-3.5">
        <Card
          title="Cost centers"
          sub={devSeed ? 'Development seed data: the prototype’s sample cost centers and owners' : 'In effect today'}
          action={
            costCenters.length > 0 && (
              <CopyButton
                tsv={() =>
                  toTsv(
                    ['Cost center', 'Name', 'Owner', 'Since', 'Source'],
                    costCenters.map((c) => [c.code, c.name, c.ownerName ?? '', c.validFrom, c.origin]),
                  )
                }
              />
            )
          }
          testId="cost-centers"
        >
          {ccs.isError ? (
            <CardBody className="text-[13px] text-rd">{ccs.error.message}</CardBody>
          ) : (
            <DataTable
              columns={ccColumns}
              rows={costCenters}
              rowKey={(c) => c.code}
              empty="No cost centers yet. Run pnpm db:seed."
            />
          )}
        </Card>

        <Card
          title={ruleSet ? `Allocation rules v${ruleSet.version}` : 'Allocation rules'}
          sub="Checked in order. The first match wins; idle stays in the shared pool; no match is Unallocated."
          action={
            ruleSet &&
            (ruleSet.status === 'approved' ? <Pill tone="ok">Approved</Pill> : <Pill tone="risk">Proposed</Pill>)
          }
          testId="allocation-rules"
        >
          {ruleSet ? (
            <>
              <ol className="flex flex-col">
                {(ruleSet.rules as { id: string; name: string }[]).map((r, i) => (
                  <li key={r.id} className="flex gap-3 border-t border-hair px-4 py-2.5 text-[14px] first:border-t-0">
                    <span className="figure w-5 shrink-0 text-right text-[12px] text-t3">{i + 1}</span>
                    <span className="min-w-0">{r.name}</span>
                  </li>
                ))}
              </ol>
              <CardBody className="border-t border-hair text-[12px] text-t3">
                {ruleSet.origin === 'dev-seed' && (
                  <>
                    <Tag dashed>dev seed</Tag>{' '}
                  </>
                )}
                {ruleSet.approvedBy ? `Approved by ${ruleSet.approvedBy}` : 'Waiting for a controller or the CFO'} ·
                effective {date(ruleSet.effectiveFrom)}
              </CardBody>
            </>
          ) : (
            <CardBody>
              <p className="text-[14px] text-t2">No rules yet: everything lands in Unallocated, idle in Shared pool.</p>
            </CardBody>
          )}
        </Card>

        <Card
          title="Policies"
          sub="Who decides each kind of request. A cost center that is at risk or over adds Finance."
          action={<Pill>Wave 2</Pill>}
        >
          <CardBody>
            <div className="grid grid-cols-4 gap-1">
              {TIERS.map(([who, limit]) => (
                <div
                  key={who}
                  className="rounded-lg border border-hair px-1.5 py-[7px] text-center text-[11.5px] leading-tight text-t3"
                >
                  <b className="block font-medium text-t2">{who}</b>
                  {limit}
                </div>
              ))}
            </div>
            <p className="mt-2.5 text-[13px] text-t2">
              Per month, for infra and AI budget requests. Decided on 14 Nov 2026; enforced when requests arrive in wave
              2.
            </p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
