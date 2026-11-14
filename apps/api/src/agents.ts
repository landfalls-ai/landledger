/**
 * Agents' unit economics (spec 008): each AI agent's month as a unit. Cost from the ledger (Landflow's usage by the
 * `agent` tag, invoiced where an invoice replaced the estimate); runs, outcomes and value from Clickland's Agent Value,
 * matched by name within Landflow's service; cost per outcome, capacity freed (labelled capacity, not cash), the cost
 * center most of its cost goes to and that cost center's owner, and a suggestion (keep, scale, review, retire) with the
 * rule that gave it. An owner decides; Landledger only suggests.
 */
import type { AgentEconomics, AgentRow, AgentSuggestion, AgentsView } from '@landledger/contracts';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import { z } from 'zod';
import { addMonths, amount, ccLabel, monthDays, type Spend } from './spend.js';

const USD = REPORTING_CURRENCY;
const AI = 'AI and Machine Learning';

// Clickland's Agent Value ---------------------------------------------------------------------------------------------

const ValueReport = z.object({
  hourlyRate: z.number(),
  currency: z.string().optional(),
  agents: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      service: z.string(),
      family: z.string().optional(),
      value: z.number(),
      cost: z.number().nullable().optional(),
      outcomes: z.number(),
      adoption: z.object({ runs: z.number() }).partial().optional(),
      quality: z.object({ successRate: z.number().nullable() }).partial().optional(),
    }),
  ),
});
export type ValueReport = z.infer<typeof ValueReport>;

/** Clickland's `GET /api/agents/value`, with a `read` key; cached five minutes per window, 15 s timeout. */
export class AgentValueClient {
  private cache = new Map<string, { at: number; report: ValueReport }>();
  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async report(from: Date, to: Date): Promise<ValueReport> {
    const k = `${from.toISOString()}|${to.toISOString()}`;
    const hit = this.cache.get(k);
    if (hit && this.now() - hit.at < 300_000) return hit.report;
    const qs = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    const res = await this.fetchImpl(`${this.url}/api/agents/value?${qs}`, {
      headers: { authorization: `Bearer ${this.key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Clickland /api/agents/value answered ${res.status}`);
    const report = ValueReport.parse(await res.json());
    this.cache.set(k, { at: this.now(), report });
    return report;
  }
}

// The suggestion (pure) -----------------------------------------------------------------------------------------------

export interface SuggestInput {
  runs: number | null;
  outcomes: number | null;
  /** 0–1; null when Clickland can't say. */
  successRate: number | null;
  cost: Money;
  /** Clickland's value (capacity, not cash); null without a match. */
  value: Money | null;
}

const pct = (r: number) => `${Math.round(r * 100)}%`;
const $ = (m: Money) => `$${m.toDecimal().toFixed(2, 'halfEven')}`;

/**
 * The first rule that holds: retire (10 or more runs, no outcome); review (one outcome costs more than it is worth, or
 * under 80% of 5 or more runs succeed); scale (10 or more outcomes, value at least 5 × cost, 90% or more succeed);
 * keep (otherwise, including too little to say).
 */
export function suggest(x: SuggestInput): { suggestion: AgentSuggestion; why: string } {
  if (x.runs === null || x.outcomes === null || x.value === null)
    return { suggestion: 'keep', why: 'Keep: no runs or outcomes known for it (no match in Clickland’s Agent Value)' };
  if (x.runs >= 10 && x.outcomes === 0)
    return {
      suggestion: 'retire',
      why: `Retire: ${x.runs} runs this month and no outcome (rule: 10 or more runs, none)`,
    };
  if (x.outcomes > 0 && x.cost.compare(x.value) > 0)
    return {
      suggestion: 'review',
      why: `Review: an outcome costs more than it is worth (${$(x.cost)} for ${$(x.value)} of capacity)`,
    };
  if (x.successRate !== null && x.runs >= 5 && x.successRate < 0.8)
    return {
      suggestion: 'review',
      why: `Review: ${pct(x.successRate)} of ${x.runs} runs succeeded (rule: under 80% of 5 or more)`,
    };
  if (
    x.outcomes >= 10 &&
    x.value.compare(Money.fromDecimal(x.cost.toDecimal().times('5'), USD)) >= 0 &&
    (x.successRate === null || x.successRate >= 0.9)
  )
    return {
      suggestion: 'scale',
      why: `Scale: ${x.outcomes} outcomes, worth ${$(x.value)} for ${$(x.cost)}${x.successRate !== null ? `, ${pct(x.successRate)} succeeded` : ''} (rule: 10 or more outcomes, value ≥ 5 × cost, 90% or more succeed)`,
    };
  return {
    suggestion: 'keep',
    why:
      x.runs < 10 && x.outcomes < 10
        ? `Keep: ${x.runs} runs and ${x.outcomes} outcomes, too few to say more`
        : `Keep: no rule to retire, review or scale holds`,
  };
}

const per = (m: Money, n: number | null) =>
  n && n > 0 ? amount(Money.fromDecimal(m.toDecimal().divide(String(n), 6, 'halfEven'), USD)) : null;
const fromNumber = (n: number) => Money.parse(Decimal.parse(n.toFixed(6)).toString(), USD);

// Agents --------------------------------------------------------------------------------------------------------------

export class Agents {
  constructor(
    private readonly spend: Spend,
    private readonly value: AgentValueClient | null,
    /** Landflow's service in Clickland's telemetry (`landflow-host`): agents are matched by name inside it. */
    private readonly landflowService: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async view(month?: string): Promise<AgentsView> {
    const today = this.now().toISOString().slice(0, 10);
    const m = month ?? today.slice(0, 7);
    const from = `${m}-01`;
    const last = `${m}-${String(monthDays(m)).padStart(2, '0')}`;
    const to = last < today ? last : today;
    const { lines } = await this.spend.lines({ fromMonth: m, toMonth: m });
    const ccs = await this.spend.costCenters();
    interface Acc {
      name: string;
      models: Money;
      compute: Money;
      anyCompute: boolean;
      invoiced: Money;
      byCc: Map<string, Money>;
    }
    const acc = new Map<string, Acc>();
    for (const l of lines) {
      const id = typeof l.tags.agent === 'string' ? l.tags.agent : '';
      if (!id) continue;
      const a = acc.get(id) ?? {
        name: (typeof l.tags.agentName === 'string' && l.tags.agentName) || id,
        models: Money.zero(USD),
        compute: Money.zero(USD),
        anyCompute: false,
        invoiced: Money.zero(USD),
        byCc: new Map<string, Money>(),
      };
      if (l.serviceCategory === AI) a.models = a.models.plus(l.amount);
      else {
        a.compute = a.compute.plus(l.amount);
        a.anyCompute = true;
      }
      if (l.basis === 'invoiced') a.invoiced = a.invoiced.plus(l.amount);
      a.byCc.set(l.costCenter, (a.byCc.get(l.costCenter) ?? Money.zero(USD)).plus(l.amount));
      acc.set(id, a);
    }

    let clickland: AgentsView['clickland'];
    let report: ValueReport | null = null;
    if (!this.value)
      clickland = {
        status: 'unconfigured',
        hourlyRate: null,
        note: 'No Clickland key for Agent Value (LANDLEDGER_CLICKLAND_VALUE_KEY): cost only',
      };
    else
      try {
        report = await this.value.report(
          new Date(`${from}T00:00:00Z`),
          new Date(Math.min(Date.parse(`${addMonths(m, 1)}-01T00:00:00Z`), this.now().getTime())),
        );
        clickland = {
          status: 'ok',
          hourlyRate: report.hourlyRate.toFixed(2),
          note: `Runs, outcomes and value from Clickland’s Agent Value, ${from} to ${to}, matched by name in ${this.landflowService}; value is capacity at $${report.hourlyRate.toFixed(2)} an hour, not cash`,
        };
      } catch (e) {
        clickland = {
          status: 'unavailable',
          hourlyRate: null,
          note: `Clickland’s Agent Value did not answer (${(e as Error).message}): cost only`,
        };
      }
    const valued = (report?.agents ?? []).filter((v) => v.service === this.landflowService);
    const byName = new Map(valued.map((v) => [v.name.toLowerCase(), v]));
    const matched = new Set<string>();
    const rows: AgentRow[] = [];
    const row = (id: string, name: string, a: Acc | null, v: ValueReport['agents'][number] | null): AgentRow => {
      const models = a?.models ?? Money.zero(USD);
      const total = models.plus(a?.compute ?? Money.zero(USD));
      const topCc = a ? [...a.byCc.entries()].sort((x, y) => y[1].compare(x[1]))[0]?.[0] : undefined;
      const value = v ? fromNumber(v.value) : null;
      const outcomes = v ? v.outcomes : null;
      const runs = v ? (v.adoption?.runs ?? 0) : null;
      const successRate = v?.quality?.successRate ?? null;
      const s = suggest({ runs, outcomes, successRate, cost: total, value });
      return {
        id,
        name,
        cost: {
          total: amount(total),
          models: amount(models),
          compute: a?.anyCompute ? amount(a.compute) : null,
          invoiced: amount(a?.invoiced ?? Money.zero(USD)),
        },
        costCenter: topCc ? { code: topCc, name: ccLabel(topCc, ccs) } : null,
        owner: topCc ? (ccs.get(topCc)?.owner ?? null) : null,
        value: v
          ? {
              runs: runs ?? 0,
              outcomes: v.outcomes,
              successRate: successRate === null ? null : successRate.toFixed(2),
              value: amount(value!),
              hoursSaved: report && report.hourlyRate > 0 ? (v.value / report.hourlyRate).toFixed(2) : '0.00',
              clicklandKey: v.key,
            }
          : null,
        costPerOutcome: per(total, outcomes),
        valuePerOutcome: value ? per(value, outcomes) : null,
        suggestion: s.suggestion,
        why: a ? s.why : `${s.why}. Landledger has no cost for it in ${m}`,
      };
    };
    for (const [id, a] of acc) {
      const v = byName.get(a.name.toLowerCase()) ?? null;
      if (v) matched.add(v.key);
      rows.push(row(id, a.name, a, v));
    }
    for (const v of valued) if (!matched.has(v.key)) rows.push(row(v.key, v.name, null, v));
    rows.sort((x, y) => Decimal.parse(y.cost.total).compare(x.cost.total) || x.name.localeCompare(y.name));
    const sum = (f: (r: AgentRow) => string | null | undefined) =>
      amount(
        Money.sum(
          rows.map((r) => Money.parse(f(r) ?? '0', USD)),
          USD,
        ),
      );
    const hours = rows.reduce((h, r) => h.plus(r.value?.hoursSaved ?? '0'), Decimal.ZERO);
    return {
      month: m,
      from,
      to,
      currency: USD,
      agents: rows,
      totals: {
        cost: sum((r) => r.cost.total),
        invoiced: sum((r) => r.cost.invoiced),
        outcomes: rows.reduce((n, r) => n + (r.value?.outcomes ?? 0), 0),
        hoursSaved: hours.toFixed(2, 'halfEven'),
        capacity: sum((r) => r.value?.value),
      },
      clickland,
      computeNote:
        'Compute is not attributed to agents yet: workloads carry no agent label, so only model cost is shown (not zero compute)',
    };
  }

  /** An AI budget request's evidence (spec 008): the agent's month, and what the monthly amount buys at its rate. */
  async economics(agentId: string, month: string, monthly: Money): Promise<AgentEconomics | null> {
    const v = await this.view(month);
    const r = v.agents.find((a) => a.id === agentId);
    if (!r) return null;
    const cpo = r.costPerOutcome ? Money.parse(r.costPerOutcome, USD) : null;
    return {
      agentId,
      name: r.name,
      month,
      cost: r.cost.total,
      outcomes: r.value?.outcomes ?? null,
      costPerOutcome: r.costPerOutcome,
      valuePerOutcome: r.valuePerOutcome,
      suggestion: r.suggestion,
      why: r.why,
      buys: cpo && !cpo.isZero() ? monthly.toDecimal().divide(cpo.toDecimal(), 1, 'halfEven').toString() : null,
      source: v.clickland.note,
    };
  }
}
