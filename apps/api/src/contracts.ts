/**
 * Contracts and renewals (spec 009) and the seats they hold (spec 010). A contract is versioned (append only; the
 * newest version wins), imported from a CSV by the controller or the CFO, or made by an approved `contract` request. A
 * contract inside its notice window is listed first and sends `contract.renewal_due` once per renewal date. A seat
 * request (`tool_or_seat` with `seat`) reserves seats on a contract at approval; Landflow says it is applied once
 * Landbright granted, and the seat counts as used.
 */
import type {
  ContractSeats,
  ContractsView,
  ContractTerms,
  ContractView,
  SeatEvidence,
  SeatTerms,
  SeatView,
} from '@landledger/contracts';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import type { z } from 'zod';
import type { AuditLog } from './audit.js';
import { readCsv } from './csv.js';
import { day, type Sql, type Tx } from './db.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';
import { actorOf, type Principal } from './principal.js';
import { addDays, amount, ccLabel, type Spend } from './spend.js';
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
const OPTIONAL = ['auto_renew', 'landbright_app'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s: string) =>
  DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** Whole months from `start` to `end` inclusive: 2026-01-01 to 2026-12-31 is 12; at least 1. */
export function termMonths(start: string, end: string): number {
  const after = addDays(end, 1);
  const [y1, m1, d1] = start.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = after.split('-').map(Number) as [number, number, number];
  let m = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) m -= 1;
  return Math.max(1, m);
}

/** `day` plus `n` months, clamped to the month's last day (2026-01-31 + 1 month is 2026-02-28). */
export function addMonthsToDay(d: string, n: number): string {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(dd, last));
  return first.toISOString().slice(0, 10);
}

/** The annual value: TCV ÷ months × 12, half to even. */
export const annualValue = (tcv: Money, months: number) =>
  Money.fromDecimal(tcv.toDecimal().times('12').divide(String(months), 6, 'halfEven'), USD);

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
  renewalDate: string;
  noticeDays: number;
  autoRenew: boolean;
  landbrightApp: string | null;
}

/** Reads a contracts CSV: every problem by line (a bad file imports nothing); non-USD lines apart (422). */
export function parseContractCsv(
  csv: string,
  costCenters: ReadonlySet<string>,
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
      renewalDate,
      noticeDays: notice!,
      autoRenew: auto !== 'false',
      landbrightApp: r.get('landbright_app') || null,
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
  renewal_date: Date;
  notice_days: number;
  auto_renew: boolean;
  landbright_app: string | null;
  origin: 'entered' | 'dev-fixture' | 'request';
  request_id: string | null;
  imported_by_name: string;
  imported_at: Date;
  reserved: number;
  applied: number;
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export class Contracts {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly spend: Spend,
    private readonly options: { windowDays: number; consoleUrl: string },
    private readonly now: () => Date = () => new Date(),
  ) {}

  private today() {
    return this.now().toISOString().slice(0, 10);
  }

  private async rows(tx: Tx = this.sql, id: string | null = null): Promise<VersionRow[]> {
    return tx<VersionRow[]>`
      SELECT c.*, c.tcv_micros::text AS tcv_micros, coalesce(u.email, u.name) AS imported_by_name,
             coalesce((SELECT sum(seats) FROM seat_reservations s WHERE s.contract_id = c.id AND s.status = 'reserved'), 0)::int AS reserved,
             coalesce((SELECT sum(seats) FROM seat_reservations s WHERE s.contract_id = c.id AND s.status = 'applied'
                         AND s.closed_at >= c.imported_at), 0)::int AS applied
      FROM (SELECT DISTINCT ON (id) * FROM contract_versions ORDER BY id, version DESC) c
      JOIN users u ON u.id = c.imported_by
      WHERE (${id}::text IS NULL OR c.id = ${id})`;
  }

  private async viewOf(r: VersionRow, ccs?: Awaited<ReturnType<Spend['costCenters']>>): Promise<ContractView> {
    const names = ccs ?? (await this.spend.costCenters());
    const tcv = Money.ofMicros(r.tcv_micros, USD);
    const annual = annualValue(tcv, r.term_months);
    const renewal = day(r.renewal_date);
    const notice = addDays(renewal, -r.notice_days);
    const today = this.today();
    const used = r.seats_used === null ? null : r.seats_used + r.applied;
    return {
      id: r.id,
      version: r.version,
      vendor: r.vendor,
      product: r.product,
      costCenter: { code: r.cost_center, name: ccLabel(r.cost_center, names) },
      tcv: amount(tcv),
      annualValue: amount(annual),
      termStart: day(r.term_start),
      termEnd: day(r.term_end),
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
      autoRenew: r.auto_renew,
      landbrightApp: r.landbright_app,
      inNoticeWindow: today >= addDays(notice, -this.options.windowDays) && today <= renewal,
      daysToNotice: daysBetween(today, notice),
      origin: r.origin,
      requestId: r.request_id,
      importedBy: r.imported_by_name,
      importedAt: r.imported_at.toISOString(),
    };
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
    const sum = (f: (c: ContractView) => string) =>
      amount(
        Money.sum(
          views.map((c) => Money.parse(f(c), USD)),
          USD,
        ),
      );
    return {
      today: this.today(),
      windowDays: this.options.windowDays,
      contracts: views,
      totals: {
        annualValue: sum((c) => c.annualValue),
        tcv: sum((c) => c.tcv),
        seatsPaid: views.reduce((n, c) => n + (c.seats?.paid ?? 0), 0),
        seatsUsed: views.reduce((n, c) => n + (c.seats?.used ?? 0), 0),
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

  // Importing ---------------------------------------------------------------------------------------------------------

  async import(
    input: { csv: string; fileName?: string; note: string; origin: 'entered' | 'dev-fixture' },
    by: Principal,
  ): Promise<ContractsView> {
    if (by.kind !== 'person')
      throw new ApiError('forbidden', 'Contracts are imported by a person signed in with Landbright; a key never does');
    if (!by.roles.some((r) => r === 'controller' || r === 'cfo'))
      throw new ApiError('forbidden', 'Importing contracts is for the controller or the CFO');
    const codes = new Set((await this.sql<{ code: string }[]>`SELECT code FROM cost_center_codes`).map((r) => r.code));
    const parsed = parseContractCsv(input.csv, codes);
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
    await this.sql.begin(async (tx) => {
      for (const c of parsed.contracts) {
        const v = await this.insertIn(tx, {
          ...c,
          origin: input.origin,
          requestId: null,
          note: input.note,
          by: by.id,
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
                                     term_months, seats_paid, seats_used, renewal_date, notice_days, auto_renew,
                                     landbright_app, origin, request_id, note, imported_by, imported_at)
      VALUES (${id}, ${version}, ${c.vendor}, ${c.product}, ${c.costCenter}, ${c.tcv.micros.toString()}, 'USD',
              ${c.termStart}, ${c.termEnd}, ${c.termMonths}, ${c.seatsPaid}, ${c.seatsUsed}, ${c.renewalDate},
              ${c.noticeDays}, ${c.autoRenew}, ${c.landbrightApp}, ${c.origin}, ${c.requestId}, ${c.note}, ${c.by},
              ${this.now()})`;
    return { id, version };
  }

  // Renewals ----------------------------------------------------------------------------------------------------------

  /** The job: `contract.renewal_due` once per contract and renewal date, for each inside its notice window. */
  async renewalAlerts(): Promise<number> {
    let sent = 0;
    for (const c of (await this.list()).contracts) {
      if (!c.inNoticeWindow) continue;
      await this.sql.begin(async (tx) => {
        const rows = await tx`
          INSERT INTO contract_alerts (contract_id, renewal_date) VALUES (${c.id}, ${c.renewalDate})
          ON CONFLICT DO NOTHING RETURNING 1`;
        if (!rows.length) return;
        await this.webhooks.enqueue(tx, 'contract.renewal_due', {
          contract: c,
          url: `${this.options.consoleUrl}/contracts?id=${c.id}`,
        });
        await this.audit.append(
          {
            actor: 'contracts',
            actorKind: 'system',
            action: 'contract.renewal_due',
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
      await this.view(input.seat.contractId);
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
      const termEnd = addDays(addMonthsToDay(t.start, t.termMonths), -1);
      const by =
        deciderId ??
        (
          await tx<{ decided_by: string }[]>`
          SELECT decided_by FROM decisions WHERE request_id = ${r.id} ORDER BY decided_at DESC LIMIT 1`
        )[0]?.decided_by;
      if (!by) throw new ApiError('conflict', 'A contract is made by a person’s approval');
      const seats = t.seats ?? prev?.seats_paid ?? null;
      const v = await this.insertIn(tx, {
        id: t.contractId,
        vendor: t.vendor,
        product: t.product,
        costCenter: r.cost_center,
        tcv: Money.parse(t.tcv, USD),
        termStart: t.start,
        termEnd,
        termMonths: t.termMonths,
        seatsPaid: seats,
        seatsUsed: seats === null ? null : Math.min(prev ? (prev.seats_used ?? 0) + prev.applied : 0, seats),
        renewalDate: addDays(termEnd, 1),
        noticeDays: t.noticeDays,
        autoRenew: t.autoRenew,
        landbrightApp: t.landbrightApp ?? prev?.landbright_app ?? null,
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
    await tx`UPDATE seat_reservations SET status = 'applied', closed_at = ${this.now()} WHERE request_id = ${r.id} AND status = 'reserved'`;
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
