/**
 * The journal and the chart-of-accounts mapping (review of wave 4, should-fix 11 and "what a controller or auditor
 * would still ask for"). Landledger never posts to a GL: it hands the controller a journal to book. Accepting a month's
 * accrual freezes that month's journal in `journal_lines`, with entry ids, the placeholder account and the general
 * ledger's account by the mapping version in force, at the minor unit:
 *
 * - `supersede`: an earlier accepted version of the same month, reversed by its own entry before the new one, so a
 *   controller who booked it gets the reversing entry;
 * - `accrual`: the accepted version's usage and contract lines (debit technology expense, credit accrued liabilities);
 * - `prepaid`: prepaid contracts' amortisation for the month (debit expense, credit prepaid expenses), apart from the
 *   liability;
 * - `reversal`: earlier months' accrual lines whose invoices posted in or before this month and that no frozen entry
 *   reversed yet (debit accrued liabilities, credit expense), each dated the day its invoice posted.
 *
 * Each entry's lines are rounded to the cent by largest remainder, so an entry totals the accepted total posted. The
 * mapping is a versioned table; a controller proposes a new version, decided as a `coa_mapping_change` request. The
 * roll-forward of the accrued liability (opening, additions, reversals, closing, and aging) reads the journal.
 */
import type {
  AccrualLineView,
  AccrualRollForward,
  AccrualView,
  CoaMappingProposeInput,
  CoaMappingsView,
  CoaMappingView,
  JournalLineView,
  JournalView,
} from '@landledger/contracts';
import { Money, REPORTING_CURRENCY } from '@landledger/money';
import { monthEnd } from './accruals.js';
import type { AuditLog } from './audit.js';
import { canonicalJson } from './canonical.js';
import { day as dayOf, type Sql, type Tx } from './db.js';
import { ApiError } from './errors.js';
import { type Cell, csvCell } from './export.js';
import { newId, sha256 } from './ids.js';
import { actorOf, type Principal, refuseServiceLike } from './principal.js';
import { amount } from './spend.js';

const USD = REPORTING_CURRENCY;
const zero = () => Money.zero(USD);

/** The journal's placeholder accounts; the mapping names the general ledger's account for each. */
export const ACCOUNTS = {
  liability: { code: 'LIAB-ACCRUED', name: 'Accrued liabilities: technology' },
  prepaid: { code: 'ASSET-PREPAID', name: 'Prepaid expenses: technology' },
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
export const PL_CLASSES = ['cost_of_revenue', 'rnd', 'sm', 'ga', 'shared', 'unclassified'];
export const ALL_ACCOUNTS = [
  ACCOUNTS.liability.code,
  ACCOUNTS.prepaid.code,
  ...PL_CLASSES.map((p) => ACCOUNTS.expense(p).code),
];

const monthsBetween = (a: string, b: string) => {
  const [ya, ma] = a.split('-').map(Number) as [number, number];
  const [yb, mb] = b.split('-').map(Number) as [number, number];
  return (yb - ya) * 12 + (mb - ma);
};

/**
 * Rounds amounts to the cent so they total the posted total exactly (largest remainder, half away from zero for the
 * total). Non-negative amounts; a negative one is posted on its own.
 */
export function postToCents(amounts: readonly Money[]): Money[] {
  if (amounts.some((a) => a.sign() < 0)) return amounts.map((a) => a.posted());
  const total = Money.sum(amounts, USD).posted();
  const unit = 10_000n;
  const floors = amounts.map((a) => (a.micros / unit) * unit);
  let left = (total.micros - floors.reduce((s, f) => s + f, 0n)) / unit;
  const order = amounts
    .map((a, i) => ({ i, r: a.micros % unit }))
    .sort((x, y) => (y.r > x.r ? 1 : y.r < x.r ? -1 : x.i - y.i));
  const out = [...floors];
  for (const { i } of order) {
    if (left <= 0n) break;
    out[i] = out[i]! + unit;
    left--;
  }
  return out.map((m) => Money.ofMicros(m, USD));
}

/** One line of an entry before it is numbered and mapped. */
export interface DraftJournalLine {
  kind: JournalLineView['kind'];
  journalDate: string;
  accrualId: string;
  accrualLine: number;
  accrualMonth: string;
  account: string;
  accountName: string;
  debit: Money;
  credit: Money;
  costCenter: string;
  plClass: string;
  memo: string;
}

/** An accepted accrual version as entries: its accrual (or supersede) entry, and its prepaid amortisation. */
export function accrualEntries(
  a: AccrualView,
  kind: 'accrual' | 'supersede',
  prefix = '',
  omit: ReadonlySet<number> = new Set(),
): DraftJournalLine[][] {
  const date = monthEnd(a.month);
  const entries: DraftJournalLine[][] = [];
  for (const group of [a.lines.filter((l) => l.kind !== 'prepaid'), a.lines.filter((l) => l.kind === 'prepaid')]) {
    if (!group.length) continue;
    const cents = postToCents(group.map((l) => Money.parse(l.amount, USD)));
    const out: DraftJournalLine[] = [];
    group.forEach((l, i) => {
      const amt = cents[i]!;
      if (amt.isZero() || omit.has(l.line)) return;
      const prepaid = l.kind === 'prepaid';
      const exp = ACCOUNTS.expense(l.plClass);
      const other = prepaid ? ACCOUNTS.prepaid : ACCOUNTS.liability;
      const what = prepaid
        ? 'Prepaid contract amortised'
        : l.kind === 'usage'
          ? 'AI usage not yet invoiced'
          : 'Contract value not yet invoiced';
      const memo = `${prefix}${kind === 'supersede' ? `Reversal of ${a.month} v${a.version} (replaced by a later version): ` : ''}${what}: ${l.provider} ${l.item}`;
      const base = {
        kind: kind === 'supersede' ? ('supersede' as const) : prepaid ? ('prepaid' as const) : ('accrual' as const),
        journalDate: date,
        accrualId: a.id,
        accrualLine: l.line,
        accrualMonth: a.month,
        costCenter: l.costCenter,
        plClass: l.plClass,
        memo,
      };
      const [dr, cr] = kind === 'supersede' ? [other, exp] : [exp, other];
      out.push({ ...base, account: dr.code, accountName: dr.name, debit: amt, credit: zero() });
      out.push({ ...base, account: cr.code, accountName: cr.name, debit: zero(), credit: amt });
    });
    if (out.length) entries.push(out);
  }
  return entries;
}

/** The reversal of earlier accrual lines (one entry per accepted version), dated the day each line's invoice posted. */
export function reversalEntries(
  a: AccrualView,
  lines: readonly AccrualLineView[],
  posted: ReadonlyMap<number, Money>,
): DraftJournalLine[] {
  const out: DraftJournalLine[] = [];
  for (const l of lines) {
    const amt = posted.get(l.line) ?? Money.parse(l.amount, USD).posted();
    if (amt.isZero() || !l.reversal) continue;
    const exp = ACCOUNTS.expense(l.plClass);
    const memo = `Reversal of ${a.month} v${a.version} line ${l.line}: ${l.provider} ${l.item}, invoice ${l.reversal.invoice}`;
    const base = {
      kind: 'reversal' as const,
      journalDate: l.reversal.day ?? l.reversal.at.slice(0, 10),
      accrualId: a.id,
      accrualLine: l.line,
      accrualMonth: a.month,
      costCenter: l.costCenter,
      plClass: l.plClass,
      memo,
    };
    out.push({
      ...base,
      account: ACCOUNTS.liability.code,
      accountName: ACCOUNTS.liability.name,
      debit: amt,
      credit: zero(),
    });
    out.push({ ...base, account: exp.code, accountName: exp.name, debit: zero(), credit: amt });
  }
  return out;
}

type JournalRow = {
  entry_id: string;
  line: number;
  month: Date;
  journal_date: Date;
  kind: JournalLineView['kind'];
  accrual_id: string | null;
  accrual_line: number | null;
  accrual_month: Date | null;
  account: string;
  account_name: string;
  gl_account: string;
  gl_name: string;
  coa_version: number;
  debit_micros: string;
  credit_micros: string;
  cost_center: string;
  pl_class: string;
  memo: string;
  frozen_by: string;
  frozen_email?: string | null;
  frozen_at: Date;
};
type CoaRow = {
  id: string;
  version: number;
  mapping: Record<string, { gl: string; name: string }>;
  sha256: string;
  note: string;
  proposed_by: string;
  proposer: string | null;
  proposed_at: Date;
  outcome: 'approved' | 'rejected' | null;
  decided_by: string | null;
  decider: string | null;
  decided_at: Date | null;
  request_id: string | null;
  request_status: string | null;
};

/** What the journal needs from the accruals: each month's accepted versions and a line's reversal as it stands. */
export interface AccrualSource {
  acceptedVersions(month: string): Promise<AccrualView[]>;
  /** Every month's newest accepted version before `month`. */
  effectiveBefore(month: string): Promise<AccrualView[]>;
}

/** How a proposal raises its request (Requests.raiseChange and submitById, bound by the services). */
export type RaiseCoaRequest = (
  tx: Tx,
  input: { versionId: string; version: number; mapping: CoaMappingView['mapping']; note: string },
  by: Principal,
) => Promise<string>;

export class Journal {
  source: AccrualSource | null = null;
  raise: RaiseCoaRequest | null = null;
  submit: ((id: string, by: Principal) => Promise<void>) | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // The chart-of-accounts mapping -------------------------------------------------------------------------------------

  private async coaRows(tx: Tx = this.sql): Promise<CoaRow[]> {
    return tx<CoaRow[]>`
      SELECT v.*, pu.email AS proposer, d.outcome, d.decided_by, du.email AS decider, d.decided_at,
             coalesce(d.request_id, (SELECT r.id FROM requests r WHERE r.change->>'versionId' = v.id
                                     AND r.kind = 'coa_mapping_change' ORDER BY r.created_at DESC LIMIT 1)) AS request_id,
             (SELECT r.status FROM requests r WHERE r.change->>'versionId' = v.id AND r.kind = 'coa_mapping_change'
              ORDER BY r.created_at DESC LIMIT 1) AS request_status
      FROM coa_mapping_versions v
      LEFT JOIN users pu ON pu.id = v.proposed_by
      LEFT JOIN coa_mapping_decisions d ON d.version_id = v.id
      LEFT JOIN users du ON du.id = d.decided_by
      ORDER BY v.version DESC`;
  }

  private coaView(r: CoaRow): CoaMappingView {
    const status =
      r.outcome === 'approved'
        ? 'approved'
        : r.outcome === 'rejected' || ['rejected', 'cancelled', 'expired'].includes(r.request_status ?? '')
          ? 'rejected'
          : 'proposed';
    return {
      id: r.id,
      version: r.version,
      status,
      mapping: r.mapping,
      sha256: r.sha256,
      note: r.note,
      proposedBy: r.proposer ?? r.proposed_by,
      proposedAt: r.proposed_at.toISOString(),
      decidedBy: r.decider ?? r.decided_by,
      decidedAt: r.decided_at?.toISOString() ?? null,
      requestId: r.request_id,
    };
  }

  /** The mapping in force: the newest approved version. */
  async mapping(tx: Tx = this.sql): Promise<CoaMappingView> {
    const rows = await this.coaRows(tx);
    const r = rows.find((x) => x.outcome === 'approved');
    if (!r) throw new ApiError('conflict', 'No chart-of-accounts mapping is approved');
    return this.coaView(r);
  }

  async coa(): Promise<CoaMappingsView> {
    const rows = await this.coaRows();
    return {
      current: await this.mapping(),
      versions: rows.map((r) => this.coaView(r)),
      accounts: ALL_ACCOUNTS,
    };
  }

  /** A controller proposes a new mapping; it is decided as a `coa_mapping_change` request, never by its proposer. */
  async propose(input: CoaMappingProposeInput, by: Principal): Promise<{ version: CoaMappingView; requestId: string }> {
    if (by.kind !== 'person')
      throw new ApiError('forbidden', 'A person signed in with Landbright proposes a mapping; an API key never does');
    if (!by.roles.includes('controller')) throw new ApiError('forbidden', 'A controller proposes a mapping');
    refuseServiceLike(by, 'proposes a mapping');
    const missing = ALL_ACCOUNTS.filter((a) => !input.mapping[a]);
    if (missing.length)
      throw new ApiError('bad_request', `The mapping names every account the journal uses: ${missing.join(', ')}`, {
        missing,
      });
    const unknown = Object.keys(input.mapping).filter((a) => !ALL_ACCOUNTS.includes(a));
    if (unknown.length) throw new ApiError('bad_request', `No such account in the journal: ${unknown.join(', ')}`);
    const mapping = Object.fromEntries(Object.entries(input.mapping).sort(([a], [b]) => a.localeCompare(b)));
    const { id, requestId } = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('coa_mapping'))`;
      const pending = (await this.coaRows(tx)).find((r) => this.coaView(r).status === 'proposed');
      if (pending)
        throw new ApiError('conflict', `Mapping v${pending.version} is waiting for a decision already`, {
          requestId: pending.request_id,
        });
      const [{ next }] = (await tx`
        SELECT coalesce(max(version), 0) + 1 AS next FROM coa_mapping_versions`) as unknown as [{ next: number }];
      const id = newId('coa');
      const sha = sha256(canonicalJson(mapping));
      await tx`
        INSERT INTO coa_mapping_versions (id, version, mapping, sha256, note, proposed_by)
        VALUES (${id}, ${Number(next)}, ${tx.json(mapping as never)}, ${sha}, ${input.note}, ${by.id})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'coa.mapping_proposed',
          subjectType: 'coa_mapping',
          subjectId: id,
          data: { version: Number(next), sha256: sha },
        },
        tx,
      );
      const requestId = await this.raise!(tx, { versionId: id, version: Number(next), mapping, note: input.note }, by);
      return { id, requestId };
    });
    await this.submit!(requestId, by);
    const rows = await this.coaRows();
    return { version: this.coaView(rows.find((r) => r.id === id)!), requestId };
  }

  // The frozen journal ------------------------------------------------------------------------------------------------

  private async rowsOf(month: string, tx: Tx = this.sql): Promise<JournalRow[]> {
    return tx<JournalRow[]>`
      SELECT j.*, u.email AS frozen_email FROM journal_lines j LEFT JOIN users u ON u.id = j.frozen_by
      WHERE j.month = ${`${month}-01`} ORDER BY j.entry_id, j.line`;
  }

  /** The entries accepting `accepted` would freeze for its month now (nothing frozen twice). */
  async pending(month: string, accepted: AccrualView | null, tx: Tx = this.sql): Promise<DraftJournalLine[][]> {
    const frozen = await tx<{ accrual_id: string; accrual_line: number | null; kind: string }[]>`
      SELECT DISTINCT accrual_id, accrual_line, kind FROM journal_lines WHERE accrual_id IS NOT NULL`;
    const has = (id: string, kind: string, line?: number) =>
      frozen.some((f) => f.accrual_id === id && f.kind === kind && (line === undefined || f.accrual_line === line));
    const entries: DraftJournalLine[][] = [];
    const versions = await this.source!.acceptedVersions(month);
    const booked = (id: string) => has(id, 'accrual') || has(id, 'prepaid');
    const lineBooked = (id: string, line: number) => has(id, 'accrual', line) || has(id, 'prepaid', line);
    // A line's identity across versions of one month.
    const idOf = (l: AccrualLineView) => `${l.kind}|${l.provider}|${l.item}|${l.costCenter}`;
    // Lines carried as booked: a line a later month's frozen journal reversed already (a month reopened after the next
    // froze its reversals) holds nothing to supersede, and a later version's same line is not accrued again; that
    // invoice settled it. Its cents stay as the accrual posted them.
    const carried = new Set<string>();
    // Earlier accepted versions of this month not reversed yet: each gets its reversing entry. One accepted before the
    // journal was frozen (before the review of wave 4) was booked from the CSV: its entry is frozen first, as booked.
    for (const v of [...versions].sort((a, b) => a.version - b.version)) {
      if (v.id === accepted?.id) continue;
      const backfill = !booked(v.id);
      const omit = new Set(
        v.lines
          .filter((l) => has(v.id, 'reversal', l.line) || (!backfill && !lineBooked(v.id, l.line)))
          .map((l) => l.line),
      );
      for (const l of v.lines) if (omit.has(l.line)) carried.add(idOf(l));
      if (has(v.id, 'supersede')) continue;
      if (backfill)
        entries.push(
          ...accrualEntries(v, 'accrual', 'Accepted before the journal was frozen, as booked from its CSV: '),
        );
      entries.push(...accrualEntries(v, 'supersede', '', omit));
    }
    if (accepted && !booked(accepted.id))
      entries.push(
        ...accrualEntries(
          accepted,
          'accrual',
          '',
          new Set(accepted.lines.filter((l) => carried.has(idOf(l))).map((l) => l.line)),
        ),
      );
    // Reversals booked in or before this month of earlier months' effective versions, not frozen yet.
    const until = monthEnd(month);
    for (const v of await this.source!.effectiveBefore(month)) {
      const accrued = v.lines.filter((l) => l.kind !== 'prepaid');
      const cents = postToCents(accrued.map((l) => Money.parse(l.amount, USD)));
      const posted = new Map(accrued.map((l, i) => [l.line, cents[i]!]));
      // Only a line whose accrual is in the frozen journal is reversed here (a version accepted before the journal was
      // frozen was reversed from its CSV; a carried line was reversed as its first version's).
      const due = accrued.filter(
        (l) =>
          l.reversal &&
          (l.reversal.day ?? l.reversal.at.slice(0, 10)) <= until &&
          has(v.id, 'accrual', l.line) &&
          !has(v.id, 'reversal', l.line),
      );
      if (due.length) entries.push(reversalEntries(v, due, posted));
    }
    return entries.filter((e) => e.length);
  }

  /** Freezes `month`'s journal in the accrual's accepting transaction. Returns the entry ids. */
  async freezeIn(tx: Tx, month: string, accepted: AccrualView, by: Principal): Promise<string[]> {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`journal:${month}`}))`;
    const entries = await this.pending(month, accepted, tx);
    if (!entries.length) return [];
    const coa = await this.mapping(tx);
    const [{ n }] = (await tx`
      SELECT count(DISTINCT entry_id)::int AS n FROM journal_lines WHERE month = ${`${month}-01`}`) as unknown as [
      { n: number },
    ];
    const ids: string[] = [];
    const rows: Record<string, unknown>[] = [];
    entries.forEach((e, k) => {
      const entryId = `JE-${month}-${String(Number(n) + k + 1).padStart(4, '0')}`;
      ids.push(entryId);
      e.forEach((l, i) => {
        const gl = coa.mapping[l.account];
        rows.push({
          entry_id: entryId,
          line: i + 1,
          month: `${month}-01`,
          journal_date: l.journalDate,
          kind: l.kind,
          accrual_id: l.accrualId,
          accrual_line: l.accrualLine,
          accrual_month: `${l.accrualMonth}-01`,
          account: l.account,
          account_name: l.accountName,
          gl_account: gl?.gl ?? l.account,
          gl_name: gl?.name ?? '(not mapped)',
          coa_version: coa.version,
          debit_micros: l.debit.micros.toString(),
          credit_micros: l.credit.micros.toString(),
          currency: USD,
          cost_center: l.costCenter,
          pl_class: l.plClass,
          memo: l.memo,
          frozen_by: by.id,
        });
      });
    });
    await tx`INSERT INTO journal_lines ${tx(rows)}`;
    await this.audit.append(
      {
        ...actorOf(by),
        action: 'journal.frozen',
        subjectType: 'period',
        subjectId: month,
        data: {
          entries: ids,
          lines: rows.length,
          coaVersion: coa.version,
          sha256: sha256(canonicalJson(rows.map(({ frozen_by: _by, ...r }) => r))),
        },
      },
      tx,
    );
    return ids;
  }

  private lineView(r: JournalRow): JournalLineView {
    return {
      entryId: r.entry_id,
      line: r.line,
      journalDate: dayOf(r.journal_date),
      kind: r.kind,
      account: r.account,
      accountName: r.account_name,
      glAccount: r.gl_account,
      glName: r.gl_name,
      debit: amount(Money.ofMicros(r.debit_micros, USD)),
      credit: amount(Money.ofMicros(r.credit_micros, USD)),
      currency: 'USD',
      costCenter: r.cost_center,
      plClass: r.pl_class,
      memo: r.memo,
      accrualId: r.accrual_id,
      accrualLine: r.accrual_line,
    };
  }

  /** The month's journal: frozen if its accrual was accepted, else what accepting it would freeze now. */
  async view(month: string, preview: AccrualView | null = null): Promise<JournalView> {
    const rows = await this.rowsOf(month);
    const coa = await this.mapping();
    let lines: JournalLineView[];
    if (rows.length) lines = rows.map((r) => this.lineView(r));
    else {
      const entries = await this.pending(month, preview);
      lines = entries.flatMap((e, k) =>
        e.map((l, i) => ({
          entryId: `JE-${month}-draft-${k + 1}`,
          line: i + 1,
          journalDate: l.journalDate,
          kind: l.kind,
          account: l.account,
          accountName: l.accountName,
          glAccount: coa.mapping[l.account]?.gl ?? l.account,
          glName: coa.mapping[l.account]?.name ?? '(not mapped)',
          debit: amount(l.debit),
          credit: amount(l.credit),
          currency: 'USD' as const,
          costCenter: l.costCenter,
          plClass: l.plClass,
          memo: l.memo,
          accrualId: l.accrualId,
          accrualLine: l.accrualLine,
        })),
      );
    }
    const sum = (k: 'debit' | 'credit') =>
      amount(
        Money.sum(
          lines.map((l) => Money.parse(l[k], USD)),
          USD,
        ),
      );
    const last = rows.at(-1);
    return {
      month,
      frozen: rows.length > 0,
      frozenAt: last
        ? rows
            .map((r) => r.frozen_at)
            .sort((a, b) => b.getTime() - a.getTime())[0]!
            .toISOString()
        : null,
      frozenBy: last ? (last.frozen_email ?? last.frozen_by) : null,
      coaVersion: rows[0]?.coa_version ?? coa.version,
      lines,
      debits: sum('debit'),
      credits: sum('credit'),
    };
  }

  /** The journal as the CSV the controller books: entry ids, placeholder and GL accounts, at the cent. */
  async csv(month: string, preview: AccrualView | null = null): Promise<{ csv: string; view: JournalView }> {
    const v = await this.view(month, preview);
    const head = [
      'entry_id',
      'line',
      'journal_date',
      'kind',
      'gl_account',
      'gl_name',
      'account',
      'account_name',
      'debit',
      'credit',
      'currency',
      'cost_center',
      'pl_class',
      'memo',
      'frozen',
      'coa_version',
    ];
    const cell = (a: string): Cell => (Money.parse(a, USD).isZero() ? '' : { number: Money.parse(a, USD).toCsv() });
    const rows: Cell[][] = v.lines.map((l) => [
      l.entryId,
      String(l.line),
      l.journalDate,
      l.kind,
      l.glAccount,
      l.glName,
      l.account,
      l.accountName,
      cell(l.debit),
      cell(l.credit),
      l.currency,
      l.costCenter,
      l.plClass,
      l.memo,
      String(v.frozen),
      String(v.coaVersion),
    ]);
    return { csv: [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n', view: v };
  }

  // The roll-forward --------------------------------------------------------------------------------------------------

  /** The accrued liability through `month`: opening, additions, supersedes, reversals, closing, and aging. */
  async rollForward(month: string, preview: AccrualView | null = null): Promise<AccrualRollForward> {
    const frozenRows = await this.sql<JournalRow[]>`
      SELECT * FROM journal_lines WHERE month <= ${`${month}-01`} ORDER BY month, entry_id, line`;
    const thisFrozen = frozenRows.some((r) => dayOf(r.month).slice(0, 7) === month);
    type L = { month: string; kind: string; account: string; debit: Money; credit: Money; key: string | null };
    const lines: L[] = frozenRows.map((r) => ({
      month: dayOf(r.month).slice(0, 7),
      kind: r.kind,
      account: r.account,
      debit: Money.ofMicros(r.debit_micros, USD),
      credit: Money.ofMicros(r.credit_micros, USD),
      key: r.accrual_id ? `${r.accrual_id}#${r.accrual_line}` : null,
    }));
    if (!thisFrozen)
      for (const e of await this.pending(month, preview))
        for (const l of e)
          lines.push({
            month,
            kind: l.kind,
            account: l.account,
            debit: l.debit,
            credit: l.credit,
            key: `${l.accrualId}#${l.accrualLine}`,
          });
    const liab = lines.filter((l) => l.account === ACCOUNTS.liability.code);
    const net = (ls: L[]) =>
      Money.sum(
        ls.map((l) => l.credit.minus(l.debit)),
        USD,
      );
    const opening = net(liab.filter((l) => l.month < month));
    const mine = liab.filter((l) => l.month === month);
    const additions = net(mine.filter((l) => l.kind === 'accrual'));
    const superseded = net(mine.filter((l) => l.kind === 'supersede')).negate();
    const reversals = net(mine.filter((l) => l.kind === 'reversal')).negate();
    const closing = opening.plus(additions).minus(superseded).minus(reversals);
    // Aging: what each accrued line still holds, by the month it was accrued in.
    const byKey = new Map<string, Money>();
    for (const l of liab) if (l.key) byKey.set(l.key, (byKey.get(l.key) ?? zero()).plus(l.credit.minus(l.debit)));
    const openKeys = [...byKey.entries()].filter(([, m]) => !m.isZero());
    const meta = openKeys.length
      ? await this.sql<
          {
            accrual_id: string;
            line: number;
            month: Date;
            provider: string;
            item: string;
            cost_center: string;
          }[]
        >`
          SELECT l.accrual_id, l.line, a.month, l.provider, l.item, l.cost_center
          FROM accrual_lines l JOIN accruals a ON a.id = l.accrual_id
          WHERE l.accrual_id IN ${this.sql([...new Set(openKeys.map(([k]) => k.split('#')[0]!))])}`
      : [];
    const open: AccrualRollForward['open'] = openKeys
      .map(([k, m]) => {
        const [id, line] = k.split('#') as [string, string];
        const r = meta.find((x) => x.accrual_id === id && x.line === Number(line));
        const accrualMonth = r ? dayOf(r.month).slice(0, 7) : month;
        return {
          accrualMonth,
          accrualId: id,
          line: Number(line),
          provider: r?.provider ?? '',
          item: r?.item ?? '',
          costCenter: r?.cost_center ?? '',
          amount: amount(m),
          ageMonths: monthsBetween(accrualMonth, month),
        };
      })
      .sort((a, b) => a.accrualMonth.localeCompare(b.accrualMonth) || a.line - b.line);
    const buckets = [
      { bucket: '0' as const, label: 'Accrued this month', test: (n: number) => n <= 0 },
      { bucket: '1' as const, label: '1 month old', test: (n: number) => n === 1 },
      { bucket: '2' as const, label: '2 months old', test: (n: number) => n === 2 },
      { bucket: '3+' as const, label: '3 months or older', test: (n: number) => n >= 3 },
    ];
    // Amortised this month, net of a superseded version's prepaid lines (their supersede entry mirrors them).
    const prepaid = lines.filter((l) => l.month === month && l.account === ACCOUNTS.prepaid.code);
    return {
      month,
      currency: 'USD',
      opening: amount(opening),
      additions: amount(additions),
      superseded: amount(superseded),
      reversals: amount(reversals),
      closing: amount(closing),
      aging: buckets.map((b) => {
        const xs = open.filter((o) => b.test(o.ageMonths));
        return {
          bucket: b.bucket,
          label: b.label,
          amount: amount(
            Money.sum(
              xs.map((x) => Money.parse(x.amount, USD)),
              USD,
            ),
          ),
          lines: xs.length,
        };
      }),
      open,
      prepaidAmortised: amount(net(prepaid)),
      frozen: thisFrozen,
    };
  }

  /** The time a test or a job reads. */
  get today(): string {
    return this.now().toISOString().slice(0, 10);
  }
}
