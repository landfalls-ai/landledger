/**
 * Accruals (wave 4, spec 013). At month-end Landledger proposes an accrual for what is known but not yet invoiced:
 * per AI provider, model and cost center, the estimates the read rule still shows (an invoice would have replaced
 * them); per contract billed monthly in arrears, its value for the month when its vendor has no invoice for it (net of
 * the vendor's own usage lines when the vendor is also an AI provider); per prepaid contract, its amortisation for the
 * month, reported apart (a prepaid expense, not an accrued liability). A controller accepts it as shown (the proposal's
 * sha256, derived again at acceptance), which freezes the close snapshot and the month's journal (journal.ts). A line
 * is reversed in the month its invoice posts, by live links to a posted invoice's head version only, so nothing counts
 * twice. Landledger never posts to a GL. Accruals are never cost records; no figure adds them.
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
import { localParts } from './business-hours.js';
import { actorOf, type Principal, refuseServiceLike } from './principal.js';
import type { Journal } from './journal.js';
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

export interface DraftLine {
  kind: 'usage' | 'contract' | 'prepaid';
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
  kind: 'usage' | 'contract' | 'prepaid';
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
  /** open, closing, locked; whether a locked month is reopened, and whether its round is started. */
  period: (month: string, tx?: Tx) => Promise<{ status: string; reopened: boolean; round: number; started: boolean }>;
}

/**
 * The value of a contract for the days through `day` (inclusive), half-even to the micro-unit. A month's value is the
 * difference of two of these, so the months of a term always sum back to the contract's value (review of wave 4, nit).
 */
export function valueThrough(tcv: Money, start: string, end: string, day: string): Money {
  const termDays = days(start, end) + 1;
  const through = day < start ? 0 : day >= end ? termDays : days(start, day) + 1;
  return Money.fromDecimal(tcv.toDecimal().times(String(through)).divide(String(termDays), 6, 'halfEven'), USD);
}
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

/** A posted invoice's head version: the newest version is posted (a void, or a re-import that voids, leaves none). */
const HEAD_POSTED = `i.status = 'posted' AND i.origin <> 'dev-fixture'
  AND i.version = (SELECT max(version) FROM invoices j WHERE j.id = i.id)`;

export class Accruals {
  gates: StepGates | null = null;
  journal: Journal | null = null;
  /** LANDLEDGER_TZ: a month ends, and a reversal is dated, in local time as invoices are (review of wave 4, nit). */
  timeZone = 'UTC';

  private localDay(at: Date | number) {
    return localParts(typeof at === 'number' ? at : at.getTime(), this.timeZone).date;
  }
  private reversalAt(invoice: string, at: Date): NonNullable<AccrualLineView['reversal']> {
    const day = this.localDay(at);
    return { invoice, month: day.slice(0, 7), at: at.toISOString(), day };
  }

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
    if (this.localDay(this.now()).slice(0, 7) <= month)
      throw new ApiError('conflict', `${month} hasn't ended yet: its accrual is proposed after the month is over`);
    const p = await this.gates!.period(month, tx);
    if (p.status === 'open') throw new ApiError('conflict', `Start ${month}'s close first (step 1 of Month-end)`);
    if (p.status === 'locked' && !p.reopened)
      throw new ApiError('conflict', `${month} is locked: its accrual is final (a reopen request lets it change)`);
    if (!p.started) throw new ApiError('conflict', `Start round ${p.round} of ${month}'s close first`);
  }

  /**
   * Contract lines (review of wave 4, should-fix 12, a default to confirm): by the contract's billing terms. Monthly
   * in arrears: the month's value when its vendor has no posted invoice for the month, net of the vendor's own usage
   * lines when the vendor is also an AI provider (never accrued twice). Prepaid annual: the month's amortisation, as a
   * `prepaid` line apart from the liability. Monthly in advance: invoiced before the month, so nothing.
   */
  private async contractLines(
    month: string,
    lines: readonly Line[],
    usage: readonly DraftLine[],
  ): Promise<DraftLine[]> {
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
        billing: string | null;
        invoiced: boolean;
      }[]
    >`
      SELECT c.*, EXISTS (
          SELECT 1 FROM invoices i
          WHERE lower(i.provider) = lower(c.vendor) AND i.month = ${first} AND ${this.sql.unsafe(HEAD_POSTED)}
        ) AS invoiced
      FROM (SELECT DISTINCT ON (id) * FROM contract_versions ORDER BY id, version DESC) c
      WHERE c.origin <> 'dev-fixture' AND c.term_start <= ${last} AND c.term_end >= ${first}
      ORDER BY c.vendor, c.product`;
    // The AI providers seen in the month (their usage is accrued by usage lines, or invoiced).
    const aiProviders = new Set(
      lines
        .filter((l) => l.tags.resource === 'ai')
        .flatMap((l) => [
          l.providerName.toLowerCase(),
          ...(typeof l.tags.provider === 'string' ? [l.tags.provider.toLowerCase()] : []),
        ]),
    );
    const out: DraftLine[] = [];
    for (const c of rows) {
      const billing = c.billing ?? 'monthly_in_arrears';
      if (billing === 'monthly_in_advance') continue;
      const start = dayOf(c.term_start);
      const end = dayOf(c.term_end);
      const tcv = Money.ofMicros(c.tcv_micros, USD);
      let amt = valueThrough(tcv, start, end, last).minus(valueThrough(tcv, start, end, dayBefore(first)));
      const vendor = c.vendor.toLowerCase();
      let kind: DraftLine['kind'] = 'prepaid';
      if (billing === 'monthly_in_arrears') {
        if (c.invoiced) continue;
        kind = 'contract';
        if (aiProviders.has(vendor)) {
          const accrued = Money.sum(
            usage.filter((u) => u.providerKey === vendor || u.provider.toLowerCase() === vendor).map((u) => u.amount),
            USD,
          );
          amt = amt.minus(accrued);
          if (amt.sign() < 0) amt = Money.zero(USD);
        }
      }
      if (amt.posted().isZero()) continue;
      const mine = lines.filter((l) => l.costCenter === c.cost_center && !l.correction);
      const byPl = new Map<string, Money>();
      for (const l of mine) byPl.set(plClassOf(l), (byPl.get(plClassOf(l)) ?? Money.zero(USD)).plus(l.amount));
      const pl = [...byPl.entries()].sort((a, b) => b[1].compare(a[1]))[0]?.[0] ?? 'unclassified';
      out.push({
        kind,
        provider: c.vendor,
        item: c.product,
        providerKey: vendor,
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
    const usage = usageLines(lines, (id) => keys.get(id));
    return [...usage, ...(await this.contractLines(month, lines, usage))];
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
      // The accrued liability: the prepaid amortisation is reported apart.
      const total = Money.sum(
        lines.filter((l) => l.kind !== 'prepaid').map((l) => l.amount),
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
    refuseServiceLike(by, 'accepts an accrual');
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
      // Review of wave 4, B2: the lines are derived again now. An invoice that replaced estimates since the proposal
      // (or a contract's change) makes it stale: accepting it would freeze an accrual for cost already invoiced.
      const now = linesSha(month, await this.draft(month));
      if (now !== latest.sha256)
        throw new ApiError(
          'conflict',
          `${month}'s accrual lines changed since v${latest.version} was proposed (an invoice or a contract moved them): propose it again`,
          { proposed: latest.sha256, now },
        );
      const snap = await this.snapshots.freezeIn(tx, month, {
        accrual: { id, version: a.version, total, sha256: a.sha256 },
        gates: g.gates,
        by: { id: by.id, actor: actorOf(by).actor },
        accrualId: id,
      });
      await tx`
        INSERT INTO accrual_decisions (accrual_id, outcome, decided_by, note, snapshot_id)
        VALUES (${id}, 'accepted', ${by.id}, ${input.note}, ${snap.id})`;
      // Should-fix 11: the month's journal is frozen with the acceptance (entry ids, the mapping in force).
      const entries = await this.journal!.freezeIn(tx, month, view, by);
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'accrual.accepted',
          subjectType: 'period',
          subjectId: month,
          data: {
            accrualId: id,
            version: a.version,
            total,
            sha256: a.sha256,
            snapshotSha256: snap.sha256,
            journalEntries: entries,
          },
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

  /**
   * When and by which invoice a line was reversed (review of wave 4, should-fix 10): a usage line by the first link on
   * its estimates to an invoiced entry still live, of an invoice whose head version is posted; a contract line by its
   * vendor's invoice for the month whose head version is posted (dated when that posting began). A voided invoice
   * reverses nothing. A prepaid line is never reversed: it is amortisation, not a liability.
   */
  private async reversalOf(month: string, l: LineRow): Promise<AccrualLineView['reversal']> {
    if (l.kind === 'prepaid') return null;
    if (l.kind === 'usage') {
      if (!l.estimate_keys.length) return null;
      // An invoice's records carry its number, not its id: they are found by their key's prefix (invoices.ts).
      // Dated, as a contract line is, by the earliest posting of that invoice after its last void.
      const [r] = await this.sql<{ posted_at: Date; number: string }[]>`
        SELECT i.number, (SELECT min(p.imported_at) FROM invoices p WHERE p.id = i.id AND p.version > coalesce(
                  (SELECT max(v.version) FROM invoices v WHERE v.id = i.id AND v.status = 'voided'), 0)) AS posted_at
        FROM invoice_estimate_links k
        JOIN cost_record_keys y ON y.record_id = k.invoiced_record_id
        JOIN invoices i ON starts_with(y.source_key, 'invoice:' || lower(i.provider) || ':' || i.number || ':')
        WHERE k.estimated_source_key IN ${this.sql(l.estimate_keys)}
          AND ${this.sql.unsafe(HEAD_POSTED)}
          AND EXISTS (SELECT 1 FROM cost_record_keys z WHERE z.source_key = y.source_key AND z.basis = 'invoiced'
                        AND NOT z.is_reversal
                        AND NOT EXISTS (SELECT 1 FROM cost_record_keys x WHERE x.correction_of_id = z.record_id))
        ORDER BY posted_at LIMIT 1`;
      return r ? this.reversalAt(r.number, r.posted_at) : null;
    }
    const [r] = await this.sql<{ number: string; posted_at: Date }[]>`
      SELECT i.number, (SELECT min(p.imported_at) FROM invoices p WHERE p.id = i.id AND p.version > coalesce(
                (SELECT max(v.version) FROM invoices v WHERE v.id = i.id AND v.status = 'voided'), 0)) AS posted_at
      FROM invoices i
      WHERE lower(i.provider) = ${l.provider_key} AND i.month = ${`${month}-01`} AND ${this.sql.unsafe(HEAD_POSTED)}
      ORDER BY posted_at LIMIT 1`;
    return r ? this.reversalAt(r.number, r.posted_at) : null;
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
        basis:
          l.kind === 'usage'
            ? 'estimated (usage × rate card), not yet invoiced'
            : l.kind === 'prepaid'
              ? 'prepaid contract: its value over the term days, amortised (not a liability)'
              : 'contract billed monthly in arrears: its value over the term days, not yet invoiced',
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
      prepaidTotal: amount(
        Money.sum(
          rows.filter((l) => l.kind === 'prepaid').map((l) => Money.ofMicros(l.amount_micros, USD)),
          USD,
        ),
      ),
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

  /** Every accepted version of the month, oldest first (the journal reverses the ones a later version replaced). */
  async acceptedVersions(month: string): Promise<AccrualView[]> {
    const rows = (await this.rowsOf(month)).filter((r) => r.outcome === 'accepted').reverse();
    return Promise.all(rows.map((r) => this.view(r.id)));
  }

  /** Each earlier month's newest accepted version: the lines a reversal in or after `month` may reverse. */
  async effectiveBefore(month: string): Promise<AccrualView[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT DISTINCT ON (a.month) a.id FROM accruals a JOIN accrual_decisions d ON d.accrual_id = a.id
      WHERE d.outcome = 'accepted' AND a.month < ${`${month}-01`} ORDER BY a.month, a.version DESC`;
    return Promise.all(rows.map((r) => this.view(r.id)));
  }

  async list(month: string): Promise<AccrualsView> {
    const rows = await this.rowsOf(month);
    const current = rows[0] ? await this.view(rows[0].id) : null;
    // Earlier months' accepted lines whose reversal is booked in this month.
    const reversalsIn: AccrualsView['reversalsIn'] = [];
    for (const v of await this.effectiveBefore(month)) {
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
}
