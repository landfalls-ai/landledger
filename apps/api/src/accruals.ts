/**
 * Accruals (wave 4, spec 013). At month-end Landledger proposes an accrual for what is known but not yet invoiced:
 * per AI provider, model and cost center, the estimates the read rule still shows (an invoice would have replaced
 * them); per contract, its value for the month when its vendor has no invoice for it. A controller accepts it as shown
 * (the proposal's sha256), which freezes the close snapshot. A line is reversed in the month its invoice posts, by the
 * same links that keep an estimate from counting beside its invoice, so nothing counts twice. Landledger never posts
 * to a GL: the journal entry is a CSV for the controller to book. Accruals are never cost records; no figure adds them.
 */
import type {
  AccrualLineView,
  AccrualsView,
  AccrualView,
  CloseSnapshotFigures,
  NotesDraftRequestedData,
} from '@landledger/contracts';
import { Money, REPORTING_CURRENCY } from '@landledger/money';
import type { AuditLog } from './audit.js';
import { canonicalJson } from './canonical.js';
import { day as dayOf, type Sql, type Tx } from './db.js';
import { ApiError, notFound } from './errors.js';
import { newId, sha256 } from './ids.js';
import { actorOf, type Principal } from './principal.js';
import { isNotional, type Snapshots } from './snapshot.js';
import { amount, ccLabel, type Line, plClassOf, type Spend } from './spend.js';
import type { Webhooks } from './webhooks.js';

const USD = REPORTING_CURRENCY;
const DAY_MS = 86_400_000;

export const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
export const nextMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const days = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** The journal's accounts: placeholders the controller maps to the chart of accounts. */
export const JE_ACCOUNTS = {
  liability: { code: 'LIAB-ACCRUED', name: 'Accrued liabilities: technology' },
  expense: (pl: string) => ({
    code: `EXP-${pl.toUpperCase().replace(/[^A-Z]/g, '-')}`,
    name: `Technology expense: ${
      {
        cost_of_revenue: 'cost of revenue',
        rnd: 'R&D',
        sm: 'sales and marketing',
        ga: 'G&A',
        shared: 'shared',
        unclassified: 'not classified',
      }[pl] ?? pl
    }`,
  }),
};

export interface DraftLine {
  kind: 'usage' | 'contract';
  provider: string;
  item: string;
  providerKey: string;
  costCenter: string;
  plClass: string;
  amount: Money;
  estimateKeys: string[];
  contractId: string | null;
}

/** Usage lines: the month's estimated AI lines the read rule still shows, per provider, model and cost center. */
export function usageLines(lines: readonly Line[], keyOf: (recordId: string) => string | undefined): DraftLine[] {
  const groups = new Map<string, DraftLine>();
  for (const l of lines) {
    if (l.basis !== 'estimated' || l.correction || l.provisional || isNotional(l)) continue;
    if (l.tags.resource !== 'ai') continue;
    const providerKey = (typeof l.tags.provider === 'string' && l.tags.provider) || l.providerName.toLowerCase();
    const model = (typeof l.tags.model === 'string' && l.tags.model) || l.serviceName;
    const pl = plClassOf(l);
    const k = `${providerKey}|${model}|${l.costCenter}|${pl}`;
    const g = groups.get(k) ?? {
      kind: 'usage' as const,
      provider: l.providerName,
      item: model,
      providerKey,
      costCenter: l.costCenter,
      plClass: pl,
      amount: Money.zero(USD),
      estimateKeys: [],
      contractId: null,
    };
    g.amount = g.amount.plus(l.amount);
    const key = keyOf(l.recordId);
    if (key && !g.estimateKeys.includes(key)) g.estimateKeys.push(key);
    groups.set(k, g);
  }
  return [...groups.values()]
    .filter((g) => !g.amount.posted().isZero())
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.item.localeCompare(b.item) ||
        a.costCenter.localeCompare(b.costCenter),
    );
}

/** The sha256 a controller accepts: the lines as proposed, canonical. */
export const linesSha = (month: string, lines: readonly DraftLine[]) =>
  sha256(
    canonicalJson({
      month,
      lines: lines.map((l, i) => ({
        line: i + 1,
        kind: l.kind,
        provider: l.provider,
        item: l.item,
        costCenter: l.costCenter,
        plClass: l.plClass,
        amount: amount(l.amount),
        estimateKeys: [...l.estimateKeys].sort(),
        contractId: l.contractId,
      })),
    }),
  );

type AccrualRow = {
  id: string;
  month: Date;
  version: number;
  sha256: string;
  total_micros: string;
  note: string;
  proposed_by: string;
  proposed_at: Date;
  proposer: string | null;
  outcome: 'accepted' | 'superseded' | null;
  decided_by: string | null;
  decider: string | null;
  decided_at: Date | null;
  snapshot_id: string | null;
  snapshot_sha: string | null;
};
type LineRow = {
  accrual_id: string;
  line: number;
  kind: 'usage' | 'contract';
  provider: string;
  item: string;
  provider_key: string;
  cost_center: string;
  pl_class: string;
  amount_micros: string;
  estimate_keys: string[];
  contract_id: string | null;
};

export interface StepGates {
  /** Steps 1–6 as they stand: each done or explained, else why not. */
  gates: (month: string) => Promise<{ ok: boolean; problems: string[]; gates: CloseSnapshotFigures['gates'] }>;
  /** open, closing, locked; and whether a locked month is reopened. */
  period: (month: string, tx?: Tx) => Promise<{ status: string; reopened: boolean }>;
}

export class Accruals {
  gates: StepGates | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly spend: Spend,
    private readonly snapshots: Snapshots,
    private readonly consoleUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async canAct(month: string, tx?: Tx) {
    if (this.now().getTime() < Date.parse(`${nextMonth(month)}-01T00:00:00Z`))
      throw new ApiError('conflict', `${month} hasn't ended yet: its accrual is proposed after the month is over`);
    const p = await this.gates!.period(month, tx);
    if (p.status === 'open') throw new ApiError('conflict', `Start ${month}'s close first (step 1 of Month-end)`);
    if (p.status === 'locked' && !p.reopened)
      throw new ApiError('conflict', `${month} is locked: its accrual is final (a reopen request lets it change)`);
  }

  /** Contract lines: each contract's value for the month when its vendor has no invoice for the month. */
  private async contractLines(month: string, lines: readonly Line[]): Promise<DraftLine[]> {
    const first = `${month}-01`;
    const last = monthEnd(month);
    const rows = await this.sql<
      {
        id: string;
        vendor: string;
        product: string;
        cost_center: string;
        tcv_micros: string;
        term_start: Date;
        term_end: Date;
        origin: string;
        invoiced: boolean;
      }[]
    >`
      SELECT c.*, EXISTS (
          SELECT 1 FROM invoices i
          WHERE lower(i.provider) = lower(c.vendor) AND i.month = ${first} AND i.origin <> 'dev-fixture'
            AND i.version = (SELECT max(version) FROM invoices j WHERE j.id = i.id) AND i.status = 'posted'
        ) AS invoiced
      FROM (SELECT DISTINCT ON (id) * FROM contract_versions ORDER BY id, version DESC) c
      WHERE c.origin <> 'dev-fixture' AND c.term_start <= ${last} AND c.term_end >= ${first}
      ORDER BY c.vendor, c.product`;
    const out: DraftLine[] = [];
    for (const c of rows) {
      if (c.invoiced) continue;
      const start = dayOf(c.term_start);
      const end = dayOf(c.term_end);
      const termDays = days(start, end) + 1;
      const from = start > first ? start : first;
      const to = end < last ? end : last;
      const inMonth = days(from, to) + 1;
      // The contract's value spread evenly over its days: exact to the micro-unit, half-even.
      const amt = Money.fromDecimal(
        Money.ofMicros(c.tcv_micros, USD).toDecimal().times(String(inMonth)).divide(String(termDays), 6, 'halfEven'),
        USD,
      );
      if (amt.posted().isZero()) continue;
      const mine = lines.filter((l) => l.costCenter === c.cost_center && !l.correction);
      const byPl = new Map<string, Money>();
      for (const l of mine) byPl.set(plClassOf(l), (byPl.get(plClassOf(l)) ?? Money.zero(USD)).plus(l.amount));
      const pl = [...byPl.entries()].sort((a, b) => b[1].compare(a[1]))[0]?.[0] ?? 'unclassified';
      out.push({
        kind: 'contract',
        provider: c.vendor,
        item: c.product,
        providerKey: c.vendor.toLowerCase(),
        costCenter: c.cost_center,
        plClass: pl,
        amount: amt,
        estimateKeys: [],
        contractId: c.id,
      });
    }
    return out;
  }

  /** The lines a proposal for `month` would hold now. */
  async draft(month: string): Promise<DraftLine[]> {
    const lines = await this.snapshots.monthLines(month);
    const ids = lines.filter((l) => l.basis === 'estimated' && l.tags.resource === 'ai').map((l) => l.recordId);
    const keys = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 5000) {
      const rows = await this.sql<{ record_id: string; source_key: string }[]>`
        SELECT record_id, source_key FROM cost_records WHERE record_id IN ${this.sql(ids.slice(i, i + 5000))}`;
      for (const r of rows) keys.set(r.record_id, r.source_key);
    }
    return [...usageLines(lines, (id) => keys.get(id)), ...(await this.contractLines(month, lines))];
  }

  async propose(month: string, note: string, by: Principal): Promise<AccrualView> {
    if (by.kind !== 'person')
      throw new ApiError('forbidden', 'A person signed in with Landbright proposes an accrual; an API key never does');
    if (!by.roles.some((r) => r === 'controller' || r === 'cfo' || r === 'fpa'))
      throw new ApiError('forbidden', 'Proposing an accrual is for a controller, the CFO or FP&A');
    await this.canAct(month);
    const lines = await this.draft(month);
    const hash = linesSha(month, lines);
    const id = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`accruals:${month}`}))`;
      const prev = await this.rowsOf(month, tx);
      const latest = prev[0];
      if (latest?.outcome === 'accepted') {
        const snap = latest.snapshot_id ? await this.snapshots.byId(latest.snapshot_id, tx) : null;
        if (snap && (await this.snapshots.isCurrent(snap)))
          throw new ApiError(
            'conflict',
            `${month}'s accrual v${latest.version} is accepted and its snapshot is current: nothing to propose again`,
          );
      }
      const version = (latest?.version ?? 0) + 1;
      const accrualId = newId('acr');
      const total = Money.sum(
        lines.map((l) => l.amount),
        USD,
      );
      await tx`
        INSERT INTO accruals (id, month, version, sha256, total_micros, note, proposed_by)
        VALUES (${accrualId}, ${`${month}-01`}, ${version}, ${hash}, ${total.micros.toString()}, ${note}, ${by.id})`;
      if (lines.length)
        await tx`INSERT INTO accrual_lines ${tx(
          lines.map((l, i) => ({
            accrual_id: accrualId,
            line: i + 1,
            kind: l.kind,
            provider: l.provider,
            item: l.item,
            provider_key: l.providerKey,
            cost_center: l.costCenter,
            pl_class: l.plClass,
            amount_micros: l.amount.micros.toString(),
            estimate_keys: l.estimateKeys,
            contract_id: l.contractId,
          })),
        )}`;
      for (const p of prev.filter((p) => p.outcome === null))
        await tx`
          INSERT INTO accrual_decisions (accrual_id, outcome, decided_by, note)
          VALUES (${p.id}, 'superseded', ${by.id}, ${`v${version} proposed`})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'accrual.proposed',
          subjectType: 'period',
          subjectId: month,
          data: { accrualId, version, lines: lines.length, total: amount(total), sha256: hash },
        },
        tx,
      );
      return accrualId;
    });
    return this.view(id);
  }

  async accept(id: string, input: { sha256: string; note: string }, by: Principal): Promise<AccrualView> {
    if (by.kind !== 'person')
      throw new ApiError('forbidden', 'A person signed in with Landbright accepts an accrual; an API key never does');
    if (!by.roles.includes('controller')) throw new ApiError('forbidden', 'A controller accepts the accrual');
    const [a] = await this.sql<AccrualRow[]>`${this.select()} WHERE a.id = ${id}`;
    if (!a) throw notFound('Accrual');
    const month = dayOf(a.month).slice(0, 7);
    await this.canAct(month);
    const g = await this.gates!.gates(month);
    if (!g.ok)
      throw new ApiError('conflict', `Steps 1–6 come first: ${g.problems.join('; ')}`, { problems: g.problems });
    const view = await this.view(id);
    const total = view.total;
    const result = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`accruals:${month}`}))`;
      const [latest] = await this.rowsOf(month, tx);
      if (!latest || latest.id !== id)
        throw new ApiError('conflict', `A newer proposal (v${latest?.version}) replaced this one: review it`);
      if (latest.outcome) throw new ApiError('conflict', `This proposal is ${latest.outcome} already`);
      if (latest.sha256 !== input.sha256)
        throw new ApiError('conflict', 'The proposal changed since it was shown; reopen it');
      const snap = await this.snapshots.freezeIn(tx, month, {
        accrual: { id, version: a.version, total, sha256: a.sha256 },
        gates: g.gates,
        by: { id: by.id, actor: actorOf(by).actor },
        accrualId: id,
      });
      await tx`
        INSERT INTO accrual_decisions (accrual_id, outcome, decided_by, note, snapshot_id)
        VALUES (${id}, 'accepted', ${by.id}, ${input.note}, ${snap.id})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'accrual.accepted',
          subjectType: 'period',
          subjectId: month,
          data: { accrualId: id, version: a.version, total, sha256: a.sha256, snapshotSha256: snap.sha256 },
        },
        tx,
      );
      await this.webhooks.enqueue(tx, 'accrual.accepted', {
        month,
        accrualId: id,
        total,
        snapshotSha256: snap.sha256,
        url: `${this.consoleUrl}/accruals?month=${month}`,
      });
      // Step 8 starts: Landflow's flow drafts the notes the snapshot needs (once per snapshot).
      const frozen = await this.snapshots.byId(snap.id, tx);
      await tx`INSERT INTO notes_requests (snapshot_id, month) VALUES (${snap.id}, ${`${month}-01`})`;
      const data: NotesDraftRequestedData = {
        month,
        snapshotSha256: snap.sha256,
        needed: frozen!.figures.notes,
        draftUrl: `/api/notes/${month}/drafts`,
        url: `${this.consoleUrl}/notes?month=${month}`,
      };
      await this.webhooks.enqueue(tx, 'notes.draft_requested', data as never);
      await this.audit.append(
        {
          actor: 'landledger',
          actorKind: 'system',
          action: 'notes.draft_requested',
          subjectType: 'period',
          subjectId: month,
          data: { snapshotSha256: snap.sha256, needed: frozen!.figures.notes.map((n) => n.costCenter) },
        },
        tx,
      );
      return snap;
    });
    void result;
    return this.view(id);
  }

  private select() {
    return this.sql`
      SELECT a.*, pu.email AS proposer, d.outcome, d.decided_by, du.email AS decider, d.decided_at, d.snapshot_id,
             s.sha256 AS snapshot_sha
      FROM accruals a
      LEFT JOIN users pu ON pu.id = a.proposed_by
      LEFT JOIN accrual_decisions d ON d.accrual_id = a.id
      LEFT JOIN users du ON du.id = d.decided_by
      LEFT JOIN close_snapshots s ON s.id = d.snapshot_id`;
  }

  private async rowsOf(month: string, tx: Tx = this.sql): Promise<AccrualRow[]> {
    return tx<AccrualRow[]>`
      SELECT a.*, pu.email AS proposer, d.outcome, d.decided_by, du.email AS decider, d.decided_at, d.snapshot_id,
             s.sha256 AS snapshot_sha
      FROM accruals a
      LEFT JOIN users pu ON pu.id = a.proposed_by
      LEFT JOIN accrual_decisions d ON d.accrual_id = a.id
      LEFT JOIN users du ON du.id = d.decided_by
      LEFT JOIN close_snapshots s ON s.id = d.snapshot_id
      WHERE a.month = ${`${month}-01`} ORDER BY a.version DESC`;
  }

  /** When and by which invoice a line was reversed: the first link on its estimates, or its vendor's invoice. */
  private async reversalOf(month: string, l: LineRow): Promise<AccrualLineView['reversal']> {
    if (l.kind === 'usage') {
      if (!l.estimate_keys.length) return null;
      const [r] = await this.sql<{ linked_at: Date; invoice_id: string | null }[]>`
        SELECT k.linked_at, c.invoice_id FROM invoice_estimate_links k
        JOIN cost_records c ON c.record_id = k.invoiced_record_id
        WHERE k.estimated_source_key IN ${this.sql(l.estimate_keys)}
        ORDER BY k.linked_at LIMIT 1`;
      return r
        ? {
            invoice: r.invoice_id ?? 'invoice',
            month: r.linked_at.toISOString().slice(0, 7),
            at: r.linked_at.toISOString(),
          }
        : null;
    }
    const [r] = await this.sql<{ number: string; imported_at: Date }[]>`
      SELECT number, imported_at FROM invoices i
      WHERE lower(provider) = ${l.provider_key} AND month = ${`${month}-01`} AND origin <> 'dev-fixture'
        AND status = 'posted' ORDER BY imported_at LIMIT 1`;
    return r
      ? { invoice: r.number, month: r.imported_at.toISOString().slice(0, 7), at: r.imported_at.toISOString() }
      : null;
  }

  async view(id: string): Promise<AccrualView> {
    const [a] = await this.sql<AccrualRow[]>`${this.select()} WHERE a.id = ${id}`;
    if (!a) throw notFound('Accrual');
    const month = dayOf(a.month).slice(0, 7);
    const rows = await this.sql<LineRow[]>`SELECT * FROM accrual_lines WHERE accrual_id = ${id} ORDER BY line`;
    const ccs = await this.spend.costCenters();
    const lines: AccrualLineView[] = [];
    for (const l of rows)
      lines.push({
        line: l.line,
        kind: l.kind,
        provider: l.provider,
        item: l.item,
        costCenter: l.cost_center,
        costCenterName: ccLabel(l.cost_center, ccs),
        plClass: l.pl_class,
        amount: amount(Money.ofMicros(l.amount_micros, USD)),
        estimates: l.estimate_keys.length,
        contractId: l.contract_id,
        basis: l.kind === 'usage' ? 'estimated (usage × rate card), not yet invoiced' : 'contract value ÷ term days',
        reversal: await this.reversalOf(month, l),
      });
    return {
      id: a.id,
      month,
      version: a.version,
      status: a.outcome ?? 'proposed',
      proposedBy: a.proposer ?? a.proposed_by,
      proposedAt: a.proposed_at.toISOString(),
      acceptedBy: a.outcome === 'accepted' ? (a.decider ?? a.decided_by) : null,
      acceptedAt: a.outcome === 'accepted' ? a.decided_at!.toISOString() : null,
      note: a.note,
      total: amount(Money.ofMicros(a.total_micros, USD)),
      lines,
      snapshotSha256: a.snapshot_sha,
      sha256: a.sha256,
    };
  }

  /** The month's accepted accrual, if any (the newest accepted version). */
  async accepted(month: string): Promise<AccrualView | null> {
    const row = (await this.rowsOf(month)).find((r) => r.outcome === 'accepted');
    return row ? this.view(row.id) : null;
  }

  async list(month: string): Promise<AccrualsView> {
    const rows = await this.rowsOf(month);
    const current = rows[0] ? await this.view(rows[0].id) : null;
    // Earlier months' accepted lines whose reversal is booked in this month.
    const earlier = await this.sql<{ id: string; month: Date }[]>`
      SELECT DISTINCT ON (a.month) a.id, a.month FROM accruals a JOIN accrual_decisions d ON d.accrual_id = a.id
      WHERE d.outcome = 'accepted' AND a.month < ${`${month}-01`} ORDER BY a.month, a.version DESC`;
    const reversalsIn: AccrualsView['reversalsIn'] = [];
    for (const e of earlier) {
      const v = await this.view(e.id);
      for (const l of v.lines)
        if (l.reversal?.month === month)
          reversalsIn.push({
            accrualId: v.id,
            month: v.month,
            line: l.line,
            amount: l.amount,
            invoice: l.reversal.invoice,
          });
    }
    return {
      month,
      current,
      history: rows.map((r) => ({
        id: r.id,
        version: r.version,
        status: r.outcome ?? 'proposed',
        proposedAt: r.proposed_at.toISOString(),
        proposedBy: r.proposer ?? r.proposed_by,
        total: amount(Money.ofMicros(r.total_micros, USD)),
      })),
      reversalsIn,
    };
  }

  /**
   * The journal entry for `month` (a CSV the controller books; Landledger never posts): the month's accepted accrual
   * (debit technology expense by P&L class and cost center, credit accrued liabilities) and the reversals booked in
   * the month of earlier accruals (the opposite entry). Every pair balances at the minor unit.
   */
  async journal(month: string): Promise<{ csv: string; rows: number; debits: string; credits: string }> {
    const head = [
      'journal_date',
      'entry',
      'line',
      'account',
      'account_name',
      'debit',
      'credit',
      'currency',
      'cost_center',
      'pl_class',
      'memo',
    ];
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const out: string[][] = [];
    let dr = Money.zero(USD);
    let cr = Money.zero(USD);
    const pair = (date: string, entry: string, l: AccrualLineView, reverse: boolean) => {
      const amt = Money.parse(l.amount, USD).posted();
      const exp = JE_ACCOUNTS.expense(l.plClass);
      const memo = `${reverse ? 'Reversal of ' : ''}${l.kind === 'usage' ? 'AI usage not yet invoiced' : 'Contract value not yet invoiced'}: ${l.provider} ${l.item}`;
      const debit = reverse ? JE_ACCOUNTS.liability : exp;
      const credit = reverse ? exp : JE_ACCOUNTS.liability;
      out.push([
        date,
        entry,
        String(l.line),
        debit.code,
        debit.name,
        amt.toCsv(),
        '',
        USD,
        l.costCenter,
        l.plClass,
        memo,
      ]);
      out.push([
        date,
        entry,
        String(l.line),
        credit.code,
        credit.name,
        '',
        amt.toCsv(),
        USD,
        l.costCenter,
        l.plClass,
        memo,
      ]);
      dr = dr.plus(amt);
      cr = cr.plus(amt);
    };
    const acc = await this.accepted(month);
    if (acc) for (const l of acc.lines) pair(monthEnd(month), `ACR-${month}-v${acc.version}`, l, false);
    const list = await this.list(month);
    for (const r of list.reversalsIn) {
      const v = await this.view(r.accrualId);
      const l = v.lines.find((x) => x.line === r.line)!;
      pair(l.reversal!.at.slice(0, 10), `REV-${v.month}-v${v.version}`, l, true);
    }
    const csv = [head, ...out].map((row) => row.map(esc).join(',')).join('\n') + '\n';
    return { csv, rows: out.length, debits: dr.toCsv(), credits: cr.toCsv() };
  }
}
