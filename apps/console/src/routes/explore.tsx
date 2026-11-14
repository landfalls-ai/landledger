import { DIMENSION_LABEL, type Dimension, type SpendGroup, type SpendResult } from '@landledger/contracts';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Download, ExternalLink, X } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { seriesColor, StackChart } from '@/components/spend/charts';
import { Chip, ChipRow, ErrorNote, Estimated, Invoiced, Legend, Lede, Swatch } from '@/components/spend/bits';
import { Card, CardBody } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { type Column, DataTable } from '@/components/ui/data-table';
import { get, quiet } from '@/lib/api';
import { toTsv } from '@/lib/copy';
import { change, dayLabel, num, pct, usd } from '@/lib/format';

const LINK_BUTTON =
  'inline-flex h-[30px] items-center justify-center gap-[7px] whitespace-nowrap rounded-[9px] border border-bd bg-sf px-2.5 text-[12.5px] font-medium text-t1 hover:bg-acdim';

/** The groupings Explore offers, in the order people reach for them (docs/ui.md). */
const DIMS: Dimension[] = [
  'costCenter',
  'service',
  'namespace',
  'agent',
  'model',
  'category',
  'resource',
  'plClass',
  'provider',
  'workflow',
  'team',
  'product',
];

const parseFilters = (params: URLSearchParams) =>
  params
    .getAll('filter')
    .flatMap((f) => f.split(','))
    .filter(Boolean)
    .map((f) => {
      const i = f.indexOf(':');
      return { dimension: f.slice(0, i) as Dimension, value: f.slice(i + 1) };
    });

/** Explore (docs/ui.md): where spend comes from, grouped and filtered by any dimension, with drill-down. */
export function ExplorePage() {
  const [params, setParams] = useSearchParams();
  const by = (params.get('by') as Dimension) || 'costCenter';
  const layer = params.get('layer') === 'spread' ? 'spread' : 'direct';
  const month = params.get('month');
  const filters = parseFilters(params);
  const query = new URLSearchParams({ by, layer, ...(month ? { month } : {}) });
  for (const f of filters) query.append('filter', `${f.dimension}:${f.value}`);
  const q = useQuery({
    queryKey: ['spend', query.toString()],
    queryFn: () => get<SpendResult>(`/api/spend?${query}`),
    retry: quiet,
    placeholderData: (prev) => prev,
  });

  const set = (next: { by?: Dimension; filters?: { dimension: Dimension; value: string }[]; layer?: string }) => {
    const p = new URLSearchParams();
    p.set('by', next.by ?? by);
    if ((next.layer ?? layer) === 'spread') p.set('layer', 'spread');
    if (month) p.set('month', month);
    for (const f of next.filters ?? filters) p.append('filter', `${f.dimension}:${f.value}`);
    setParams(p);
  };

  const r = q.data;
  const drill = r?.drill && !filters.some((f) => f.dimension === r.drill) ? r.drill : null;
  const labelOf = (d: Dimension, value: string) =>
    d === 'costCenter' && r?.by === 'costCenter' ? (r.groups.find((g) => g.key === value)?.label ?? value) : value;

  const columns: Column<SpendGroup>[] = [
    {
      header: DIMENSION_LABEL[by],
      cell: (g) => (
        <span className="block min-w-0">
          {drill ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-left font-medium text-t1 underline-offset-[3px] hover:underline"
              onClick={() => set({ by: drill, filters: [...filters, { dimension: by, value: g.key }] })}
            >
              {g.label}
              <ChevronRight className="size-3.5 text-t3" />
            </button>
          ) : (
            <b className="font-medium">{g.label}</b>
          )}
          {g.key === 'SHARED-POOL' && (
            <span className="ml-1.5 rounded-[4px] border border-hair px-1 text-[11px] text-t3">its own row</span>
          )}
          {g.sub && g.sub !== g.label && <span className="block break-all text-[12px] text-t3">{g.sub}</span>}
          {g.clicklandUrl && (
            <a
              href={g.clicklandUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-[12px] text-t2 underline underline-offset-[3px] hover:text-t1"
            >
              <ExternalLink className="size-3" />
              Open in Clickland
            </a>
          )}
        </span>
      ),
    },
    { header: 'Estimated', numeric: true, cell: (g) => usd(g.estimated) },
    { header: 'Invoiced', numeric: true, cell: (g) => usd(g.invoiced) },
    { header: 'Total', numeric: true, cell: (g) => <b className="font-semibold">{usd(g.total)}</b> },
    {
      header: 'vs window before',
      numeric: true,
      cell: (g) => {
        const c = change(g.total, g.previous);
        return c === null ? (
          <span className="text-t3">new</span>
        ) : (
          <span className={Number(c) > 15 ? 'text-rd' : ''}>{pct(c, true)}</span>
        );
      },
    },
    {
      header: 'Share',
      full: true,
      cell: (g) => (
        <div className="flex items-center gap-2.5">
          <div className="relative h-1.5 min-w-[90px] flex-1 rounded-[3px] bg-nudim">
            <i
              className="absolute inset-y-0 left-0 rounded-[3px] bg-t1"
              style={{
                width: `${r && r.groups[0] && num(r.groups[0].total) > 0 ? (num(g.total) / num(r.groups[0].total)) * 100 : 0}%`,
              }}
            />
          </div>
          <span className="figure min-w-[42px] text-right text-[12px] text-t2">{g.share}%</span>
        </div>
      ),
    },
  ];

  const download = (format: 'csv' | 'xlsx') => {
    const p = new URLSearchParams(query);
    p.set('format', format);
    return `/api/spend/export?${p}`;
  };

  return (
    <div data-testid="explore">
      <Lede>
        {r ? `Where spend comes from, ${dayLabel(r.from)} to ${dayLabel(r.to)}.` : 'Where spend comes from.'} All
        figures in USD.
      </Lede>
      <ChipRow label="Group by">
        {DIMS.map((d) => (
          <Chip key={d} pressed={by === d} onClick={() => set({ by: d })}>
            {DIMENSION_LABEL[d]}
          </Chip>
        ))}
      </ChipRow>
      <ChipRow label="Shared pool">
        <Chip pressed={layer === 'direct'} onClick={() => set({ layer: 'direct' })}>
          On its own
        </Chip>
        <Chip pressed={layer === 'spread'} onClick={() => set({ layer: 'spread' })}>
          Shared out by usage
        </Chip>
        {filters.map((f, i) => (
          <Chip
            key={`${f.dimension}:${f.value}`}
            filter
            onClick={() => set({ filters: filters.filter((_, k) => k !== i) })}
          >
            <span aria-label={`Remove filter ${DIMENSION_LABEL[f.dimension]}: ${f.value}`}>
              {DIMENSION_LABEL[f.dimension]}: {labelOf(f.dimension, f.value)}
            </span>
            <X className="size-3.5" />
          </Chip>
        ))}
      </ChipRow>
      <ErrorNote error={q.isError ? q.error : null} />
      {r && (
        <div className="mt-2 flex flex-col gap-3.5">
          <Card
            title="Daily cost"
            sub={
              <>
                {r.total.invoiced === '0.000000' ? (
                  <>
                    All <Estimated />: usage × the rate card
                  </>
                ) : (
                  <>
                    {usd(r.total.invoiced)} <Invoiced />, the rest <Estimated />
                  </>
                )}
                {r.total.provisional !== '0.000000' && ` · ${usd(r.total.provisional)} today, provisional`}
              </>
            }
            action={<span className="figure text-[15px] font-semibold">{usd(r.total.total)}</span>}
            testId="daily"
          >
            <CardBody>
              <StackChart daily={r.daily} />
              <Legend>
                {r.daily.series.map((s, i) => (
                  <span key={s.key}>
                    <Swatch color={seriesColor(i, s.key)} />
                    {s.label}
                  </span>
                ))}
              </Legend>
            </CardBody>
          </Card>
          <Card
            title={
              <span className="flex flex-wrap items-center gap-1 text-[13px] font-normal text-t3">
                {filters.length ? (
                  <button
                    type="button"
                    className="text-t2 underline underline-offset-[3px]"
                    onClick={() => set({ filters: [] })}
                  >
                    All spend
                  </button>
                ) : (
                  <b className="font-semibold text-t1">All spend</b>
                )}
                {filters.map((f, i) => (
                  <span key={`${f.dimension}:${f.value}`} className="inline-flex items-center gap-1">
                    <span aria-hidden>›</span>
                    {i < filters.length - 1 ? (
                      <button
                        type="button"
                        className="text-t2 underline underline-offset-[3px]"
                        onClick={() => set({ by: filters[i + 1]!.dimension, filters: filters.slice(0, i + 1) })}
                      >
                        {labelOf(f.dimension, f.value)}
                      </button>
                    ) : (
                      <b className="font-semibold text-t1">{labelOf(f.dimension, f.value)}</b>
                    )}
                  </span>
                ))}
                <span> · by {DIMENSION_LABEL[by].toLowerCase()}</span>
              </span>
            }
            action={
              <span className="flex flex-wrap items-center gap-2">
                <CopyButton
                  tsv={() =>
                    toTsv(
                      [DIMENSION_LABEL[by], 'Detail', 'Estimated', 'Invoiced', 'Total', 'Window before', 'Share %'],
                      r.groups.map((g) => [
                        g.label,
                        g.sub ?? '',
                        g.estimated,
                        g.invoiced,
                        g.total,
                        g.previous ?? '',
                        g.share,
                      ]),
                    )
                  }
                />
                <a href={download('xlsx')} className={LINK_BUTTON} download>
                  <Download className="size-3.5" />
                  XLSX
                </a>
                <a href={download('csv')} className={LINK_BUTTON} download>
                  <Download className="size-3.5" />
                  CSV
                </a>
              </span>
            }
            testId="groups"
          >
            <DataTable
              columns={columns}
              rows={r.groups}
              rowKey={(g) => g.key}
              empty="Nothing matches these filters. Remove one to see spend again."
            />
            <div className="flex flex-wrap justify-between gap-2 border-t border-hair px-4 py-3 text-[13px]">
              <span className="font-semibold">Total</span>
              <span className="figure">
                {usd(r.total.estimated)} estimated · {usd(r.total.invoiced)} invoiced · <b>{usd(r.total.total)}</b>
              </span>
            </div>
          </Card>
          <p className="text-[13px] text-t3">
            {drill ? `Open a row to see its ${DIMENSION_LABEL[drill].toLowerCase()}s. ` : ''}
            {r.attribution.directShare}% of the period is attributed to a cost center; the shared pool (
            {usd(r.attribution.sharedPool)}) and unallocated ({usd(r.attribution.unallocated)}) are the rest.
            {layer === 'spread' &&
              ' The shared pool is shared out by each cost center’s direct cost of the same resource that day.'}
          </p>
        </div>
      )}
    </div>
  );
}
