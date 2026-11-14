/**
 * Reservations (spec 004): budget an approved request holds until its real cost arrives. Approval reserves the
 * request's first month (and, for an open-ended monthly request, the two after); `POST /api/reservations` reserves
 * another month of its window. A backdated monthly request reserves from the later of its start and the current month.
 * A reservation is consumed by the real cost of its cost center and month that matches the request's `evidence.match`
 * selector, from its first day, and only by what is above its baseline (the matched cost's daily average over the 30
 * days before approval): the request's increment, not what was already running. Where selectors overlap, the oldest
 * reservation consumes a line first, so one cost never consumes two. Without a selector nothing consumes it, and it is
 * released when its month ends (Budgets labels it). Budget left = budget − actuals − reservations' remaining.
 */
import { attrsOf } from './allocation.js';
import { matches, type Selector } from '@landledger/allocation';
import type { ReservationView, ReserveInput } from '@landledger/contracts';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import type { AuditLog } from './audit.js';
import { day, type Sql, type Tx } from './db.js';
import { ApiError, notFound } from './errors.js';
import { newId } from './ids.js';
import { actorOf, type Principal } from './principal.js';
import { addMonths, amount, type Line, monthDays, type Spend } from './spend.js';

const USD = REPORTING_CURRENCY;

interface ReservationRow {
  id: string;
  request_id: string;
  request_title?: string;
  cost_center: string;
  month: Date;
  amount_micros: string;
  currency: string;
  consumed_micros: string;
  selector: Selector | null;
  from_day: Date;
  consumption: 'matched' | 'none';
  baseline_daily_micros: string | null;
  status: 'reserved' | 'consumed' | 'released';
  note: string;
  created_by: string;
  created_at: Date;
  closed_at: Date | null;
}

/** What a request reserves: its amount, cost center, window and `match` selector. */
export interface Reservable {
  id: string;
  title: string;
  status: string;
  cost_center: string;
  amount_micros: string;
  currency: string;
  recurrence: 'monthly' | 'once';
  start_day: Date;
  end_day: Date | null;
  evidence: Record<string, unknown>;
}

/**
 * What a request adds in a month: a one-off amount in its start month; a monthly amount for every month of its window,
 * pro rata in the first and last (by days, from the start day and to the end day).
 */
export function addsInMonth(r: Reservable, month: string): Money {
  const total = Money.ofMicros(r.amount_micros, r.currency.trim());
  const start = day(r.start_day);
  const end = r.end_day ? day(r.end_day) : null;
  const zero = Money.zero(total.currency);
  if (r.recurrence === 'once') return start.slice(0, 7) === month ? total : zero;
  const dim = monthDays(month);
  const first = `${month}-01`;
  const last = `${month}-${String(dim).padStart(2, '0')}`;
  if (start > last || (end && end < first)) return zero;
  const from = start > first ? Number(start.slice(8, 10)) : 1;
  const to = end && end < last ? Number(end.slice(8, 10)) : dim;
  const days = to - from + 1;
  if (days === dim) return total;
  return Money.fromDecimal(total.toDecimal().times(String(days)).divide(String(dim), 6, 'halfEven'), total.currency);
}

/**
 * The months approval reserves: the start month, and for an open-ended (or long) monthly request the two after. A
 * backdated monthly request starts from the later of its start month and the current one.
 */
export function monthsToReserve(r: Reservable, currentMonth?: string): string[] {
  const start = day(r.start_day).slice(0, 7);
  if (r.recurrence === 'once') return [start];
  const from = currentMonth && currentMonth > start ? currentMonth : start;
  const end = r.end_day ? day(r.end_day).slice(0, 7) : null;
  return [from, addMonths(from, 1), addMonths(from, 2)].filter((m) => !end || m <= end);
}

export const selectorOf = (evidence: Record<string, unknown>): Selector | null => {
  const m = evidence.match;
  return m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length ? (m as Selector) : null;
};

export const reservationOf = (r: ReservationRow): ReservationView => {
  const amt = Money.ofMicros(r.amount_micros, r.currency.trim());
  const used = Money.ofMicros(r.consumed_micros, r.currency.trim());
  const left = amt.minus(used);
  return {
    id: r.id,
    requestId: r.request_id,
    requestTitle: r.request_title ?? '',
    costCenter: r.cost_center,
    month: day(r.month).slice(0, 7),
    amount: amount(amt),
    consumed: amount(used),
    remaining: amount(r.status === 'reserved' && left.sign() > 0 ? left : Money.zero(amt.currency)),
    status: r.status,
    createdAt: r.created_at.toISOString(),
    closedAt: r.closed_at?.toISOString() ?? null,
    note: r.note,
    consumption: r.consumption ?? (r.selector ? 'matched' : 'none'),
    baselineDaily:
      r.baseline_daily_micros === null || r.baseline_daily_micros === undefined
        ? null
        : amount(Money.ofMicros(r.baseline_daily_micros, r.currency.trim())),
  };
};

/** Does a line match a reservation's cost center and selector? */
export const lineMatches = (l: Line, costCenter: string, selector: Selector) =>
  !l.correction &&
  l.costCenter === costCenter &&
  matches(
    selector,
    attrsOf({ source: l.source, tags: l.tags, sku_meter: null, actor_id: null, service_name: l.serviceName }),
  );

export class Reservations {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly spend: Spend,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async forRequest(requestId: string, tx: Tx = this.sql): Promise<ReservationView[]> {
    const rows = await tx<ReservationRow[]>`
      SELECT v.*, r.title AS request_title FROM reservations v JOIN requests r ON r.id = v.request_id
      WHERE v.request_id = ${requestId} ORDER BY v.month`;
    return rows.map(reservationOf);
  }

  async list(q: { month?: string; costCenter?: string; status?: string }): Promise<ReservationView[]> {
    const s = this.sql;
    const rows = await s<ReservationRow[]>`
      SELECT v.*, r.title AS request_title FROM reservations v JOIN requests r ON r.id = v.request_id
      WHERE ${q.month ? s`v.month = ${`${q.month}-01`}` : s`true`}
        AND ${q.costCenter ? s`v.cost_center = ${q.costCenter}` : s`true`}
        AND ${q.status ? s`v.status = ${q.status}` : s`true`}
      ORDER BY v.month DESC, v.created_at DESC LIMIT 500`;
    return rows.map(reservationOf);
  }

  /** At approval, in the approving transaction: the request's months, at what it adds in each. */
  async reserveApprovedIn(tx: Tx, r: Reservable, by: string): Promise<ReservationView[]> {
    const out: ReservationView[] = [];
    const baseline = await this.baselineOf(r);
    for (const month of monthsToReserve(r, this.now().toISOString().slice(0, 7))) {
      const adds = addsInMonth(r, month);
      if (adds.isZero()) continue;
      const row = await this.insert(tx, r, month, adds, by, 'reserved at approval', baseline);
      if (row) out.push(row);
    }
    return out;
  }

  /**
   * The matched cost's daily average over the 30 days before now (cost center and the request's `match`): what was
   * already running, which a reservation's consumption leaves out. Null without a selector.
   */
  async baselineOf(r: Reservable): Promise<Money | null> {
    const selector = selectorOf(r.evidence);
    if (!selector) return null;
    const today = this.now().toISOString().slice(0, 10);
    const from = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const { lines } = await this.spend.lines({ from, to });
    const total = Money.sum(
      lines.filter((l) => lineMatches(l, r.cost_center, selector)).map((l) => l.amount),
      USD,
    );
    return Money.fromDecimal(total.toDecimal().divide('30', 6, 'halfEven'), USD);
  }

  private async insert(
    tx: Tx,
    r: Reservable,
    month: string,
    amt: Money,
    by: string,
    note: string,
    baseline: Money | null,
  ) {
    const start = day(r.start_day);
    const fromDay = start.slice(0, 7) === month ? start : `${month}-01`;
    const selector = selectorOf(r.evidence);
    const [row] = await tx<ReservationRow[]>`
      INSERT INTO reservations (id, request_id, cost_center, month, amount_micros, currency, selector, from_day, note,
                                created_by, consumption, baseline_daily_micros)
      VALUES (${newId('rsv')}, ${r.id}, ${r.cost_center}, ${`${month}-01`}, ${amt.micros.toString()},
              ${amt.currency}, ${selector ? tx.json(selector as never) : null},
              ${fromDay}, ${note}, ${by}, ${selector ? 'matched' : 'none'},
              ${selector ? (baseline ?? Money.zero(USD)).micros.toString() : null})
      ON CONFLICT (request_id, month) DO NOTHING RETURNING *`;
    if (!row) return null;
    await this.audit.append(
      {
        actor: by,
        actorKind: by.includes('@') ? 'person' : by.startsWith('key:') ? 'key' : 'system',
        action: 'reservation.created',
        subjectType: 'reservation',
        subjectId: row.id,
        data: { requestId: r.id, costCenter: r.cost_center, month, amountMicros: amt.micros.toString(), note },
      },
      tx,
    );
    return reservationOf({ ...row, request_title: r.title });
  }

  /** `POST /api/reservations`: another month of an approved request's window, idempotent per month. */
  async reserve(input: ReserveInput, by: Principal): Promise<{ reservation: ReservationView; created: boolean }> {
    return this.sql.begin(async (tx) => {
      const [r] = await tx<Reservable[]>`SELECT * FROM requests WHERE id = ${input.requestId} FOR UPDATE`;
      if (!r) throw notFound('Request');
      if (r.status !== 'approved' && r.status !== 'applied')
        throw new ApiError('conflict', `Request is ${r.status}: only an approved request reserves budget`);
      const month = input.month ?? this.now().toISOString().slice(0, 7);
      const cap = addsInMonth(r, month);
      if (cap.isZero()) throw new ApiError('bad_request', `${month} is outside the request's window`);
      const amt = input.amount ? Money.parse(input.amount, r.currency.trim()) : cap;
      if (amt.compare(cap) > 0)
        throw new ApiError('bad_request', `At most ${amount(cap)} ${cap.currency}: what the request adds in ${month}`);
      const [existing] = await tx<ReservationRow[]>`
        SELECT v.*, ${r.title} AS request_title FROM reservations v WHERE request_id = ${r.id} AND month = ${`${month}-01`}`;
      if (existing) return { reservation: reservationOf(existing), created: false };
      const row = await this.insert(
        tx,
        r,
        month,
        amt,
        actorOf(by).actor,
        'reserved by request',
        await this.baselineOf(r),
      );
      return { reservation: row!, created: true };
    }) as Promise<{ reservation: ReservationView; created: boolean }>;
  }

  /**
   * Releases a reservation: only the key that raised its request, the requester (or the agent's sponsor), or an admin
   * person.
   */
  async release(id: string, reason: string, by: Principal): Promise<ReservationView> {
    return this.sql.begin(async (tx) => {
      const [owner] = await tx<
        { requester_id: string | null; sponsor_id: string | null; created_by_kind: string; created_by_id: string }[]
      >`
        SELECT r.requester_id, r.sponsor_id, r.created_by_kind, r.created_by_id
        FROM reservations v JOIN requests r ON r.id = v.request_id WHERE v.id = ${id}`;
      if (!owner) throw notFound('Reservation');
      const may =
        (by.kind === 'person' &&
          (by.id === owner.requester_id || by.id === owner.sponsor_id || by.scopes.includes('admin'))) ||
        (by.kind === 'key' && owner.created_by_kind === 'key' && owner.created_by_id === by.id);
      if (!may)
        throw new ApiError(
          'forbidden',
          "Only the key that raised the request, its requester or an admin person releases a request's reservation",
        );
      const [row] = await tx<ReservationRow[]>`
        UPDATE reservations SET status = 'released', closed_at = ${this.now()},
          note = ${`released by ${actorOf(by).actor}${reason ? `: ${reason}` : ''}`}
        WHERE id = ${id} AND status = 'reserved' RETURNING *`;
      if (!row) {
        const [any] = await tx`SELECT status FROM reservations WHERE id = ${id}`;
        if (!any) throw notFound('Reservation');
        throw new ApiError('conflict', `The reservation is ${any.status as string} already`);
      }
      await this.audit.append(
        { ...actorOf(by), action: 'reservation.released', subjectType: 'reservation', subjectId: id, data: { reason } },
        tx,
      );
      return reservationOf(row);
    }) as Promise<ReservationView>;
  }

  /** Releases a cancelled or expired request's reservations (none, as only approved ones reserve) and returns them. */
  async releaseFor(tx: Tx, requestId: string, note: string) {
    await tx`
      UPDATE reservations SET status = 'released', closed_at = now(), note = ${note}
      WHERE request_id = ${requestId} AND status = 'reserved'`;
  }

  /**
   * The job: real cost consumes reservations; at month end what is left is released. Per month, oldest reservation
   * first, each takes from the lines its selector matches only what is above its daily baseline, and a line taken by
   * one is not there for the next (overlapping selectors never consume the same cost twice). A reservation with no
   * selector is consumed by nothing and released when its month ends. Returns the reservations it changed.
   */
  async settle(): Promise<number> {
    const now = this.now();
    const current = now.toISOString().slice(0, 7);
    const months = await this.sql<{ month: Date }[]>`
      SELECT DISTINCT month FROM reservations WHERE status = 'reserved' AND month <= ${`${current}-01`} ORDER BY month`;
    let changed = 0;
    for (const { month: m } of months) {
      const month = day(m).slice(0, 7);
      // Every reservation that holds cost in the month, oldest first: those still reserved and those consumed.
      const rows = await this.sql<ReservationRow[]>`
        SELECT * FROM reservations WHERE month = ${`${month}-01`} AND status IN ('reserved', 'consumed')
        ORDER BY created_at, id`;
      const { lines } = await this.spend.lines({ fromMonth: month, toMonth: month });
      const left = lines.map((l) => l.amount);
      for (const r of rows) {
        const amt = Money.ofMicros(r.amount_micros, r.currency.trim());
        let used = Money.zero(USD);
        if (r.selector) {
          const baseline = Money.ofMicros(r.baseline_daily_micros ?? '0', USD);
          const byDay = new Map<string, number[]>();
          lines.forEach((l, i) => {
            if (l.day >= day(r.from_day) && lineMatches(l, r.cost_center, r.selector!)) {
              const list = byDay.get(l.day) ?? [];
              list.push(i);
              byDay.set(l.day, list);
            }
          });
          for (const d of [...byDay.keys()].sort()) {
            const idx = byDay.get(d)!;
            const avail = Money.sum(
              idx.map((i) => left[i]!),
              USD,
            );
            let take = avail.minus(baseline);
            if (take.sign() <= 0) continue;
            const room = amt.minus(used);
            if (take.compare(room) > 0) take = room;
            if (take.sign() <= 0) break;
            used = used.plus(take);
            // Take it from the day's matching lines in order, so the next reservation sees what is left.
            let rest = take;
            for (const i of idx) {
              if (rest.sign() <= 0) break;
              const part = left[i]!.compare(rest) > 0 ? rest : left[i]!;
              if (part.sign() <= 0) continue;
              left[i] = left[i]!.minus(part);
              rest = rest.minus(part);
            }
          }
        }
        if (r.status !== 'reserved') continue;
        const capped = used.compare(amt) > 0 ? amt : used;
        const full = capped.compare(amt) >= 0;
        const ended = month < current;
        if (!full && !ended && capped.micros.toString() === r.consumed_micros) continue;
        const status = full ? 'consumed' : ended ? 'released' : 'reserved';
        const note = full
          ? 'consumed: the real cost arrived'
          : ended
            ? `month ended: ${Decimal.parse(amount(capped)).toFixed(2, 'halfEven')} of ${Decimal.parse(amount(amt)).toFixed(2, 'halfEven')} used${r.selector ? '' : ' (no match selector: nothing consumes it)'}`
            : r.note;
        await this.sql.begin(async (tx) => {
          await tx`
            UPDATE reservations SET consumed_micros = ${capped.micros.toString()}, status = ${status},
              closed_at = ${status === 'reserved' ? null : now}, note = ${note}
            WHERE id = ${r.id} AND status = 'reserved'`;
          if (status !== 'reserved')
            await this.audit.append(
              {
                actor: 'reservations',
                actorKind: 'system',
                action: `reservation.${status}`,
                subjectType: 'reservation',
                subjectId: r.id,
                data: { month, consumedMicros: capped.micros.toString(), amountMicros: r.amount_micros },
              },
              tx,
            );
        });
        changed++;
      }
    }
    return changed;
  }
}
