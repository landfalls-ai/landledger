import type { Overview, SpendResult } from '@landledger/contracts';
import { useLayoutEffect, useRef, useState } from 'react';
import { dayLabel, num, usd } from '@/lib/format';

/** The width of an element, kept up to date (charts draw to their card's width, as the prototype's do). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || 600);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A round top for an axis: 1, 2, 2.5 or 5 × a power of ten. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
const axis = (v: number) =>
  v >= 1000 ? `$${v / 1000}k` : v >= 1 || v === 0 ? `$${+v.toFixed(2)}` : `$${+v.toPrecision(2)}`;

const TEXT = 'fill-t3 text-[11px] [font-family:var(--font-mono)]';

/** The month's burn (docs/ui.md): cumulative actual, the forecast and its band to month end, the budget line. */
export function BurnChart({ overview }: { overview: Overview }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const H = W < 520 ? 230 : 270;
  const l = 48;
  const r = 10;
  const t = 14;
  const b = 24;
  const pw = Math.max(W - l - r, 1);
  const ph = H - t - b;
  const burn = overview.burn;
  const n = burn.length;
  const budget = overview.budget.amount ? num(overview.budget.amount) : null;
  const top = niceMax(Math.max(budget ?? 0, ...burn.map((p) => Math.max(num(p.actual), num(p.high)))) * 1.08);
  const x = (i: number) => l + (n > 1 ? (i / (n - 1)) * pw : 0);
  const y = (v: number) => t + ph - (v / top) * ph;
  const actual = burn.map((p, i) => [i, p.actual] as const).filter(([, v]) => v !== null) as [number, string][];
  const ahead = burn.map((p, i) => [i, p] as const).filter(([, p]) => p.forecast !== null);
  const last = actual.at(-1);
  const end = ahead.at(-1);
  const line = actual.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(num(v)).toFixed(1)}`).join('');
  const band =
    ahead.length > 1
      ? `M${ahead.map(([i, p]) => `${x(i).toFixed(1)} ${y(num(p.high)).toFixed(1)}`).join('L')}L${[...ahead]
          .reverse()
          .map(([i, p]) => `${x(i).toFixed(1)} ${y(num(p.low)).toFixed(1)}`)
          .join('L')}Z`
      : '';
  const ticks = [0, top / 4, top / 2, (3 * top) / 4, top];
  const days = (W < 520 ? [0, Math.floor((n - 1) / 2), n - 1] : [0, 6, 13, 20, n - 1]).filter(
    (i, k, a) => i < n && a.indexOf(i) === k,
  );
  const label = `Cumulative cost in ${overview.month}: ${usd(overview.monthToDate.total)} to date, forecast ${usd(overview.forecast.amount)}${budget !== null ? ` against a budget of ${usd(overview.budget.amount)}` : ''}.`;
  return (
    <div ref={ref} className="w-full" data-testid="burn-chart">
      {W > 0 && (
        <svg viewBox={`0 0 ${W} ${H}`} height={H} width={W} role="img" aria-label={label}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={l} x2={W - r} y1={y(v)} y2={y(v)} className="stroke-hair" />
              <text x={l - 8} y={y(v) + 4} textAnchor="end" className={TEXT}>
                {axis(v)}
              </text>
            </g>
          ))}
          {days.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={H - 6}
              textAnchor={i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle'}
              className={TEXT}
            >
              {dayLabel(burn[i]!.day)}
            </text>
          ))}
          {budget !== null && (
            <g>
              <line x1={l} x2={W - r} y1={y(budget)} y2={y(budget)} className="stroke-t3" strokeWidth={1.5} />
              <text x={l + 4} y={y(budget) - 6} className="fill-t2 text-[11px] font-medium">
                Budget {usd(overview.budget.amount, { whole: true })}
              </text>
            </g>
          )}
          {band && <path d={band} className="fill-viz-1" opacity={0.18} />}
          {last && end && (
            <line
              x1={x(last[0])}
              y1={y(num(last[1]))}
              x2={x(end[0])}
              y2={y(num(end[1].forecast))}
              className="stroke-viz-1"
              strokeWidth={2}
              strokeDasharray="5 4"
            />
          )}
          <path
            d={line}
            fill="none"
            className="stroke-viz-1"
            strokeWidth={2.25}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {last && (
            <g>
              <circle cx={x(last[0])} cy={y(num(last[1]))} r={4} className="fill-viz-1 stroke-sf" strokeWidth={2} />
              <text
                x={Math.min(x(last[0]) + 9, W - r - 90)}
                y={y(num(last[1])) - 9}
                className="fill-t1 text-[11px] font-medium"
              >
                {usd(last[1])} today
              </text>
            </g>
          )}
          {end && (
            <g>
              <circle
                cx={x(end[0])}
                cy={y(num(end[1].forecast))}
                r={3.5}
                className="fill-sf stroke-viz-1"
                strokeWidth={2}
              />
              <text x={W - r} y={y(num(end[1].high)) - 8} textAnchor="end" className="fill-t1 text-[11px] font-medium">
                Forecast {usd(end[1].forecast)}
              </text>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

export const SERIES_COLORS = [
  'var(--color-viz-1)',
  'var(--color-viz-2)',
  'var(--color-viz-3)',
  'var(--color-viz-4)',
  'var(--color-viz-7)',
];
export const seriesColor = (i: number, key: string) =>
  key === 'other' ? 'var(--color-t3)' : SERIES_COLORS[i % SERIES_COLORS.length]!;

/** Daily cost, stacked by the top groups and the rest (Explore). */
export function StackChart({ daily }: { daily: SpendResult['daily'] }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const H = 200;
  const l = 48;
  const r = 4;
  const t = 8;
  const b = 22;
  const pw = Math.max(W - l - r, 1);
  const ph = H - t - b;
  const n = daily.days.length;
  const totals = daily.days.map((_, i) => daily.series.reduce((s, x) => s + num(x.values[i]), 0));
  const top = niceMax(Math.max(...totals, 0));
  const y = (v: number) => t + ph - (v / top) * ph;
  const bw = Math.min(30, (pw / Math.max(n, 1)) * 0.64);
  const every = W < 520 ? Math.ceil(n / 8) : Math.ceil(n / 16);
  return (
    <div ref={ref} className="w-full" data-testid="stack-chart">
      {W > 0 && (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          height={H}
          width={W}
          role="img"
          aria-label={`Daily cost, ${daily.days[0]} to ${daily.days.at(-1)}, stacked by group.`}
        >
          {[0, top / 2, top].map((v) => (
            <g key={v}>
              <line x1={l} x2={W - r} y1={y(v)} y2={y(v)} className="stroke-hair" />
              <text x={l - 8} y={y(v) + 4} textAnchor="end" className={TEXT}>
                {axis(v)}
              </text>
            </g>
          ))}
          {daily.days.map((d, i) => {
            const cx = l + ((i + 0.5) * pw) / n;
            let acc = 0;
            return (
              <g key={d}>
                {daily.series.map((s, k) => {
                  const v = num(s.values[i]);
                  const y1 = y(acc + v);
                  const hh = y(acc) - y1;
                  acc += v;
                  if (hh <= 0.6) return null;
                  return (
                    <rect
                      key={s.key}
                      x={cx - bw / 2}
                      y={y1}
                      width={bw}
                      height={Math.max(hh - 1, 0.5)}
                      rx={1.5}
                      fill={seriesColor(k, s.key)}
                      opacity={s.key === 'other' ? 0.45 : 1}
                    >
                      <title>{`${dayLabel(d)} · ${s.label}: ${usd(s.values[i])}`}</title>
                    </rect>
                  );
                })}
                {i % every === 0 && (
                  <text x={cx} y={H - 6} textAnchor="middle" className={TEXT}>
                    {Number(d.slice(8, 10))}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/** A split bar: invoiced solid, estimated hatched (the prototype's `.sb`). */
export function SplitBar({ invoiced, estimated, scale }: { invoiced: number; estimated: number; scale: number }) {
  const w = (v: number) => `${scale > 0 ? Math.min(100, (v / scale) * 100) : 0}%`;
  return (
    <div
      className="col-span-full mt-[3px] flex h-2 overflow-hidden rounded-[4px] bg-nudim"
      role="img"
      aria-label={`${scale > 0 ? Math.round(((invoiced + estimated) / scale) * 100) : 0}% of the largest`}
    >
      <i className="block bg-t1" style={{ width: w(invoiced) }} />
      <u
        className="block"
        style={{
          width: w(estimated),
          background: 'repeating-linear-gradient(135deg,var(--color-t3) 0 2px,transparent 2px 5px)',
        }}
      />
    </div>
  );
}

/** Actual (solid) and reserved (faint) against the budget marker, the prototype's `.bar`. */
export function BudgetBar({
  actual,
  reserved,
  budget,
  state,
}: {
  actual: number;
  reserved: number;
  budget: number | null;
  state: string;
}) {
  if (budget === null || budget <= 0) return <span className="text-[12px] text-t3">No budget</span>;
  const d = Math.max(budget, actual + reserved);
  const used = Math.round(((actual + reserved) / budget) * 100);
  const tone = state === 'over' ? 'bg-rd' : state === 'risk' ? 'bg-warn' : 'bg-t1';
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="relative h-1.5 min-w-[90px] flex-1 rounded-[3px] bg-nudim"
        role="img"
        aria-label={`${used}% of budget used or reserved`}
      >
        <i
          className={`absolute inset-y-0 left-0 rounded-l-[3px] ${tone}`}
          style={{ width: `${(actual / d) * 100}%` }}
        />
        <u
          className={`absolute inset-y-0 opacity-35 ${tone}`}
          style={{ left: `${(actual / d) * 100}%`, width: `${(reserved / d) * 100}%` }}
        />
        <b
          className="absolute -inset-y-[3px] w-0.5 rounded-[1px] bg-t1"
          style={{ left: `calc(${(budget / d) * 100}% - 2px)` }}
        />
      </div>
      <span className="figure min-w-[42px] text-right text-[12px] text-t2">{used}%</span>
    </div>
  );
}
