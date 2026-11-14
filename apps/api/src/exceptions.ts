/**
 * The weekly exceptions report and budget alerts (spec 004). Exceptions: per cost center and month, actual spend (the
 * direct layer) less what approved or applied requests cover in that month; a row when the uncovered part is above
 * the cost center's automatic threshold (the infra policy's, USD 500 by default). The shared pool and Unallocated have
 * no owner to ask: reported apart. Budget alerts: `budget.at_risk` once per cost center, month and state.
 */
import { SHARED_POOL, UNALLOCATED } from '@landledger/allocation';
import { CORRECTIONS, type ExceptionRow, type ExceptionsReport } from '@landledger/contracts';
import { Money, REPORTING_CURRENCY } from '@landledger/money';
import type { AuditLog } from './audit.js';
import type { Sql } from './db.js';
import { ApiError } from './errors.js';
import type { Policies } from './policies.js';
import type { RequestRow } from './requests.js';
import { addsInMonth } from './reservations.js';
import { addMonths, amount, ccLabel, type Spend } from './spend.js';
import type { Webhooks } from './webhooks.js';

const USD = REPORTING_CURRENCY;
const DEFAULT_THRESHOLD = '500';

export class Exceptions {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly webhooks: Webhooks,
    private readonly spend: Spend,
    private readonly policies: Policies,
    private readonly now: () => Date = () => new Date(),
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
        AND start_day < ${`${addMonths(to, 1)}-01`} AND (end_day IS NULL OR end_day >= ${`${from}-01`})`;
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
      const actual = new Map<string, Money>();
      for (const l of lines) {
        if (l.correction) continue;
        actual.set(l.costCenter, (actual.get(l.costCenter) ?? Money.zero(USD)).plus(l.amount));
      }
      for (const [code, a] of [...actual.entries()].sort(([x], [y]) => x.localeCompare(y))) {
        if (code === SHARED_POOL || code === UNALLOCATED || code === CORRECTIONS) {
          unowned.push({ month, costCenter: code, actual: amount(a) });
          continue;
        }
        const cover = approved
          .filter((r) => r.cost_center === code)
          .map((r) => ({ r, adds: addsInMonth(r, month) }))
          .filter((c) => !c.adds.isZero());
        const covered = Money.sum(
          cover.map((c) => c.adds),
          USD,
        );
        const uncovered = a.minus(covered);
        const threshold = await thresholdOf(code);
        if (uncovered.compare(threshold) <= 0) continue;
        rows.push({
          month,
          costCenter: code,
          name: ccLabel(code, ccs),
          owner: ccs.get(code)?.owner ?? null,
          actual: amount(a),
          covered: amount(covered),
          uncovered: amount(uncovered),
          threshold: amount(threshold),
          requests: cover.map((c) => ({
            id: c.r.id,
            number: `R-${c.r.number}`,
            title: c.r.title,
            amount: amount(c.adds),
          })),
        });
      }
    }
    return { from, to, currency: USD, generatedAt: this.now().toISOString(), rows, unowned };
  }

  /** The weekly job: once seven days after the last one, the report for last month and this one, in the audit log. */
  async weekly(): Promise<number> {
    const [last] = await this.sql<{ at: Date }[]>`
      SELECT at FROM audit_log WHERE action = 'exceptions.weekly_report' ORDER BY seq DESC LIMIT 1`;
    if (last && this.now().getTime() - last.at.getTime() < 7 * 24 * 3_600_000) return 0;
    const report = await this.report({});
    await this.audit.append({
      actor: 'exceptions',
      actorKind: 'system',
      action: 'exceptions.weekly_report',
      subjectType: 'report',
      subjectId: `exceptions-${report.from}-${report.to}`,
      data: {
        from: report.from,
        to: report.to,
        rows: report.rows.length,
        costCenters: [...new Set(report.rows.map((r) => r.costCenter))].sort(),
      },
    });
    return 0;
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
