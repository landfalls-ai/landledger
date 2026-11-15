/**
 * The weekly exceptions report and budget alerts (spec 004, review of wave 2). Exceptions: per cost center and month,
 * uncovered = actual spend (the direct layer) − the month's budget − what approved or applied requests cover. A request
 * with a `match` selector covers only the cost it selects, up to what it adds in the month (oldest request first, so
 * overlapping selectors never cover one cost twice); one without covers its cost center up to what it adds. A row when
 * the uncovered part is above the cost center's automatic threshold (the infra policy's, USD 500 by default). The
 * shared pool and Unallocated have no owner to ask: reported apart. The weekly job stores each report with the sha256
 * of its canonical JSON, audits the hash and sends `report.exceptions`. Budget alerts: `budget.at_risk` once per cost
 * center, month and state. Also listed (review of wave 3): contracts an import entered that no approved contract
 * request covers, and break-glass access whose cost request is not approved yet.
 */
import { createHash } from 'node:crypto';
import { SHARED_POOL, UNALLOCATED } from '@landledger/allocation';
import {
  CORRECTIONS,
  type ExceptionRow,
  type ExceptionsReport,
  type ExceptionsReportData,
  type StoredExceptionsReport,
} from '@landledger/contracts';
import { Money, REPORTING_CURRENCY } from '@landledger/money';
import type { AuditLog } from './audit.js';
import type { Budgets } from './budgets.js';
import type { Contracts } from './contracts.js';
import type { Sql } from './db.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';
import type { Policies } from './policies.js';
import { canonicalSnapshot, type RequestRow } from './requests.js';
import { addsInMonth, lineMatches, selectorOf } from './reservations.js';
import { addMonths, amount, ccLabel, type Spend } from './spend.js';
import type { Webhooks } from './webhooks.js';

const USD = REPORTING_CURRENCY;
const DEFAULT_THRESHOLD = '500';

export class Exceptions {
  /** Set by services: contracts entered without an approved contract request are exceptions (Decision 9). */
  contracts: Pick<Contracts, 'list'> | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly spend: Spend,
    private readonly policies: Policies,
    private readonly now: () => Date = () => new Date(),
    private readonly budgets: Budgets | null = null,
    private readonly consoleUrl = 'http://localhost:4811',
  ) {}

  async report(q: { month?: string; from?: string; to?: string }): Promise<ExceptionsReport> {
    const current = this.now().toISOString().slice(0, 7);
    const from = q.month ?? q.from ?? addMonths(current, -1);
    const to = q.month ?? q.to ?? (q.from ? q.from : current);
    if (to < from) throw new ApiError('bad_request', 'to is on or after from');
    const months: string[] = [];
    for (let m = from; m <= to && months.length < 24; m = addMonths(m, 1)) months.push(m);
    const ccs = await this.spend.costCenters();
    const approved = await this.sql<(RequestRow & { number: number })[]>`
      SELECT * FROM requests WHERE status IN ('approved', 'applied') AND change IS NULL
        AND start_day < ${`${addMonths(to, 1)}-01`} AND (end_day IS NULL OR end_day >= ${`${from}-01`})
      ORDER BY decided_at NULLS LAST, created_at, id`;
    const rows: ExceptionRow[] = [];
    const unowned: ExceptionsReport['unowned'] = [];
    const thresholds = new Map<string, Money>();
    const thresholdOf = async (code: string) => {
      if (!thresholds.has(code)) {
        const p = await this.policies.forRequest('infra_change', code).catch(() => null);
        thresholds.set(code, Money.parse(p?.automaticBelow ?? DEFAULT_THRESHOLD, USD));
      }
      return thresholds.get(code)!;
    };
    for (const month of months) {
      const { lines } = await this.spend.lines({ fromMonth: month, toMonth: month });
      const budgets = this.budgets ? await this.budgets.forMonth(month) : new Map();
      const actual = new Map<string, Money>();
      for (const l of lines) {
        if (l.correction) continue;
        actual.set(l.costCenter, (actual.get(l.costCenter) ?? Money.zero(USD)).plus(l.amount));
      }
      // What each line has left to cover, so a cost is covered once (oldest request first).
      const left = lines.map((l) => l.amount);
      for (const [code, a] of [...actual.entries()].sort(([x], [y]) => x.localeCompare(y))) {
        if (code === SHARED_POOL || code === UNALLOCATED || code === CORRECTIONS) {
          unowned.push({ month, costCenter: code, actual: amount(a) });
          continue;
        }
        const cover: { r: RequestRow & { number: number }; covers: Money; how: 'match' | 'cost_center' }[] = [];
        for (const r of approved.filter((x) => x.cost_center === code)) {
          const adds = addsInMonth(r, month);
          if (adds.isZero()) continue;
          const selector = selectorOf(r.evidence);
          if (!selector) {
            cover.push({ r, covers: adds, how: 'cost_center' });
            continue;
          }
          let rest = adds;
          let took = Money.zero(USD);
          lines.forEach((l, i) => {
            if (rest.sign() <= 0 || !lineMatches(l, code, selector) || left[i]!.sign() <= 0) return;
            const part = left[i]!.compare(rest) > 0 ? rest : left[i]!;
            left[i] = left[i]!.minus(part);
            rest = rest.minus(part);
            took = took.plus(part);
          });
          cover.push({ r, covers: took, how: 'match' });
        }
        const covered = Money.sum(
          cover.map((c) => c.covers),
          USD,
        );
        const budget = (budgets.get(code)?.amount as Money | undefined) ?? null;
        const uncovered = a.minus(budget ?? Money.zero(USD)).minus(covered);
        const threshold = await thresholdOf(code);
        if (uncovered.compare(threshold) <= 0) continue;
        rows.push({
          month,
          costCenter: code,
          name: ccLabel(code, ccs),
          owner: ccs.get(code)?.owner ?? null,
          actual: amount(a),
          budget: budget ? amount(budget) : null,
          covered: amount(covered),
          uncovered: amount(uncovered),
          threshold: amount(threshold),
          requests: cover.map((c) => ({
            id: c.r.id,
            number: `R-${c.r.number}`,
            title: c.r.title,
            amount: amount(c.covers),
            covers: c.how,
          })),
        });
      }
    }
    const contracts = this.contracts
      ? (await this.contracts.list()).contracts
          .filter((c) => c.origin === 'entered' && !c.covered)
          .map((c) => ({
            id: c.id,
            version: c.version,
            vendor: c.vendor,
            product: c.product,
            tcv: c.tcv,
            importedBy: c.importedBy,
            importedAt: c.importedAt,
          }))
      : [];
    const breakGlass = (
      await this.sql<
        { id: string; number: number; title: string; status: string; cost_center: string; amount_micros: string }[]
      >`
        SELECT id, number, title, status, cost_center, amount_micros::text AS amount_micros FROM requests
        WHERE (origin->>'breakGlass')::boolean IS TRUE AND status NOT IN ('approved', 'applied')
        ORDER BY created_at, id`
    ).map((r) => ({
      id: r.id,
      number: `R-${r.number}`,
      title: r.title,
      status: r.status,
      costCenter: r.cost_center,
      amount: amount(Money.ofMicros(r.amount_micros, USD)),
    }));
    return {
      from,
      to,
      currency: USD,
      generatedAt: this.now().toISOString(),
      rows,
      unowned,
      contracts,
      breakGlass,
    };
  }

  /**
   * The weekly job: seven days after the last, the report for last month and this one, stored with the sha256 of its
   * canonical JSON, in the audit log with that hash, and out as `report.exceptions`.
   */
  async weekly(): Promise<number> {
    const [last] = await this.sql<{ at: Date }[]>`
      SELECT at FROM audit_log WHERE action = 'exceptions.weekly_report' ORDER BY seq DESC LIMIT 1`;
    if (last && this.now().getTime() - last.at.getTime() < 7 * 24 * 3_600_000) return 0;
    const report = await this.report({});
    const sha256 = createHash('sha256').update(canonicalSnapshot(report)).digest('hex');
    const id = newId('exr');
    const data: ExceptionsReportData = {
      id,
      sha256,
      from: report.from,
      to: report.to,
      generatedAt: report.generatedAt,
      rows: report.rows.length,
      url: `${this.consoleUrl}/exceptions?report=${id}`,
    };
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO exception_reports (id, from_month, to_month, generated_at, rows, body, sha256)
        VALUES (${id}, ${report.from}, ${report.to}, ${report.generatedAt}, ${report.rows.length},
                ${tx.json(report as never)}, ${sha256})`;
      await this.audit.append(
        {
          actor: 'exceptions',
          actorKind: 'system',
          action: 'exceptions.weekly_report',
          subjectType: 'report',
          subjectId: id,
          data: {
            from: report.from,
            to: report.to,
            rows: report.rows.length,
            sha256,
            costCenters: [...new Set(report.rows.map((r) => r.costCenter))].sort(),
          },
        },
        tx,
      );
      await this.webhooks.enqueue(tx, 'report.exceptions', data);
    });
    return 0;
  }

  /** The stored weekly reports, newest first (figures only on one). */
  async reports(limit = 20): Promise<StoredExceptionsReport[]> {
    const rows = await this.sql<
      { id: string; sha256: string; from_month: string; to_month: string; generated_at: Date; rows: number }[]
    >`
      SELECT id, sha256, from_month, to_month, generated_at, rows FROM exception_reports
      ORDER BY generated_at DESC, id DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      sha256: r.sha256,
      from: r.from_month,
      to: r.to_month,
      generatedAt: r.generated_at.toISOString(),
      rows: r.rows,
    }));
  }

  /** One stored report with its figures; the sha256 recomputes from them. */
  async storedReport(id: string): Promise<StoredExceptionsReport> {
    const [r] = await this.sql<
      {
        id: string;
        sha256: string;
        from_month: string;
        to_month: string;
        generated_at: Date;
        rows: number;
        body: ExceptionsReport;
      }[]
    >`SELECT * FROM exception_reports WHERE id = ${id}`;
    if (!r) throw new ApiError('not_found', `No stored exceptions report ${id}`);
    return {
      id: r.id,
      sha256: r.sha256,
      from: r.from_month,
      to: r.to_month,
      generatedAt: r.generated_at.toISOString(),
      rows: r.rows,
      report: r.body,
    };
  }

  /** `budget.at_risk`: a cost center at risk or over this month (reservations counted), once per month and state. */
  async budgetAlerts(): Promise<number> {
    const ov = await this.spend.overview();
    let sent = 0;
    for (const c of ov.costCenters) {
      if (!c.budget || c.code === SHARED_POOL || c.code === UNALLOCATED || c.code === CORRECTIONS) continue;
      const budget = Money.parse(c.budget, USD);
      const held = Money.parse(c.monthToDate, USD).plus(Money.parse(c.reserved, USD));
      const state = c.state === 'over' || held.compare(budget) > 0 ? 'over' : c.state === 'risk' ? 'risk' : null;
      if (!state) continue;
      const data = {
        month: ov.month,
        costCenter: c.code,
        name: c.name,
        owner: c.owner,
        state,
        budget: c.budget,
        actual: c.monthToDate,
        reserved: c.reserved,
        forecast: c.forecast,
      };
      await this.sql.begin(async (tx) => {
        const rows = await tx`
          INSERT INTO budget_alerts (cost_center, month, state, data)
          VALUES (${c.code}, ${`${ov.month}-01`}, ${state}, ${tx.json(data as never)}) ON CONFLICT DO NOTHING RETURNING 1`;
        if (!rows.length) return;
        await this.webhooks.enqueue(tx, 'budget.at_risk', data);
        await this.audit.append(
          {
            actor: 'budgets',
            actorKind: 'system',
            action: 'budget.at_risk',
            subjectType: 'cost_center',
            subjectId: c.code,
            data: { month: ov.month, state },
          },
          tx,
        );
        sent++;
      });
    }
    return sent;
  }
}
