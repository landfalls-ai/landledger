/**
 * The frozen close snapshot (wave 4, spec 016). At step 7, when a controller accepts the accrual, the month's figures
 * are frozen as canonical JSON with a sha256: by cost center, P&L class and provider, the reconciliation, the requests
 * reserved in the month, the accrual, the figures each variance note may cite, and the gates as they stood. Notes, the
 * Datarails upload and the month-end package cite the hash; the audit log records it. `ledger_sha256` covers the ledger
 * part alone, so "the figures are still the snapshot's" is a comparison of two hashes.
 */
import type { CloseSnapshotFigures, CloseSnapshotView, NoteFigures } from '@landledger/contracts';
import { Money, REPORTING_CURRENCY } from '@landledger/money';
import type { AuditLog } from './audit.js';
import type { Budgets } from './budgets.js';
import { canonicalJson } from './canonical.js';
import { day as dayOf, type Sql, type Tx } from './db.js';
import type { ForecastHistory } from './forecast-history.js';
import { TOTAL } from './forecast-history.js';
import { newId, sha256 } from './ids.js';
import type { Invoices } from './invoices.js';
import { amount, ccLabel, CORRECTIONS, keyOf, type Line, plClassOf, type Spend } from './spend.js';

const USD = REPORTING_CURRENCY;
const zero = () => Money.zero(USD);
const sum = (ls: readonly Line[]) =>
  Money.sum(
    ls.map((l) => l.amount),
    USD,
  );
const PL_LABEL: Record<string, string> = {
  cost_of_revenue: 'Cost of revenue',
  rnd: 'R&D',
  sm: 'Sales & marketing',
  ga: 'G&A',
  shared: 'Shared pool',
  unclassified: 'Not classified',
  correction: 'Corrections to locked months',
};

/** Cluster cost from Clickland is notional: never actuals (docs/architecture.md, "Datarails"). */
export const isNotional = (l: Pick<Line, 'source'>) => l.source === 'clickland';

export const prevMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

export type LedgerFigures = Pick<
  CloseSnapshotFigures,
  'month' | 'currency' | 'total' | 'byCostCenter' | 'byPlClass' | 'byProvider' | 'reconciliation'
>;

type SnapRow = {
  id: string;
  month: Date;
  version: number;
  figures: CloseSnapshotFigures;
  sha256: string;
  ledger_sha256: string;
  accrual_id: string | null;
  frozen_by: string;
  frozen_at: Date;
  frozen_email?: string | null;
};

/** The drivers of a note: the services, agents and models whose cost changed most against the month before. */
export function driversOf(
  mine: readonly Line[],
  before: readonly Line[],
  ccs: Parameters<typeof keyOf>[2],
): NoteFigures['drivers'] {
  const out: NoteFigures['drivers'] = [];
  for (const dimension of ['service', 'agent', 'model'] as const) {
    const now = new Map<string, { label: string; m: Money }>();
    const was = new Map<string, Money>();
    for (const l of mine) {
      const k = keyOf(l, dimension, ccs);
      if (k.key === '(none)') continue;
      const g = now.get(k.key) ?? { label: k.label, m: zero() };
      g.m = g.m.plus(l.amount);
      now.set(k.key, g);
    }
    for (const l of before) {
      const k = keyOf(l, dimension, ccs);
      if (k.key === '(none)') continue;
      was.set(k.key, (was.get(k.key) ?? zero()).plus(l.amount));
      if (!now.has(k.key)) now.set(k.key, { label: k.label, m: zero() });
    }
    const rows = [...now.entries()]
      .map(([key, g]) => {
        const previous = was.get(key) ?? zero();
        return { key, label: g.label, now: g.m, previous, change: g.m.minus(previous) };
      })
      .filter((r) => !r.change.posted().isZero())
      .sort((a, b) => b.change.abs().compare(a.change.abs()) || a.key.localeCompare(b.key))
      .slice(0, 3);
    for (const r of rows)
      out.push({
        dimension,
        key: r.key,
        label: r.label,
        amount: amount(r.now),
        previous: amount(r.previous),
        change: amount(r.change),
      });
  }
  return out;
}

export class Snapshots {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly spend: Spend,
    private readonly budgets: Budgets,
    private readonly invoices: Invoices,
    private readonly forecasts: ForecastHistory,
  ) {}

  /** The month's lines as booked (no provisional rows): what every figure of the close reads. */
  async monthLines(month: string): Promise<Line[]> {
    return (await this.spend.lines({ fromMonth: month, toMonth: month }, false)).lines;
  }

  /** The ledger part of the figures, as they stand now. */
  async ledgerFigures(month: string, lines?: Line[]): Promise<LedgerFigures> {
    const ls = lines ?? (await this.monthLines(month));
    const ccs = await this.spend.costCenters();
    const budgets = await this.budgets.forMonth(month);
    const ccOf = (l: Line) => (l.correction ? CORRECTIONS : l.costCenter);
    const codes = [...new Set([...ls.map(ccOf), ...budgets.keys()])].sort();
    const part = (xs: readonly Line[]) => ({
      estimated: amount(sum(xs.filter((l) => l.basis === 'estimated' && !isNotional(l)))),
      invoiced: amount(sum(xs.filter((l) => l.basis === 'invoiced'))),
      notional: amount(sum(xs.filter((l) => l.basis === 'estimated' && isNotional(l)))),
      total: amount(sum(xs)),
    });
    const pl = new Map<string, Line[]>();
    for (const l of ls) {
      const k = l.correction ? 'correction' : plClassOf(l);
      pl.set(k, [...(pl.get(k) ?? []), l]);
    }
    const prov = new Map<string, Line[]>();
    for (const l of ls) prov.set(l.providerName, [...(prov.get(l.providerName) ?? []), l]);
    const rec = await this.invoices.reconciliation(month);
    return {
      month,
      currency: 'USD',
      total: part(ls),
      byCostCenter: codes.map((code) => {
        const b = budgets.get(code)?.amount ?? null;
        return {
          code,
          name: ccLabel(code, ccs),
          ...part(ls.filter((l) => ccOf(l) === code)),
          budget: b ? amount(b) : null,
        };
      }),
      byPlClass: [...pl.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, xs]) => ({
          key,
          label: PL_LABEL[key] ?? key,
          total: amount(sum(xs)),
          invoiced: amount(sum(xs.filter((l) => l.basis === 'invoiced'))),
        })),
      byProvider: [...prov.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([provider, xs]) => ({
          provider,
          estimated: amount(sum(xs.filter((l) => l.basis === 'estimated'))),
          invoiced: amount(sum(xs.filter((l) => l.basis === 'invoiced'))),
          total: amount(sum(xs)),
        })),
      reconciliation: {
        rows: rec.rows
          .filter((r) => !r.devFixture)
          .map((r) => ({
            provider: r.provider,
            model: r.model,
            estimated: r.estimated,
            invoiced: r.invoiced,
            variance: r.variance,
            status: r.status,
          })),
        totals: { estimated: rec.totals.estimated, invoiced: rec.totals.invoiced },
      },
    };
  }

  static ledgerSha(f: LedgerFigures): string {
    const { month, currency, total, byCostCenter, byPlClass, byProvider, reconciliation } = f;
    return sha256(canonicalJson({ month, currency, total, byCostCenter, byPlClass, byProvider, reconciliation }));
  }

  /** The notes the month needs (the month as a whole and every cost center with an actual or a budget), with figures. */
  async noteFigures(month: string, ledger: LedgerFigures, lines: Line[]): Promise<NoteFigures[]> {
    const ccs = await this.spend.costCenters();
    const before = await this.monthLines(prevMonth(month));
    const out: NoteFigures[] = [];
    const build = async (
      code: string,
      name: string,
      actualS: string,
      budgetS: string | null,
      mine: Line[],
      prior: Line[],
    ): Promise<NoteFigures> => {
      const actual = Money.parse(actualS, USD);
      const budget = budgetS === null ? null : Money.parse(budgetS, USD);
      const f10 = await this.forecasts.day10(month, code);
      const forecast = f10?.p50 ? Money.parse(f10.p50, USD) : null;
      const vb = budget ? actual.minus(budget) : null;
      return {
        costCenter: code,
        name,
        actual: amount(actual),
        budget: budget ? amount(budget) : null,
        forecastDay10: forecast ? amount(forecast) : null,
        varianceBudget: vb ? amount(vb) : null,
        varianceBudgetPct:
          vb && budget && !budget.isZero()
            ? vb.toDecimal().times('100').divide(budget.toDecimal(), 1, 'halfEven').toFixed(1, 'halfEven')
            : null,
        varianceForecast: forecast ? amount(actual.minus(forecast)) : null,
        drivers: driversOf(mine, prior, ccs),
      };
    };
    const totalBudget = ledger.byCostCenter.some((c) => c.budget !== null)
      ? amount(
          Money.sum(
            ledger.byCostCenter.filter((c) => c.budget !== null).map((c) => Money.parse(c.budget!, USD)),
            USD,
          ),
        )
      : null;
    out.push(await build(TOTAL, `The month (${month})`, ledger.total.total, totalBudget, lines, before));
    for (const c of ledger.byCostCenter) {
      if (c.code === CORRECTIONS) continue;
      const hasActual = !Money.parse(c.total, USD).posted().isZero();
      if (!hasActual && c.budget === null) continue;
      const mine = lines.filter((l) => !l.correction && l.costCenter === c.code);
      const prior = before.filter((l) => !l.correction && l.costCenter === c.code);
      out.push(await build(c.code, c.name, c.total, c.budget, mine, prior));
    }
    return out;
  }

  /** The requests reserved in the month: what each reserved, consumed, and the invoiced share to date. */
  async requestsIn(month: string, tx: Tx = this.sql): Promise<CloseSnapshotFigures['requests']> {
    const rows = await tx<
      { id: string; number: number | null; title: string; cost_center: string; amount: string; consumed: string }[]
    >`
      SELECT r.id, r.number, r.title, r.cost_center, sum(s.amount_micros)::text AS amount,
             sum(s.consumed_micros)::text AS consumed
      FROM reservations s JOIN requests r ON r.id = s.request_id
      WHERE s.month = ${`${month}-01`}
      GROUP BY r.id, r.number, r.title, r.cost_center ORDER BY r.number`;
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      costCenter: r.cost_center,
      approved: amount(Money.ofMicros(r.amount, USD)),
      consumed: amount(Money.ofMicros(r.consumed, USD)),
      // Reservations consume estimated cost; the invoiced share is read on the request's lifecycle, to date.
      invoiced: amount(zero()),
    }));
  }

  /** Freezes the month's figures in `tx` (the accrual's acceptance); audited `close.snapshot_frozen`. */
  async freezeIn(
    tx: Tx,
    month: string,
    input: {
      accrual: CloseSnapshotFigures['accrual'];
      gates: CloseSnapshotFigures['gates'];
      by: { id: string; actor: string };
      accrualId: string;
    },
  ): Promise<{ id: string; sha256: string; version: number }> {
    const lines = await this.monthLines(month);
    const ledger = await this.ledgerFigures(month, lines);
    const figures: CloseSnapshotFigures = {
      ...ledger,
      requests: await this.requestsIn(month, tx),
      accrual: input.accrual,
      notes: await this.noteFigures(month, ledger, lines),
      gates: input.gates,
    };
    const hash = sha256(canonicalJson(figures));
    const [{ next }] = (await tx`
      SELECT coalesce(max(version), 0) + 1 AS next FROM close_snapshots WHERE month = ${`${month}-01`}`) as unknown as [
      { next: number },
    ];
    const id = newId('snap');
    await tx`
      INSERT INTO close_snapshots (id, month, version, figures, sha256, ledger_sha256, accrual_id, frozen_by)
      VALUES (${id}, ${`${month}-01`}, ${next}, ${tx.json(figures as never)}, ${hash}, ${Snapshots.ledgerSha(ledger)},
              ${input.accrualId}, ${input.by.id})`;
    await this.audit.append(
      {
        actor: input.by.actor,
        actorKind: 'person',
        action: 'close.snapshot_frozen',
        subjectType: 'period',
        subjectId: month,
        data: { snapshotId: id, version: Number(next), sha256: hash, ledgerSha256: Snapshots.ledgerSha(ledger) },
      },
      tx,
    );
    return { id, sha256: hash, version: Number(next) };
  }

  /** The month's newest snapshot, if any. */
  async latest(month: string, tx: Tx = this.sql): Promise<SnapRow | null> {
    const [r] = await tx<SnapRow[]>`
      SELECT s.*, u.email AS frozen_email FROM close_snapshots s LEFT JOIN users u ON u.id = s.frozen_by
      WHERE s.month = ${`${month}-01`} ORDER BY s.version DESC LIMIT 1`;
    return r ?? null;
  }

  async byId(id: string, tx: Tx = this.sql): Promise<SnapRow | null> {
    const [r] = await tx<SnapRow[]>`
      SELECT s.*, u.email AS frozen_email FROM close_snapshots s LEFT JOIN users u ON u.id = s.frozen_by
      WHERE s.id = ${id}`;
    return r ?? null;
  }

  /** Do the month's live figures still hash to this snapshot's ledger part? */
  async isCurrent(s: Pick<SnapRow, 'ledger_sha256' | 'month'>): Promise<boolean> {
    const month = dayOf(s.month).slice(0, 7);
    return Snapshots.ledgerSha(await this.ledgerFigures(month)) === s.ledger_sha256;
  }

  viewOf(s: SnapRow, current: boolean): CloseSnapshotView {
    return {
      id: s.id,
      month: dayOf(s.month).slice(0, 7),
      version: s.version,
      sha256: s.sha256,
      frozenBy: s.frozen_email ?? s.frozen_by,
      frozenAt: s.frozen_at.toISOString(),
      current,
      figures: s.figures,
    };
  }
}
