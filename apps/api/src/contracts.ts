/**
 * Contracts and renewals (spec 009) and the seats they hold (spec 010). A contract is versioned (append only; the
 * newest version wins), imported from a CSV by the controller or the CFO, or made by an approved `contract` request. A
 * contract inside its notice window is listed first and sends `contract.renewal_due` once per renewal date, a reminder
 * a week and a day before its notice date (the last business day on or before renewal − notice days, in LANDLEDGER_TZ),
 * and `contract.notice_missed` once that date passed with no new version. A new contract, or a TCV raised by more than
 * USD 25,000, is held from an import as a pending `contract` request a second person approves (Decision 9); a smaller
 * import goes in at once, listed in the exceptions report unless an approved contract request covers it. A seat request
 * (`tool_or_seat` with `seat`) reserves seats on a contract at approval, at no less than the contract's own seat price;
 * Landflow says it is applied once Landbright granted, and the seat counts as used. A seat is released when access was
 * denied or the grant revoked (`POST /api/requests/:id/seats/release`), or after 30 days unapplied. Seats used are the
 * CSV's count as of its day, plus seats applied after it, less those it counted that were released since.
 */
import type {
  ContractSeats,
  ContractsView,
  ContractTerms,
  ContractView,
  HeldContractImport,
  RequestOrigin,
  SeatEvidence,
  SeatTerms,
  SeatView,
} from '@landledger/contracts';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import type { z } from 'zod';
import type { AuditLog } from './audit.js';
import { lastBusinessDayOnOrBefore, localParts } from './business-hours.js';
import { readCsv } from './csv.js';
import { day, type Sql, type Tx } from './db.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';
import { actorOf, type Principal } from './principal.js';
import { addDays, addMonths, amount, ccLabel, type Spend } from './spend.js';

const nextMonthOf = (m: string) => addMonths(m, 1);
const words = (m: Money) => `$${m.toDecimal().toFixed(2, 'halfEven')}`;
import type { Webhooks } from './webhooks.js';

const USD = REPORTING_CURRENCY;
const REQUIRED = [
  'vendor',
  'product',
  'cost_center',
  'tcv',
  'currency',
  'term_start',
  'term_end',
  'seats_paid',
  'seats_used',
  'renewal_date',
  'notice_days',
] as const;
const OPTIONAL = ['auto_renew', 'landbright_app', 'seats_used_as_of', 'billing'] as const;
/** How a contract bills (review of wave 4, should-fix 12, a default to confirm): monthly in arrears unless named. */
export const BILLINGS = ['prepaid_annual', 'monthly_in_arrears', 'monthly_in_advance'] as const;
export type Billing = (typeof BILLINGS)[number];
/** A new contract, or a TCV raised by more than this, needs a second person (Decision 9's CFO line). */
export const SECOND_PERSON_TCV = '25000';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s: string) =>
  DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** Whole months from `start` to `end` inclusive: 2026-01-01 to 2026-12-31 is 12; at least 1 (what is stored). */
export function termMonths(start: string, end: string): number {
  const after = addDays(end, 1);
  const [y1, m1, d1] = start.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = after.split('-').map(Number) as [number, number, number];
  let m = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) m -= 1;
  return Math.max(1, m);
}

/**
 * Months from `start` to `end` inclusive, exactly: the whole months, plus the days left over as a share of the month
 * they fall in (2026-01-01 to 2026-12-15 is 11 + 15/31). Annual value divides by this, so a part month never inflates
 * it. Twelve places, half to even.
 */
export function termMonthsExact(start: string, end: string): Decimal {
  const after = addDays(end, 1);
  let whole = 0;
  while (addMonthsToDay(start, whole + 1) <= after && whole < 1200) whole++;
  const from = addMonthsToDay(start, whole);
  const next = addMonthsToDay(start, whole + 1);
  const left = daysBetween(from, after);
  if (left <= 0) return Decimal.of(BigInt(Math.max(1, whole)));
  const span = daysBetween(from, next);
  return Decimal.of(BigInt(whole)).plus(Decimal.of(BigInt(left)).divide(String(span), 12, 'halfEven'));
}

/** `day` plus `n` months, clamped to the month's last day (2026-01-31 + 1 month is 2026-02-28). */
export function addMonthsToDay(d: string, n: number): string {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(dd, last));
  return first.toISOString().slice(0, 10);
}

/** The annual value: TCV ÷ months × 12 (months exact, part months included), half to even. */
export const annualValue = (tcv: Money, months: number | Decimal) =>
  Money.fromDecimal(
    tcv
      .toDecimal()
      .times('12')
      .divide(typeof months === 'number' ? String(months) : months, 6, 'halfEven'),
    USD,
  );

/** A seat a month: annual value ÷ seats paid ÷ 12; null without seats. */
export const seatPriceOf = (annual: Money, paid: number | null) =>
  paid && paid > 0 ? Money.fromDecimal(annual.toDecimal().divide(String(paid * 12), 6, 'halfEven'), USD) : null;

export interface ParsedContract {
  line: number;
  vendor: string;
  product: string;
  costCenter: string;
  tcv: Money;
  termStart: string;
  termEnd: string;
  termMonths: number;
  seatsPaid: number | null;
  seatsUsed: number | null;
  /** The day `seatsUsed` was counted; null: the import day. */
  seatsUsedAsOf: string | null;
  renewalDate: string;
  noticeDays: number;
  autoRenew: boolean;
  landbrightApp: string | null;
  billing: Billing;
}

/** Reads a contracts CSV: every problem by line (a bad file imports nothing); non-USD lines apart (422). */
export function parseContractCsv(
  csv: string,
  costCenters: ReadonlySet<string>,
  today?: string,
): { contracts: ParsedContract[]; problems: string[]; currency: string[] } {
  const { rows, problems } = readCsv(csv, REQUIRED, OPTIONAL);
  const currency: string[] = [];
  const out: ParsedContract[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const p = (msg: string) => problems.push(`Line ${r.line}: ${msg}`);
    const vendor = r.get('vendor');
    const product = r.get('product');
    if (!vendor) p('vendor is empty');
    if (!product) p('product is empty');
    const key = `${vendor.toLowerCase()}|${product.toLowerCase()}`;
    if (seen.has(key)) p(`${vendor} ${product} appears twice`);
    seen.add(key);
    const cc = r.get('cost_center');
    if (!costCenters.has(cc)) p(`no cost center ${cc || '(empty)'}`);
    const cur = r.get('currency').toUpperCase();
    if (cur !== 'USD') currency.push(`Line ${r.line}: ${cur || '(empty)'} (only USD until FX is set up)`);
    const tcvText = r.get('tcv');
    if (!/^\d+(\.\d{1,6})?$/.test(tcvText)) p(`tcv ${tcvText || '(empty)'} is not an amount (at most six decimals)`);
    const termStart = r.get('term_start');
    const termEnd = r.get('term_end');
    const renewalDate = r.get('renewal_date');
    for (const [name, v] of [
      ['term_start', termStart],
      ['term_end', termEnd],
      ['renewal_date', renewalDate],
    ] as const)
      if (!isDay(v)) p(`${name} ${v || '(empty)'} is not a date (YYYY-MM-DD)`);
    if (isDay(termStart) && isDay(termEnd) && termEnd < termStart) p('term_end is before term_start');
    if (isDay(termStart) && isDay(renewalDate) && renewalDate < termStart) p('renewal_date is before term_start');
    const paidText = r.get('seats_paid');
    const usedText = r.get('seats_used');
    if (!!paidText !== !!usedText) p('seats_paid and seats_used are both given or both empty');
    const int = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
    if (paidText && int(paidText) === null) p(`seats_paid ${paidText} is not a whole number`);
    if (usedText && int(usedText) === null) p(`seats_used ${usedText} is not a whole number`);
    const noticeText = r.get('notice_days');
    const notice = int(noticeText);
    if (notice === null || notice > 365) p(`notice_days ${noticeText || '(empty)'} is 0 to 365`);
    const auto = r.get('auto_renew').toLowerCase();
    if (auto && auto !== 'true' && auto !== 'false') p(`auto_renew ${auto} is true or false`);
    const asOf = r.get('seats_used_as_of');
    if (asOf && !isDay(asOf)) p(`seats_used_as_of ${asOf} is not a date (YYYY-MM-DD)`);
    if (asOf && !usedText) p('seats_used_as_of goes with seats_used');
    if (asOf && today && isDay(asOf) && asOf > today) p(`seats_used_as_of ${asOf} is after today`);
    const billing = (r.get('billing') || 'monthly_in_arrears').toLowerCase();
    if (!(BILLINGS as readonly string[]).includes(billing)) p(`billing ${billing} is one of ${BILLINGS.join(', ')}`);
    if (problems.length) continue;
    const months = termMonths(termStart, termEnd);
    if (months > 120) {
      p('a term is at most 120 months');
      continue;
    }
    out.push({
      line: r.line,
      vendor,
      product,
      costCenter: cc,
      tcv: Money.parse(tcvText, USD),
      termStart,
      termEnd,
      termMonths: months,
      seatsPaid: paidText ? int(paidText) : null,
      seatsUsed: usedText ? int(usedText) : null,
      seatsUsedAsOf: asOf || null,
      renewalDate,
      noticeDays: notice!,
      autoRenew: auto !== 'false',
      landbrightApp: r.get('landbright_app') || null,
      billing: billing as Billing,
    });
  }
  return { contracts: out, problems, currency };
}

interface VersionRow {
  id: string;
  version: number;
  vendor: string;
  product: string;
  cost_center: string;
  tcv_micros: string;
  term_start: Date;
  term_end: Date;
  term_months: number;
  seats_paid: number | null;
  seats_used: number | null;
  seats_used_as_of: Date | null;
  renewal_date: Date;
  notice_days: number;
  auto_renew: boolean;
  landbright_app: string | null;
  billing: Billing;
  origin: 'entered' | 'dev-fixture' | 'request';
  request_id: string | null;
  imported_by_name: string;
  imported_at: Date;
  reserved: number;
  applied: number;
  released_since: number;
  covered: boolean;
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** How a held import raises its contract request (Requests.create with Landledger's own origin). */
export type RaiseContractRequest = (
  input: {
    kind: 'contract';
    title: string;
    note: string;
    costCenter: string;
    amount: { amount: string; currency: string };
    recurrence: 'once';
    start: string;
    evidence: Record<string, unknown>;
    contract: z.input<typeof ContractTerms>;
  },
  by: Principal,
  origin: Extract<RequestOrigin, { type: 'contract_import' }>,
) => Promise<{ id: string; number: string }>;

export interface ContractsOptions {
  windowDays: number;
  consoleUrl: string;
  timeZone?: string;
  businessDays?: readonly number[];
  holidays?: ReadonlySet<string>;
  /** LANDLEDGER_DEV_AUTH: a `dev-fixture` import is for a development API only. */
  devAuth?: boolean;
}

export class Contracts {
  /** Set by services: a held import raises a contract request through Requests. */
  raiseRequest: RaiseContractRequest | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly spend: Spend,
    private readonly options: ContractsOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get tz() {
    return this.options.timeZone ?? 'UTC';
  }

  /** Today in LANDLEDGER_TZ (renewals and notice dates are local days). */
  private today() {
    return localParts(this.now().getTime(), this.tz).date;
  }

  private async rows(tx: Tx = this.sql, id: string | null = null): Promise<VersionRow[]> {
    const tz = this.tz;
    // Seats used: the CSV's count as of its day (or the import), plus seats applied after it, less the seats it counted
    // that were released since (a grant revoked).
    return tx<VersionRow[]>`
      SELECT c.*, c.tcv_micros::text AS tcv_micros, coalesce(u.email, u.name) AS imported_by_name,
             coalesce((SELECT sum(seats) FROM seat_reservations s WHERE s.contract_id = c.id AND s.status = 'reserved'), 0)::int AS reserved,
             coalesce((SELECT sum(seats) FROM seat_reservations s WHERE s.contract_id = c.id AND s.status = 'applied'
                         AND CASE WHEN c.seats_used_as_of IS NULL THEN s.applied_at >= c.imported_at
                                  ELSE (s.applied_at AT TIME ZONE ${tz})::date > c.seats_used_as_of END), 0)::int AS applied,
             coalesce((SELECT sum(seats) FROM seat_reservations s WHERE s.contract_id = c.id AND s.status = 'released'
                         AND s.applied_at IS NOT NULL
                         AND CASE WHEN c.seats_used_as_of IS NULL THEN s.applied_at < c.imported_at AND s.closed_at >= c.imported_at
                                  ELSE (s.applied_at AT TIME ZONE ${tz})::date <= c.seats_used_as_of
                                       AND (s.closed_at AT TIME ZONE ${tz})::date > c.seats_used_as_of END), 0)::int AS released_since,
             (c.origin = 'request' OR EXISTS (
                SELECT 1 FROM requests q
                WHERE q.kind = 'contract' AND q.status IN ('approved', 'applied')
                  AND (q.contract->>'contractId' = c.id
                       OR (lower(q.contract->>'vendor') = lower(c.vendor) AND lower(q.contract->>'product') = lower(c.product)))
                  AND (q.contract->>'tcv')::numeric * 1000000 >= c.tcv_micros)) AS covered
      FROM (SELECT DISTINCT ON (id) * FROM contract_versions ORDER BY id, version DESC) c
      JOIN users u ON u.id = c.imported_by
      WHERE (${id}::text IS NULL OR c.id = ${id})`;
  }

  private usedOf(r: VersionRow): number | null {
    return r.seats_used === null ? null : Math.max(0, r.seats_used + r.applied - r.released_since);
  }

  private async viewOf(r: VersionRow, ccs?: Awaited<ReturnType<Spend['costCenters']>>): Promise<ContractView> {
    const names = ccs ?? (await this.spend.costCenters());
    const tcv = Money.ofMicros(r.tcv_micros, USD);
    const termStart = day(r.term_start);
    const termEnd = day(r.term_end);
    const annual = annualValue(tcv, termMonthsExact(termStart, termEnd));
    const renewal = day(r.renewal_date);
    const calendarNotice = addDays(renewal, -r.notice_days);
    const notice = this.options.businessDays
      ? lastBusinessDayOnOrBefore(calendarNotice, {
          days: this.options.businessDays,
          holidays: this.options.holidays,
          timeZone: this.tz,
        })
      : calendarNotice;
    const today = this.today();
    const used = this.usedOf(r);
    return {
      id: r.id,
      version: r.version,
      vendor: r.vendor,
      product: r.product,
      costCenter: { code: r.cost_center, name: ccLabel(r.cost_center, names) },
      tcv: amount(tcv),
      annualValue: amount(annual),
      termStart,
      termEnd,
      termMonths: r.term_months,
      seats:
        r.seats_paid === null || used === null
          ? null
          : { paid: r.seats_paid, used, reserved: r.reserved, left: r.seats_paid - used - r.reserved },
      seatPrice: (() => {
        const p = seatPriceOf(annual, r.seats_paid);
        return p ? amount(p) : null;
      })(),
      renewalDate: renewal,
      noticeDays: r.notice_days,
      noticeDate: notice,
      noticeCalendarDate: calendarNotice,
      autoRenew: r.auto_renew,
      landbrightApp: r.landbright_app,
      billing: r.billing ?? 'monthly_in_arrears',
      seatsUsedAsOf:
        r.seats_used === null
          ? null
          : r.seats_used_as_of
            ? day(r.seats_used_as_of)
            : localParts(r.imported_at.getTime(), this.tz).date,
      covered: r.covered,
      inNoticeWindow: today >= addDays(notice, -this.options.windowDays) && today <= renewal,
      daysToNotice: daysBetween(today, notice),
      origin: r.origin,
      requestId: r.request_id,
      importedBy: r.imported_by_name,
      importedAt: r.imported_at.toISOString(),
    };
  }

  /** Imports held for a second person: open contract requests an import raised. */
  private async held(): Promise<HeldContractImport[]> {
    const rows = await this.sql<
      {
        id: string;
        number: number;
        status: string;
        contract: z.output<typeof ContractTerms>;
        origin: { previousTcv?: string };
        created_by_name: string;
        created_at: Date;
      }[]
    >`
      SELECT id, number, status, contract, origin, created_by_name, created_at FROM requests
      WHERE kind = 'contract' AND origin->>'type' = 'contract_import'
        AND status IN ('draft', 'pending', 'awaiting_confirmation')
      ORDER BY created_at, id`;
    return rows.map((r) => ({
      requestId: r.id,
      number: `R-${r.number}`,
      status: r.status,
      vendor: r.contract.vendor,
      product: r.contract.product,
      tcv: amount(Money.parse(r.contract.tcv, USD)),
      previousTcv: r.origin.previousTcv ? amount(Money.parse(r.origin.previousTcv, USD)) : null,
      importedBy: r.created_by_name,
      at: r.created_at.toISOString(),
    }));
  }

  async list(): Promise<ContractsView> {
    const ccs = await this.spend.costCenters();
    const views = await Promise.all((await this.rows()).map((r) => this.viewOf(r, ccs)));
    views.sort((a, b) =>
      a.inNoticeWindow !== b.inNoticeWindow
        ? a.inNoticeWindow
          ? -1
          : 1
        : a.inNoticeWindow
          ? a.noticeDate.localeCompare(b.noticeDate) || a.vendor.localeCompare(b.vendor)
          : a.renewalDate.localeCompare(b.renewalDate) || a.vendor.localeCompare(b.vendor),
    );
    // Totals are real contracts only: a dev fixture is listed, badged, and counted nowhere.
    const real = views.filter((c) => c.origin !== 'dev-fixture');
    const sum = (f: (c: ContractView) => string) =>
      amount(
        Money.sum(
          real.map((c) => Money.parse(f(c), USD)),
          USD,
        ),
      );
    return {
      today: this.today(),
      windowDays: this.options.windowDays,
      contracts: views,
      held: await this.held(),
      totals: {
        annualValue: sum((c) => c.annualValue),
        tcv: sum((c) => c.tcv),
        seatsPaid: real.reduce((n, c) => n + (c.seats?.paid ?? 0), 0),
        seatsUsed: real.reduce((n, c) => n + (c.seats?.used ?? 0), 0),
      },
    };
  }

  async view(id: string, tx: Tx = this.sql): Promise<ContractView> {
    const [r] = await this.rows(tx, id);
    if (!r) throw new ApiError('not_found', `Contract ${id} not found`);
    return this.viewOf(r);
  }

  /** What Landflow needs to raise a seat request: the contract that grants a Landbright app. */
  async seatsFor(app: string): Promise<ContractSeats> {
    const all = await this.rows();
    const r = all
      .filter((c) => c.landbright_app === app)
      .sort((a, b) => b.imported_at.getTime() - a.imported_at.getTime())[0];
    if (!r) throw new ApiError('not_found', `No contract grants the Landbright app ${app}`);
    const contract = await this.viewOf(r);
    return { contract, seatPrice: contract.seatPrice, left: contract.seats?.left ?? 0 };
  }

  /** What each month of the year ahead holds under contract: annual value ÷ 12 per month of the term, real ones only. */
  async contractedIn(
    month: string,
    fromDay: string,
  ): Promise<{ total: Money; contracts: { id: string; amount: Money }[] }> {
    const first = `${month}-01`;
    const last = addDays(`${nextMonthOf(month)}-01`, -1);
    if (fromDay > last) return { total: Money.zero(USD), contracts: [] };
    const out: { id: string; amount: Money }[] = [];
    for (const r of await this.rows()) {
      if (r.origin === 'dev-fixture') continue;
      const start = day(r.term_start);
      const end = day(r.term_end);
      const from = [first, start, fromDay].sort().at(-1)!;
      const to = [last, end].sort()[0]!;
      if (from > to) continue;
      const annual = annualValue(Money.ofMicros(r.tcv_micros, USD), termMonthsExact(start, end));
      const monthly = annual.toDecimal().divide('12', 12, 'halfEven');
      const days = daysBetween(from, to) + 1;
      const span = daysBetween(first, last) + 1;
      const amt = Money.fromDecimal(monthly.times(String(days)).divide(String(span), 6, 'halfEven'), USD);
      if (!amt.isZero()) out.push({ id: r.id, amount: amt });
    }
    return {
      total: Money.sum(
        out.map((c) => c.amount),
        USD,
      ),
      contracts: out,
    };
  }

  // Importing ---------------------------------------------------------------------------------------------------------

  /** Who imports: the controller or the CFO, signed in; a dev fixture only on a development API (dev auth). */
  private who(by: Principal, origin: 'entered' | 'dev-fixture'): string {
    if (origin === 'dev-fixture' && !this.options.devAuth)
      throw new ApiError(
        'forbidden',
        'A dev-fixture contract is for a development API only (LANDLEDGER_DEV_AUTH=on, on this machine)',
      );
    if (by.kind === 'dev' && origin === 'dev-fixture') return 'cli';
    if (by.kind !== 'person')
      throw new ApiError('forbidden', 'Contracts are imported by a person signed in with Landbright; a key never does');
    if (!by.roles.some((r) => r === 'controller' || r === 'cfo'))
      throw new ApiError('forbidden', 'Importing contracts is for the controller or the CFO');
    return by.id;
  }

  async import(
    input: { csv: string; fileName?: string; note: string; origin: 'entered' | 'dev-fixture' },
    by: Principal,
  ): Promise<ContractsView> {
    const userId = this.who(by, input.origin);
    const codes = new Set((await this.sql<{ code: string }[]>`SELECT code FROM cost_center_codes`).map((r) => r.code));
    const parsed = parseContractCsv(input.csv, codes, this.today());
    if (parsed.currency.length)
      throw new ApiError('unprocessable', 'Only USD until FX is set up; nothing was imported', {
        problems: parsed.currency,
      });
    if (parsed.problems.length)
      throw new ApiError(
        'bad_request',
        `The contracts file has ${parsed.problems.length} problem(s); nothing was imported`,
        {
          problems: parsed.problems,
        },
      );
    // Decision 9: a new contract, or a TCV raised by more than the line, waits for a second person.
    const line = Money.parse(SECOND_PERSON_TCV, USD);
    const hold: { c: ParsedContract; prev: { id: string; tcv: Money } | null }[] = [];
    const enter: ParsedContract[] = [];
    for (const c of parsed.contracts) {
      if (input.origin === 'dev-fixture') {
        enter.push(c);
        continue;
      }
      const [prev] = await this.sql<{ id: string; tcv_micros: string }[]>`
        SELECT id, tcv_micros::text AS tcv_micros FROM contract_versions
        WHERE lower(vendor) = ${c.vendor.toLowerCase()} AND lower(product) = ${c.product.toLowerCase()}
          AND origin <> 'dev-fixture'
        ORDER BY imported_at DESC, version DESC LIMIT 1`;
      const prevTcv = prev ? Money.ofMicros(prev.tcv_micros, USD) : null;
      const raise = prevTcv ? c.tcv.minus(prevTcv) : c.tcv;
      if (raise.compare(line) > 0) {
        if (by.kind !== 'person')
          throw new ApiError('forbidden', 'A contract above the second-person line is imported by a person');
        hold.push({ c, prev: prev ? { id: prev.id, tcv: prevTcv! } : null });
      } else enter.push(c);
    }
    if (hold.length && !this.raiseRequest)
      throw new ApiError('internal', 'Contract requests are not wired: nothing was imported');
    await this.sql.begin(async (tx) => {
      for (const c of enter) {
        const v = await this.insertIn(tx, {
          ...c,
          origin: input.origin,
          requestId: null,
          note: input.note,
          by: userId,
        });
        await this.audit.append(
          {
            ...actorOf(by),
            action: v.version === 1 ? 'contract.imported' : 'contract.reimported',
            subjectType: 'contract',
            subjectId: v.id,
            data: {
              version: v.version,
              vendor: c.vendor,
              product: c.product,
              tcvMicros: c.tcv.micros.toString(),
              origin: input.origin,
              fileName: input.fileName ?? null,
            },
          },
          tx,
        );
      }
    });
    for (const { c, prev } of hold) {
      const req = await this.raiseRequest!(
        {
          kind: 'contract',
          title: `${c.vendor} ${c.product}: contract import`.slice(0, 200),
          note: [
            prev
              ? `Imported TCV ${words(c.tcv)} raises ${words(prev.tcv)} by ${words(c.tcv.minus(prev.tcv))}`
              : `A new contract imported at ${words(c.tcv)}`,
            `above the ${words(line)} line: held for a second person (Decision 9).`,
            input.note,
          ]
            .filter(Boolean)
            .join(' ')
            .slice(0, 4000),
          costCenter: c.costCenter,
          amount: { amount: amount(c.tcv), currency: USD },
          recurrence: 'once',
          start: c.termStart,
          evidence: {
            basis: `Line ${c.line} of ${input.fileName ?? 'a contracts CSV'}`,
            lines: [{ label: `${c.vendor} ${c.product} TCV`, amount: amount(c.tcv) }],
          },
          contract: {
            vendor: c.vendor,
            product: c.product,
            tcv: amount(c.tcv),
            termMonths: Math.min(120, c.termMonths),
            start: c.termStart,
            ...(c.seatsPaid ? { seats: c.seatsPaid } : {}),
            noticeDays: c.noticeDays,
            autoRenew: c.autoRenew,
            ...(c.landbrightApp ? { landbrightApp: c.landbrightApp } : {}),
            ...(prev ? { contractId: prev.id } : {}),
            termEnd: c.termEnd,
            renewalDate: c.renewalDate,
            ...(c.seatsUsed !== null ? { seatsUsed: c.seatsUsed } : {}),
            ...(c.seatsUsedAsOf ? { seatsUsedAsOf: c.seatsUsedAsOf } : {}),
            billing: c.billing,
          },
        },
        by,
        {
          type: 'contract_import',
          line: c.line,
          ...(input.fileName ? { fileName: input.fileName.slice(0, 300) } : {}),
          ...(prev ? { contractId: prev.id, previousTcv: amount(prev.tcv) } : {}),
        },
      );
      await this.audit.append({
        ...actorOf(by),
        action: 'contract.import_held',
        subjectType: 'request',
        subjectId: req.id,
        data: {
          vendor: c.vendor,
          product: c.product,
          tcvMicros: c.tcv.micros.toString(),
          previousTcvMicros: prev?.tcv.micros.toString() ?? null,
          fileName: input.fileName ?? null,
          line: c.line,
        },
      });
    }
    return this.list();
  }

  private async insertIn(
    tx: Tx,
    c: Omit<ParsedContract, 'line'> & {
      origin: 'entered' | 'dev-fixture' | 'request';
      requestId: string | null;
      note: string;
      by: string;
      id?: string;
    },
  ): Promise<{ id: string; version: number }> {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`contract:${c.vendor.toLowerCase()}|${c.product.toLowerCase()}`}))`;
    const [prev] = c.id
      ? await tx<{ id: string; version: number }[]>`
          SELECT id, max(version)::int AS version FROM contract_versions WHERE id = ${c.id} GROUP BY id`
      : await tx<{ id: string; version: number }[]>`
          SELECT id, max(version)::int AS version FROM contract_versions
          WHERE lower(vendor) = ${c.vendor.toLowerCase()} AND lower(product) = ${c.product.toLowerCase()}
          GROUP BY id ORDER BY max(imported_at) DESC LIMIT 1`;
    const id = prev?.id ?? c.id ?? newId('con');
    const version = (prev?.version ?? 0) + 1;
    await tx`
      INSERT INTO contract_versions (id, version, vendor, product, cost_center, tcv_micros, currency, term_start, term_end,
                                     term_months, seats_paid, seats_used, seats_used_as_of, renewal_date, notice_days,
                                     auto_renew, landbright_app, billing, origin, request_id, note, imported_by,
                                     imported_at)
      VALUES (${id}, ${version}, ${c.vendor}, ${c.product}, ${c.costCenter}, ${c.tcv.micros.toString()}, 'USD',
              ${c.termStart}, ${c.termEnd}, ${c.termMonths}, ${c.seatsPaid}, ${c.seatsUsed}, ${c.seatsUsedAsOf},
              ${c.renewalDate}, ${c.noticeDays}, ${c.autoRenew}, ${c.landbrightApp}, ${c.billing}, ${c.origin},
              ${c.requestId}, ${c.note}, ${c.by}, ${this.now()})`;
    return { id, version };
  }

  // Renewals ----------------------------------------------------------------------------------------------------------

  /**
   * The job, every hour: `contract.renewal_due` once per contract and renewal date as it enters its notice window; a
   * reminder (`contract.notice_reminder`) a week and a day before the notice date; and `contract.notice_missed` once the
   * notice date passed with no new version since (nobody renegotiated, renewed or ended it). Each once per contract,
   * renewal date and day.
   */
  async renewalAlerts(): Promise<number> {
    let sent = 0;
    const today = this.today();
    const latest = new Map(
      (
        await this.sql<{ id: string; at: Date }[]>`
          SELECT id, max(imported_at) AS at FROM contract_versions GROUP BY id`
      ).map((r) => [r.id, localParts(r.at.getTime(), this.tz).date]),
    );
    for (const c of (await this.list()).contracts) {
      const notices: { kind: 'renewal_due' | 'reminder' | 'missed'; day: string }[] = [];
      if (c.inNoticeWindow) notices.push({ kind: 'renewal_due', day: c.renewalDate });
      const days = daysBetween(today, c.noticeDate);
      if (days >= 0 && days <= 7) notices.push({ kind: 'reminder', day: addDays(c.noticeDate, days <= 1 ? -1 : -7) });
      if (today > c.noticeDate && today < c.renewalDate && (latest.get(c.id) ?? '') <= c.noticeDate)
        notices.push({ kind: 'missed', day: c.noticeDate });
      for (const n of notices)
        await this.sql.begin(async (tx) => {
          const rows =
            n.kind === 'renewal_due'
              ? await tx`
                  INSERT INTO contract_alerts (contract_id, renewal_date) VALUES (${c.id}, ${c.renewalDate})
                  ON CONFLICT DO NOTHING RETURNING 1`
              : await tx`
                  INSERT INTO contract_notices (contract_id, renewal_date, kind, day)
                  VALUES (${c.id}, ${c.renewalDate}, ${n.kind}, ${n.day}) ON CONFLICT DO NOTHING RETURNING 1`;
          if (!rows.length) return;
          const event =
            n.kind === 'renewal_due'
              ? 'contract.renewal_due'
              : n.kind === 'reminder'
                ? 'contract.notice_reminder'
                : 'contract.notice_missed';
          await this.webhooks.enqueue(tx, event, {
            contract: c,
            url: `${this.options.consoleUrl}/contracts?id=${c.id}`,
          });
          await this.audit.append(
            {
              actor: 'contracts',
              actorKind: 'system',
              action: event,
              subjectType: 'contract',
              subjectId: c.id,
              data: { renewalDate: c.renewalDate, noticeDate: c.noticeDate, daysToNotice: c.daysToNotice },
            },
            tx,
          );
          sent++;
        });
    }
    return sent;
  }

  // Requests (specs 009, 010) -------------------------------------------------------------------------------------------

  /** Checks a request's contract or seat terms before it is stored. */
  async checkTerms(input: {
    kind: string;
    recurrence: string;
    amount: Money;
    contract?: z.output<typeof ContractTerms>;
    seat?: z.output<typeof SeatTerms>;
  }): Promise<void> {
    if (input.kind === 'contract' && input.contract) {
      if (input.recurrence !== 'once')
        throw new ApiError('bad_request', 'A contract request is once: its amount is the total contract value');
      if (!Money.parse(input.contract.tcv, USD).equals(input.amount))
        throw new ApiError(
          'bad_request',
          `A contract request's amount is its total contract value (${input.contract.tcv})`,
        );
      if (input.contract.termEnd && input.contract.termEnd < input.contract.start)
        throw new ApiError('bad_request', 'The contract ends before it starts');
      if (input.contract.contractId) await this.view(input.contract.contractId);
    }
    if (input.seat) {
      if (input.recurrence !== 'monthly')
        throw new ApiError('bad_request', 'A seat is paid monthly: recurrence monthly');
      const want = Money.fromDecimal(Decimal.parse(input.seat.seatPrice).times(String(input.seat.seats)), USD);
      if (!want.equals(input.amount))
        throw new ApiError(
          'bad_request',
          `A seat request's amount is seats × seat price a month: ${input.seat.seats} × ${input.seat.seatPrice} = ${amount(want)}`,
        );
      const c = await this.view(input.seat.contractId);
      // A seat costs what the contract says it does: a lower price would slip a seat under the threshold.
      if (c.seatPrice && Money.parse(input.seat.seatPrice, USD).compare(Money.parse(c.seatPrice, USD)) < 0)
        throw new ApiError(
          'bad_request',
          `A seat on ${c.vendor} ${c.product} costs ${c.seatPrice} a month (annual value ÷ seats paid ÷ 12): not less`,
        );
    }
  }

  /** At approval, in the approving transaction: a contract request makes its contract version; a seat is reserved. */
  async approvedIn(
    tx: Tx,
    r: {
      id: string;
      cost_center: string;
      contract: z.output<typeof ContractTerms> | null;
      seat: z.output<typeof SeatTerms> | null;
    },
    deciderId: string | null,
  ): Promise<void> {
    if (r.contract) {
      const t = r.contract;
      const [prev] = t.contractId ? await this.rows(tx, t.contractId) : [];
      const termEnd = t.termEnd ?? addDays(addMonthsToDay(t.start, t.termMonths), -1);
      const by =
        deciderId ??
        (
          await tx<{ decided_by: string }[]>`
          SELECT decided_by FROM decisions WHERE request_id = ${r.id} ORDER BY decided_at DESC LIMIT 1`
        )[0]?.decided_by;
      if (!by) throw new ApiError('conflict', 'A contract is made by a person’s approval');
      const seats = t.seats ?? prev?.seats_paid ?? null;
      const prevUsed = prev ? (this.usedOf(prev) ?? 0) : 0;
      const v = await this.insertIn(tx, {
        id: t.contractId,
        vendor: t.vendor,
        product: t.product,
        costCenter: r.cost_center,
        tcv: Money.parse(t.tcv, USD),
        termStart: t.start,
        termEnd,
        termMonths: termMonths(t.start, termEnd),
        seatsPaid: seats,
        seatsUsed: seats === null ? null : (t.seatsUsed ?? Math.min(prevUsed, seats)),
        seatsUsedAsOf: seats === null ? null : (t.seatsUsedAsOf ?? null),
        renewalDate: t.renewalDate ?? addDays(termEnd, 1),
        noticeDays: t.noticeDays,
        autoRenew: t.autoRenew,
        landbrightApp: t.landbrightApp ?? prev?.landbright_app ?? null,
        billing: t.billing ?? prev?.billing ?? 'monthly_in_arrears',
        origin: 'request',
        requestId: r.id,
        note: `Approved request ${r.id}`,
        by,
      });
      await this.audit.append(
        {
          actor: 'contracts',
          actorKind: 'system',
          action: 'contract.from_request',
          subjectType: 'contract',
          subjectId: v.id,
          data: { version: v.version, requestId: r.id, seats },
        },
        tx,
      );
    }
    if (r.seat) {
      await tx`
        INSERT INTO seat_reservations (id, contract_id, request_id, seats)
        VALUES (${newId('seat')}, ${r.seat.contractId}, ${r.id}, ${r.seat.seats})`;
    }
  }

  /** Landflow said the seat request is applied (Landbright granted): its seats move from reserved to used. */
  async appliedIn(tx: Tx, r: { id: string; seat: unknown }): Promise<void> {
    if (!r.seat) return;
    const now = this.now();
    await tx`
      UPDATE seat_reservations SET status = 'applied', closed_at = ${now}, applied_at = ${now}
      WHERE request_id = ${r.id} AND status = 'reserved'`;
  }

  /**
   * Releases a request's seats in its transaction: a reserved seat (access denied, not needed, expired), or an applied
   * one whose grant was revoked. Returns what it released, or null when nothing was there to release.
   */
  async releaseSeatIn(
    tx: Tx,
    requestId: string,
    reason: 'access_denied' | 'grant_revoked' | 'not_needed' | 'expired',
  ): Promise<{ contractId: string; seats: number; from: 'reserved' | 'applied' } | null> {
    const [s] = await tx<{ id: string; contract_id: string; seats: number; status: string }[]>`
      SELECT id, contract_id, seats, status FROM seat_reservations WHERE request_id = ${requestId} FOR UPDATE`;
    if (!s) throw new ApiError('not_found', 'This request holds no seat');
    if (s.status === 'released') throw new ApiError('conflict', 'The seat is released already');
    if (s.status === 'applied' && reason !== 'grant_revoked')
      throw new ApiError('conflict', 'The seat was granted: it is released when the grant is revoked (grant_revoked)');
    await tx`
      UPDATE seat_reservations SET status = 'released', closed_at = ${this.now()}, close_reason = ${reason}
      WHERE id = ${s.id}`;
    return { contractId: s.contract_id, seats: s.seats, from: s.status as 'reserved' | 'applied' };
  }

  async seatViewIn(tx: Tx, r: { id: string; seat: z.output<typeof SeatTerms> | null }): Promise<SeatView | null> {
    if (!r.seat) return null;
    const [c] = await tx<{ vendor: string; product: string }[]>`
      SELECT vendor, product FROM contract_versions WHERE id = ${r.seat.contractId} ORDER BY version DESC LIMIT 1`;
    const [s] = await tx<
      { status: SeatView['status'] }[]
    >`SELECT status FROM seat_reservations WHERE request_id = ${r.id}`;
    return {
      contractId: r.seat.contractId,
      vendor: c?.vendor ?? '(unknown)',
      product: c?.product ?? '(unknown)',
      seats: r.seat.seats,
      seatPrice: amount(Money.parse(r.seat.seatPrice, USD)),
      status: s?.status ?? 'none',
    };
  }

  /** A seat request's evidence: the contract's seats now and after this one. */
  async seatEvidence(r: {
    id: string;
    status: string;
    seat: z.output<typeof SeatTerms> | null;
  }): Promise<SeatEvidence | null> {
    if (!r.seat) return null;
    const c = await this.view(r.seat.contractId);
    const paid = c.seats?.paid ?? 0;
    const used = c.seats?.used ?? 0;
    const counted = r.status === 'approved' || r.status === 'applied';
    // Once approved, its own seats are in `reserved` (or `used`): "now" is without it, as at the decision.
    const [own] = counted
      ? await this.sql<{ seats: number; status: string }[]>`
          SELECT seats, status FROM seat_reservations WHERE request_id = ${r.id}`
      : [];
    const reserved = (c.seats?.reserved ?? 0) - (own?.status === 'reserved' ? own.seats : 0);
    const usedNow = used - (own?.status === 'applied' ? own.seats : 0);
    const leftNow = paid - usedNow - reserved;
    const leftAfter = leftNow - r.seat.seats;
    return {
      contractId: c.id,
      vendor: c.vendor,
      product: c.product,
      renewalDate: c.renewalDate,
      paid,
      used: usedNow,
      reserved,
      leftNow,
      leftAfter,
      seatPrice: amount(Money.parse(r.seat.seatPrice, USD)),
      contractSeatPrice: c.seatPrice,
      note:
        leftAfter < 0
          ? `No seat is left on ${c.vendor} ${c.product}: approving buys a seat beyond the contract (${paid} paid)`
          : null,
    };
  }
}
