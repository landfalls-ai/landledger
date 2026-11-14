/**
 * Rate card and rule set proposals (spec 003 T010, spec 004): a change to how every figure is priced or allocated is a
 * request. A proposal writes a new version (proposed, every line or rule authored by the proposer) and raises its
 * `rate_card_change` or `rule_set_change` request, which Finance and then the CFO decide; approval applies it in the
 * approving transaction, as the last step's person, then re-prices or rebuilds the open months. The preview compares
 * the open month as booked now with the same records under the proposal, per cost center and per line or rule.
 */
import {
  allocateDirect,
  type Rule,
  type RuleSetVersion,
  type ShareRule,
  validateRuleSet,
} from '@landledger/allocation';
import type {
  ProposePolicyInput,
  ProposalCreated,
  ProposalPreview,
  RateCardProposalInput,
  RuleSetProposalInput,
} from '@landledger/contracts';
import { Decimal, Money, REPORTING_CURRENCY } from '@landledger/money';
import type { z } from 'zod';
import type { AuditLog } from './audit.js';
import { allocInputOf, type AllocRow, RECORD_COLUMNS, RULE_SET_ID, type Allocation } from './allocation.js';
import { day, type Sql, type Tx } from './db.js';
import { ApiError } from './errors.js';
import { actorOf, type Principal } from './principal.js';
import type { Policies } from './policies.js';
import type { Requests } from './requests.js';
import { amount, ccLabel, type Spend } from './spend.js';

const USD = REPORTING_CURRENCY;
const zero = () => Money.zero(USD);
type RateIn = z.output<typeof RateCardProposalInput>;
type RulesIn = z.output<typeof RuleSetProposalInput>;

const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export class Proposals {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly spend: Spend,
    private readonly allocation: Allocation,
    private readonly requests: Requests,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private openMonth() {
    return this.now().toISOString().slice(0, 7);
  }

  // Rate cards ---------------------------------------------------------------------------------------------------------

  private async currentRateCard(tx: Tx = this.sql) {
    const [v] = await tx<{ id: string; version: number; effective_from: Date; hours_per_month: string }[]>`
      SELECT id, version, effective_from, hours_per_month FROM rate_card_versions
      WHERE rate_card_id = 'rc_internal' AND approved_at IS NOT NULL ORDER BY effective_from DESC LIMIT 1`;
    if (!v) throw new ApiError('conflict', 'No rate card is approved yet: nothing to change');
    const lines = await tx<
      {
        sku_id: string;
        sku_price_id: string;
        sku_meter: string;
        label: string;
        provider: string | null;
        model: string | null;
        pricing_unit: string;
        unit_price: string;
        currency: string;
        details: Record<string, unknown> | null;
        position: number;
      }[]
    >`SELECT * FROM rate_lines WHERE version_id = ${v.id} ORDER BY position, id`;
    return { ...v, lines };
  }

  /** The open month's records at the proposed prices: Σ quantity × (new − booked unit price), from the effective day. */
  async previewRateCard(input: Pick<RateIn, 'effectiveFrom' | 'changes'>): Promise<ProposalPreview> {
    const current = await this.currentRateCard();
    const byId = new Map(current.lines.map((l) => [l.sku_price_id, l]));
    const warnings: string[] = [];
    for (const c of input.changes)
      if (!byId.has(c.skuPriceId))
        throw new ApiError('bad_request', `No line ${c.skuPriceId} in rate card v${current.version}`);
    const month = this.openMonth();
    const changed = new Map(input.changes.map((c) => [c.skuPriceId, Decimal.parse(c.unitPrice)]));
    const rows = await this.sql<
      {
        record_id: string;
        sku_price_id: string;
        pricing_quantity: string | null;
        contracted_unit_price: string | null;
        effective_cost_micros: string;
        charge_day: string;
      }[]
    >`
      SELECT record_id, sku_price_id, pricing_quantity::text, contracted_unit_price::text, effective_cost_micros::text,
             to_char(charge_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS charge_day
      FROM cost_records
      WHERE billing_period_start = ${`${month}-01T00:00:00Z`}::timestamptz AND sku_price_id = ANY(${[...changed.keys()]})`;
    const { lines } = await this.spend.lines({ fromMonth: month, toMonth: month }, false);
    const ccOf = new Map(lines.map((l) => [l.recordId, l.costCenter]));
    const ccs = await this.spend.costCenters();
    const perCc = new Map<string, { cur: Money; prop: Money }>();
    const perLine = new Map<string, { cur: Money; prop: Money; qty: Decimal }>();
    let skipped = 0;
    for (const r of rows) {
      const cur = Money.ofMicros(r.effective_cost_micros, USD);
      let prop = cur;
      if (r.charge_day >= input.effectiveFrom) {
        if (r.pricing_quantity === null || r.contracted_unit_price === null) skipped++;
        else {
          const diff = changed.get(r.sku_price_id)!.minus(r.contracted_unit_price);
          prop = cur.plus(Money.fromDecimal(diff.times(r.pricing_quantity).round(6, 'halfEven'), USD));
        }
      }
      const cc = ccOf.get(r.record_id) ?? 'UNALLOCATED';
      const a = perCc.get(cc) ?? { cur: zero(), prop: zero() };
      perCc.set(cc, { cur: a.cur.plus(cur), prop: a.prop.plus(prop) });
      const b = perLine.get(r.sku_price_id) ?? { cur: zero(), prop: zero(), qty: Decimal.ZERO };
      perLine.set(r.sku_price_id, {
        cur: b.cur.plus(cur),
        prop: b.prop.plus(prop),
        qty: b.qty.plus(r.pricing_quantity ?? '0'),
      });
    }
    if (skipped) warnings.push(`${skipped} record(s) carry no quantity or unit price and are shown unchanged`);
    if (input.effectiveFrom.slice(0, 7) > month)
      warnings.push(`It takes effect in ${monthName(input.effectiveFrom.slice(0, 7))}: the open month doesn't change`);
    if (!rows.length) warnings.push(`No record in ${monthName(month)} is priced by the changed lines yet`);
    return this.previewOf(
      month,
      `${monthName(month)} as booked, against the same usage at the proposed prices from ${input.effectiveFrom}`,
      perCc,
      [...input.changes].map((c) => {
        const l = byId.get(c.skuPriceId)!;
        const p = perLine.get(c.skuPriceId) ?? { cur: zero(), prop: zero(), qty: Decimal.ZERO };
        return {
          key: c.skuPriceId,
          label: l.label,
          detail: `${Decimal.parse(l.unit_price).toString()} → ${Decimal.parse(c.unitPrice).toString()} ${l.currency.trim()} per ${l.pricing_unit}; ${p.qty.toFixed(2, 'halfEven')} ${l.pricing_unit} this month`,
          cur: p.cur,
          prop: p.prop,
        };
      }),
      ccs,
      warnings,
    );
  }

  private previewOf(
    month: string,
    basis: string,
    perCc: Map<string, { cur: Money; prop: Money }>,
    perLine: { key: string; label: string; detail: string; cur: Money; prop: Money }[],
    ccs: Awaited<ReturnType<Spend['costCenters']>>,
    warnings: string[],
  ): ProposalPreview {
    const cur = Money.sum(
      [...perCc.values()].map((v) => v.cur),
      USD,
    );
    const prop = Money.sum(
      [...perCc.values()].map((v) => v.prop),
      USD,
    );
    return {
      month,
      currency: USD,
      basis,
      current: amount(cur),
      proposed: amount(prop),
      delta: amount(prop.minus(cur)),
      byCostCenter: [...perCc.entries()]
        .map(([code, v]) => ({
          code,
          name: ccLabel(code, ccs),
          current: amount(v.cur),
          proposed: amount(v.prop),
          delta: amount(v.prop.minus(v.cur)),
        }))
        .sort(
          (a, b) => Decimal.parse(b.delta).abs().compare(Decimal.parse(a.delta).abs()) || a.code.localeCompare(b.code),
        ),
      byLine: perLine.map((l) => ({
        key: l.key,
        label: l.label,
        detail: l.detail,
        current: amount(l.cur),
        proposed: amount(l.prop),
        delta: amount(l.prop.minus(l.cur)),
      })),
      warnings,
    };
  }

  async proposeRateCard(input: RateIn, by: Principal): Promise<ProposalCreated> {
    if (by.kind !== 'person') throw new ApiError('forbidden', 'A person proposes a rate card; an API key never does');
    const preview = await this.previewRateCard(input);
    const { requestId, versionId } = await this.sql.begin(async (tx) => {
      const current = await this.currentRateCard(tx);
      if (input.effectiveFrom <= day(current.effective_from))
        throw new ApiError(
          'bad_request',
          `A new version takes effect after v${current.version} (${day(current.effective_from)})`,
        );
      const [{ next }] = (await tx`
        SELECT coalesce(max(version), 0) + 1 AS next FROM rate_card_versions WHERE rate_card_id = 'rc_internal'`) as unknown as [
        { next: number },
      ];
      const versionId = `rcv_internal_${next}`;
      await tx`
        INSERT INTO rate_card_versions (id, rate_card_id, version, effective_from, hours_per_month, note, proposed_by)
        VALUES (${versionId}, 'rc_internal', ${next}, ${input.effectiveFrom}, ${current.hours_per_month}, ${input.note ?? ''},
                ${by.id})`;
      const changed = new Map(input.changes.map((c) => [c.skuPriceId, c.unitPrice]));
      for (const l of current.lines)
        await tx`
          INSERT INTO rate_lines (id, version_id, sku_id, sku_price_id, sku_meter, label, provider, model, pricing_unit,
                                  unit_price, currency, details, position, added_by)
          VALUES (${`rl_${next}_${l.sku_price_id.replace(/[^\w.-]+/g, '_')}`}, ${versionId}, ${l.sku_id}, ${l.sku_price_id},
                  ${l.sku_meter}, ${l.label}, ${l.provider}, ${l.model}, ${l.pricing_unit},
                  ${changed.get(l.sku_price_id) ?? l.unit_price}::numeric, ${l.currency}, ${l.details ? tx.json(l.details as never) : null},
                  ${l.position}, ${by.id})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'rate_card.version_proposed',
          subjectType: 'rate_card_version',
          subjectId: versionId,
          data: { version: Number(next), effectiveFrom: input.effectiveFrom, changes: input.changes.length },
        },
        tx,
      );
      const requestId = await this.requests.raiseChange(
        tx,
        {
          kind: 'rate_card_change',
          title: input.title ?? `Rate card v${next} from ${input.effectiveFrom}`,
          note: input.note ?? '',
          change: { type: 'rate_card_version', versionId },
          evidence: {
            changes: input.changes,
            preview: {
              month: preview.month,
              current: preview.current,
              proposed: preview.proposed,
              delta: preview.delta,
            },
          },
          start: input.effectiveFrom,
        },
        by,
      );
      return { requestId, versionId };
    });
    await this.requests.submitById(requestId, actorOf(by));
    return { request: await this.requests.view(requestId, by), versionId, preview };
  }

  // Rule sets ------------------------------------------------------------------------------------------------------------

  async previewRuleSet(input: Pick<RulesIn, 'effectiveFrom' | 'rules' | 'shares'>): Promise<ProposalPreview> {
    const rules = input.rules as unknown as Rule[];
    const shares = (input.shares ?? []) as unknown as ShareRule[];
    const costCenters = new Set(
      (await this.sql<{ code: string }[]>`SELECT DISTINCT code FROM cost_centers`).map((r) => r.code),
    );
    const problems = validateRuleSet({ rules, shares }, costCenters);
    if (problems.length) throw new ApiError('bad_request', `The rule set doesn't hold: ${problems.join('; ')}`);
    const month = this.openMonth();
    const book = await this.allocation.book();
    const records = await this.sql<AllocRow[]>`
      SELECT ${this.sql.unsafe(RECORD_COLUMNS)} FROM cost_records
      WHERE billing_period_start = ${`${month}-01T00:00:00Z`}::timestamptz`;
    const inputs = records.map(allocInputOf);
    const proposed: RuleSetVersion = { id: 'proposal', rules, shares };
    const now = allocateDirect(inputs, (d) => book.versionOn(d));
    const next = allocateDirect(inputs, (d) => (d >= input.effectiveFrom ? proposed : book.versionOn(d)));
    const ccs = await this.spend.costCenters();
    const perCc = new Map<string, { cur: Money; prop: Money }>();
    // Per rule: what it catches under the rules in effect, and under the proposal.
    const perRule = new Map<string, { cur: Money; prop: Money; n: number }>();
    const rule = (key: string) => perRule.get(key) ?? { cur: zero(), prop: zero(), n: 0 };
    const add = (cc: string, cur: Money, prop: Money) => {
      const a = perCc.get(cc) ?? { cur: zero(), prop: zero() };
      perCc.set(cc, { cur: a.cur.plus(cur), prop: a.prop.plus(prop) });
    };
    now.forEach((row, i) => {
      const p = next[i]!;
      add(row.costCenter, row.amount, zero());
      add(p.costCenter, zero(), p.amount);
      const was = row.ruleId ?? '(none)';
      const is = p.ruleId ?? '(none)';
      perRule.set(was, { ...rule(was), cur: rule(was).cur.plus(row.amount) });
      perRule.set(is, { ...rule(is), prop: rule(is).prop.plus(p.amount), n: rule(is).n + 1 });
    });
    const warnings: string[] = [];
    if (input.effectiveFrom.slice(0, 7) > month)
      warnings.push(`It takes effect in ${monthName(input.effectiveFrom.slice(0, 7))}: the open month doesn't change`);
    if (!records.length) warnings.push(`${monthName(month)} has no records yet`);
    return this.previewOf(
      month,
      `${monthName(month)} allocated by the rules in effect, against the proposed rules from ${input.effectiveFrom} (direct layer)`,
      perCc,
      [...perRule.entries()].map(([key, v]) => {
        const r = rules.find((x) => x.id === key);
        return {
          key,
          label:
            r?.name ??
            (key === 'idle'
              ? 'Idle (shared pool)'
              : key === '(none)'
                ? 'No rule matches (Unallocated)'
                : `${key} (rules in effect)`),
          detail: `${v.n} record(s) under the proposal${r?.target ? ` → ${r.target.costCenter}` : r?.shared ? ' → shared pool' : ''}`,
          cur: v.cur,
          prop: v.prop,
        };
      }),
      ccs,
      warnings,
    );
  }

  async proposeRuleSet(input: RulesIn, by: Principal): Promise<ProposalCreated> {
    if (by.kind !== 'person')
      throw new ApiError('forbidden', 'A person proposes allocation rules; an API key never does');
    const preview = await this.previewRuleSet(input);
    const { requestId, versionId } = await this.sql.begin(async (tx) => {
      const [cur] = await tx<{ version: number; effective_from: Date }[]>`
        SELECT version, effective_from FROM allocation_rule_set_versions
        WHERE rule_set_id = ${RULE_SET_ID} AND approved_at IS NOT NULL ORDER BY effective_from DESC LIMIT 1`;
      if (cur && input.effectiveFrom <= day(cur.effective_from))
        throw new ApiError(
          'bad_request',
          `A new version takes effect after v${cur.version} (${day(cur.effective_from)})`,
        );
      const [{ next }] = (await tx`
        SELECT coalesce(max(version), 0) + 1 AS next FROM allocation_rule_set_versions WHERE rule_set_id = ${RULE_SET_ID}`) as unknown as [
        { next: number },
      ];
      const versionId = `rsv_main_${next}`;
      await tx`
        INSERT INTO allocation_rule_set_versions (id, rule_set_id, version, effective_from, rules, shares, note, proposed_by)
        VALUES (${versionId}, ${RULE_SET_ID}, ${next}, ${input.effectiveFrom}, ${tx.json(input.rules as never)},
                ${tx.json((input.shares ?? []) as never)}, ${input.note ?? ''}, ${by.id})`;
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'allocation.rule_set_proposed',
          subjectType: 'allocation_rule_set_version',
          subjectId: versionId,
          data: { version: Number(next), effectiveFrom: input.effectiveFrom, rules: input.rules.length },
        },
        tx,
      );
      const requestId = await this.requests.raiseChange(
        tx,
        {
          kind: 'rule_set_change',
          title: input.title ?? `Allocation rules v${next} from ${input.effectiveFrom}`,
          note: input.note ?? '',
          change: { type: 'rule_set_version', versionId },
          evidence: {
            rules: input.rules.length,
            preview: { month: preview.month, delta: preview.delta, byCostCenter: preview.byCostCenter },
          },
          start: input.effectiveFrom,
        },
        by,
      );
      return { requestId, versionId };
    });
    await this.requests.submitById(requestId, actorOf(by));
    return { request: await this.requests.view(requestId, by), versionId, preview };
  }

  /** `POST /api/policies`: a proposed policy version and its `policy_change` request (Finance, then the CFO). */
  async proposePolicy(input: z.output<typeof ProposePolicyInput>, policies: Policies, by: Principal) {
    if (by.kind !== 'person') throw new ApiError('forbidden', 'A person proposes a policy; an API key never does');
    const def = policies.validate(input.policy);
    const { requestId, versionId } = await this.sql.begin(async (tx) => {
      const v = await policies.proposeIn(tx, def, input.note ?? '', by.id);
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'policy.proposed',
          subjectType: 'policy',
          subjectId: v.id,
          data: { kind: def.kind, costCenter: def.costCenter, version: v.version, steps: def.steps.map((s) => s.key) },
        },
        tx,
      );
      const requestId = await this.requests.raiseChange(
        tx,
        {
          kind: 'policy_change',
          title:
            input.title ??
            `Approval policy for ${def.kind.replace(/_/g, ' ')}${def.costCenter ? ` (${def.costCenter})` : ''}, v${v.version}`,
          note: input.note ?? '',
          change: { type: 'policy', policyId: v.id },
          evidence: { policy: def as unknown as Record<string, unknown> },
          start: this.now().toISOString().slice(0, 10),
        },
        by,
      );
      return { requestId, versionId: v.id };
    });
    await this.requests.submitById(requestId, actorOf(by));
    return { request: await this.requests.view(requestId, by), versionId };
  }

  /** A version proposed before wave 2 has no request: raise one (the proposer is its requester), so it can be decided. */
  /**
   * The request for a version proposed before approvals became requests, raised on first call. Only a signed-in person
   * with `requests:write` calls it (the route checks); the request is the proposer's, and the audit log names the caller.
   */
  async requestForVersion(
    type: 'rate_card_version' | 'rule_set_version',
    versionId: string,
    by: Principal,
  ): Promise<string> {
    if (by.kind !== 'person')
      throw new ApiError(
        'forbidden',
        "A person signed in with Landbright raises a version's request; an API key doesn't",
      );
    const existing = await this.requests.forChange(type, versionId);
    if (existing) return existing;
    const table = type === 'rate_card_version' ? 'rate_card_versions' : 'allocation_rule_set_versions';
    const [v] = await this.sql<
      { version: number; effective_from: Date; proposed_by: string; approved_at: Date | null }[]
    >`
      SELECT version, effective_from, proposed_by, approved_at FROM ${this.sql(table)} WHERE id = ${versionId}`;
    if (!v) throw new ApiError('not_found', 'Version not found');
    if (v.approved_at) throw new ApiError('conflict', `Version ${v.version} is already approved`);
    const [u] = await this.sql<{ id: string; kind: string; email: string | null; name: string }[]>`
      SELECT id, kind, email, name FROM users WHERE id = ${v.proposed_by}`;
    if (!u || u.kind !== 'person')
      throw new ApiError(
        'conflict',
        `Version ${v.version} was proposed by ${v.proposed_by}, not a person: propose the change again from Rates and rules`,
      );
    const person: Principal = {
      kind: 'person',
      id: u.id,
      name: u.name,
      email: u.email,
      roles: [],
      groups: [],
      scopes: [],
    };
    const id = await this.sql.begin((tx) =>
      this.requests.raiseChange(
        tx,
        {
          kind: type === 'rate_card_version' ? 'rate_card_change' : 'rule_set_change',
          title: `${type === 'rate_card_version' ? 'Rate card' : 'Allocation rules'} v${v.version} from ${day(v.effective_from)}`,
          note: 'Proposed before approvals became requests (wave 2): raised for its decision.',
          change: { type, versionId },
          evidence: {},
          start: day(v.effective_from),
        },
        person,
        by,
      ),
    );
    await this.requests.submitById(id as string, actorOf(by));
    return id as string;
  }
}
