/**
 * Invoices and reconciliation (spec 005). A provider's invoice comes in as a CSV; each Usage line group (provider ×
 * model) is split over the live estimates it replaces and posted as `invoiced` records linked to them, so no read ever
 * adds an estimate to the invoice that replaced it. A group with no estimate, and every other line, posts on its own.
 * For a locked month the true-up (invoiced − estimated) is booked in the open month as a Correction. Importing the same
 * invoice again corrects by reversal and re-entry; voiding reverses it whole. Reconciliation compares, per provider,
 * model and month, every live estimate with what was invoiced.
 */
import {
  type InvoiceLineView,
  type InvoiceView,
  type ReconcileStatus,
  type ReconciliationRow,
  type ReconciliationView,
  type RequestLifecycle,
} from '@landledger/contracts';
import {
  assertValid,
  billingPeriod,
  type CostRecord,
  type CostRow,
  correct,
  fromRow,
  monthStart,
  nextMonth,
  type ChargeCategory,
  toRow,
} from '@landledger/focus';
import { Decimal, isUnit, Money, REPORTING_CURRENCY, split } from '@landledger/money';
import type { AuditLog } from './audit.js';
import type { Config } from './config.js';
import { readCsv } from './csv.js';
import { day, type Sql, type Tx } from './db.js';
import { ApiError, notFound } from './errors.js';
import { newId, sha256 } from './ids.js';
import { actorOf, type Principal } from './principal.js';
import { addsInMonth, lineMatches, selectorOf } from './reservations.js';
import { addMonths, amount, type Spend } from './spend.js';

const USD = REPORTING_CURRENCY;
const zero = () => Money.zero(USD);
const CATEGORIES = ['Usage', 'Purchase', 'Tax', 'Credit', 'Adjustment'] as const;
const AMOUNT = /^-?\d+(\.\d{1,6})?$/;
const QUANTITY = /^\d+(\.\d{1,9})?$/;
/** Lines naming no model (a SKU only) reconcile under this name. */
export const OTHER_CHARGES = '(other charges)';

// Parsing ------------------------------------------------------------------------------------------------------------

export interface InvoiceLine {
  line: number;
  model: string | null;
  sku: string | null;
  quantity: Decimal | null;
  unit: string | null;
  amount: Money;
  chargeCategory: ChargeCategory;
  description: string;
}

export interface ParsedInvoice {
  provider: string;
  /** Lower case: how estimates name the provider (`tags.provider`). */
  providerKey: string;
  number: string;
  month: string;
  lines: InvoiceLine[];
}

/**
 * Parses and validates an invoice CSV: every problem at once, with its line number; a non-USD line makes the whole
 * file `currency` (the route answers 422). Lines are grouped into invoices by provider and number.
 */
export function parseInvoiceCsv(
  csv: string,
  today: string,
): { invoices: ParsedInvoice[]; problems: string[]; currency: string[] } {
  const { rows, problems } = readCsv(
    csv,
    ['provider', 'invoice_number', 'period', 'model', 'sku', 'quantity', 'unit', 'amount', 'currency'],
    ['charge_category', 'description'],
  );
  const currency: string[] = [];
  const byKey = new Map<string, ParsedInvoice>();
  for (const r of rows) {
    const at = `Line ${r.line}`;
    const provider = r.get('provider');
    const number = r.get('invoice_number');
    const period = r.get('period');
    const model = r.get('model') || null;
    const sku = r.get('sku') || null;
    const qty = r.get('quantity');
    const unit = r.get('unit') || null;
    const amt = r.get('amount');
    const cur = r.get('currency').toUpperCase();
    const category = (r.get('charge_category') || 'Usage') as ChargeCategory;
    const before = problems.length;
    if (!provider) problems.push(`${at}: provider is empty`);
    if (!number) problems.push(`${at}: invoice_number is empty`);
    const month = /^\d{4}-(0[1-9]|1[0-2])(-01)?$/.test(period) ? period.slice(0, 7) : null;
    if (!month) problems.push(`${at}: period "${period}" is not a month (YYYY-MM)`);
    else if (month > today.slice(0, 7)) problems.push(`${at}: period ${month} hasn't started yet`);
    if (!model && !sku) problems.push(`${at}: a line names a model or a sku`);
    if (cur !== 'USD') {
      currency.push(`${at}: currency "${r.get('currency')}" — only USD until FX is set up`);
      continue;
    }
    if (!CATEGORIES.includes(category))
      problems.push(`${at}: charge_category "${category}" is one of ${CATEGORIES.join(', ')}`);
    if (!AMOUNT.test(amt)) problems.push(`${at}: amount "${amt}" is a decimal with at most six decimals`);
    else if (amt.startsWith('-') && category !== 'Credit' && category !== 'Adjustment')
      problems.push(`${at}: a negative amount is a Credit or an Adjustment`);
    if (qty && !QUANTITY.test(qty)) problems.push(`${at}: quantity "${qty}" is a non-negative decimal`);
    if (unit && !isUnit(unit)) problems.push(`${at}: unit "${unit}" is not a FOCUS unit (Tokens, 1000000 Tokens)`);
    if ((qty === '') !== (unit === null)) problems.push(`${at}: quantity and unit go together`);
    if (category === 'Usage' && !qty) problems.push(`${at}: a Usage line has a quantity and a unit`);
    if (problems.length > before || !month) continue;
    const key = `${provider.toLowerCase()}\u0000${number}`;
    const inv = byKey.get(key) ?? { provider, providerKey: provider.toLowerCase(), number, month, lines: [] };
    if (inv.month !== month) {
      problems.push(`${at}: invoice ${number} is for ${inv.month}; one invoice covers one month`);
      continue;
    }
    inv.lines.push({
      line: r.line,
      model,
      sku,
      quantity: qty ? Decimal.parse(qty) : null,
      unit,
      amount: Money.parse(amt, USD),
      chargeCategory: category,
      description: r.get('description'),
    });
    byKey.set(key, inv);
  }
  return { invoices: [...byKey.values()], problems, currency };
}

// Posting (pure, property-tested) --------------------------------------------------------------------------------------

export interface EstimateShare {
  key: string;
  cost: Money;
  quantity: Decimal | null;
}

/**
 * Splits an invoiced amount over the estimates it replaces: by their estimated cost; by quantity when every estimate is
 * zero (and each has one); equally otherwise. The parts sum exactly to the amount (`split`, largest remainder).
 */
export function splitOverEstimates(total: Money, estimates: readonly EstimateShare[]): Money[] {
  if (!estimates.length) return [];
  const costs = estimates.map((e) => e.cost.abs().toDecimal());
  if (costs.some((c) => !c.isZero())) return split(total, costs);
  const qty = estimates.map((e) => e.quantity?.abs() ?? null);
  if (qty.every((q) => q !== null) && qty.some((q) => !q!.isZero())) return split(total, qty as Decimal[]);
  return split(
    total,
    estimates.map(() => 1n),
  );
}

/** A record as the read rule sees it (spend.ts): an estimate drops out while its key is linked to a live invoice. */
export interface ShownRecord {
  key: string;
  basis: 'estimated' | 'invoiced';
  amount: Money;
  /** For an estimate: the invoiced keys linked to it. */
  linkedTo: readonly string[];
}

/** What every figure shows: each charge once (the property spec 005 tests). */
export function shownTotal(records: readonly ShownRecord[]): Money {
  const live = new Set(records.filter((r) => r.basis === 'invoiced').map((r) => r.key));
  return Money.sum(
    records.filter((r) => r.basis === 'invoiced' || !r.linkedTo.some((k) => live.has(k))).map((r) => r.amount),
    USD,
  );
}

/** Variance and status of one provider × model × month (spec 005). */
export function reconcile(
  estimated: Money,
  invoiced: Money,
  counts: { estimates: number; invoiced: number },
  tolerancePct: string,
): { variance: Money; variancePct: string | null; status: ReconcileStatus; within: boolean } {
  const variance = invoiced.minus(estimated);
  const variancePct = estimated.isZero()
    ? null
    : variance.toDecimal().times('100').divide(estimated.toDecimal(), 1, 'halfEven').toString();
  // |variance| ≤ tolerance% × |estimated|, compared exactly: |variance| × 100 ≤ tolerance × |estimated|.
  const within = variance.abs().toDecimal().times('100').compare(estimated.abs().toDecimal().times(tolerancePct)) <= 0;
  const status: ReconcileStatus =
    counts.invoiced === 0 ? 'not_invoiced' : counts.estimates === 0 ? 'no_estimate' : within ? 'matched' : 'outside';
  return { variance, variancePct, status, within };
}

// The service ----------------------------------------------------------------------------------------------------------

interface InvoiceRow {
  id: string;
  version: number;
  provider: string;
  number: string;
  month: Date;
  status: 'posted' | 'voided';
  origin: 'entered' | 'dev-fixture';
  total_micros: string;
  correction: boolean;
  added: number;
  reversed: number;
  unchanged: number;
  linked: number;
  file_sha256: string;
  note: string;
  imported_by: string;
  imported_at: Date;
  importer?: string | null;
}

interface LineRow {
  invoice_id: string;
  version: number;
  line: number;
  model: string | null;
  sku: string | null;
  quantity: string | null;
  unit: string | null;
  amount_micros: string;
  charge_category: InvoiceLineView['chargeCategory'];
  description: string;
}

const invoiceId = (providerKey: string, number: string) => `inv_${sha256(`${providerKey}:${number}`).slice(0, 20)}`;
const prefixOf = (providerKey: string, number: string) => `invoice:${providerKey}:${number}:`;
const modelKey = (m: string | null) => (m ?? OTHER_CHARGES).toLowerCase();
/** What makes two invoiced records the same: re-importing an unchanged line leaves it alone. */
const fingerprint = (r: CostRecord) =>
  [
    r.EffectiveCost.micros,
    r.ChargeCategory,
    r.ChargeClass ?? '',
    r.ConsumedQuantity?.toString() ?? '',
    r.ConsumedUnit ?? '',
    r.ChargePeriodStart,
    r.BillingPeriodStart,
    r.ChargeDescription ?? '',
  ].join('|');

const LIVE = `NOT EXISTS (SELECT 1 FROM cost_record_keys x WHERE x.correction_of_id = r.record_id) AND r.correction_of_id IS NULL`;

export class Invoices {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly spend: Spend,
    private readonly config: Pick<Config, 'reconcileTolerancePct'>,
    private readonly now: () => Date = () => new Date(),
    /** Called with the months records landed in, so they are allocated (services: allocation.allocatePending). */
    private readonly afterPost: (months: string[]) => Promise<void> = async () => {},
  ) {}

  private get tolerance() {
    return this.config.reconcileTolerancePct ?? '2';
  }

  private who(by: Principal) {
    if (by.kind !== 'person' && by.kind !== 'dev')
      throw new ApiError('forbidden', 'Invoices are imported by a person signed in with Landbright; a key never does');
    if (!by.roles.some((r) => r === 'controller' || r === 'cfo'))
      throw new ApiError('forbidden', 'Importing and voiding invoices is for the controller or the CFO');
    return by.kind === 'person' ? by.id : 'cli';
  }

  /** Imports a CSV: each invoice in it is posted (or corrected) and versioned. A bad file imports nothing. */
  async import(
    input: { csv: string; fileName?: string; note: string; origin: 'entered' | 'dev-fixture' },
    by: Principal,
  ): Promise<{ invoices: InvoiceView[]; reconciliation: ReconciliationView[] }> {
    const userId = this.who(by);
    const today = this.now().toISOString().slice(0, 10);
    const parsed = parseInvoiceCsv(input.csv, today);
    if (parsed.currency.length)
      throw new ApiError('unprocessable', 'Only USD until FX is set up; nothing was imported', {
        problems: parsed.currency,
      });
    if (parsed.problems.length)
      throw new ApiError(
        'bad_request',
        `The invoice file has ${parsed.problems.length} problem(s); nothing was imported`,
        { problems: parsed.problems },
      );
    const fileSha = sha256(input.csv);
    const months = new Set<string>();
    const ids: string[] = [];
    await this.sql.begin(async (tx) => {
      for (const inv of parsed.invoices) {
        const out = await this.post(tx, inv, by, userId, { ...input, fileSha });
        out.months.forEach((m) => months.add(m));
        ids.push(out.id);
      }
    });
    await this.afterPost([...months]);
    const invoices = await Promise.all(ids.map((id) => this.view(id)));
    const reconciliation = await Promise.all(
      [...new Set(parsed.invoices.map((i) => i.month))].map((m) => this.reconciliation(m)),
    );
    return { invoices, reconciliation };
  }

  private async isLocked(tx: Tx, month: string) {
    const [p] = await tx<{ status: string }[]>`SELECT status FROM periods WHERE month = ${`${month}-01`}`;
    return p?.status === 'locked';
  }

  /** The live invoiced records of an invoice (by its key prefix). */
  private async liveOf(tx: Tx, providerKey: string, number: string): Promise<Map<string, CostRecord>> {
    const rows = await tx<CostRow[]>`
      SELECT r.* FROM cost_records r
      WHERE r.source = 'invoice' AND r.basis = 'invoiced' AND starts_with(r.source_key, ${prefixOf(providerKey, number)})
        AND ${tx.unsafe(LIVE)}`;
    return new Map(rows.map((r) => [r.source_key as string, fromRow(r)]));
  }

  /** The live estimates of a provider in a month, by model, that no other invoice has replaced. */
  private async estimatesOf(tx: Tx, providerKey: string, number: string, month: string) {
    const rows = await tx<CostRow[]>`
      SELECT r.* FROM cost_records r
      WHERE r.basis = 'estimated' AND r.billing_period_start = ${monthStart(month)}::timestamptz
        AND lower(r.tags->>'provider') = ${providerKey} AND ${tx.unsafe(LIVE)}
        AND NOT EXISTS (
          SELECT 1 FROM invoice_estimate_links l JOIN cost_record_keys k ON k.record_id = l.invoiced_record_id
          WHERE l.estimated_source_key = r.source_key AND NOT starts_with(k.source_key, ${prefixOf(providerKey, number)})
            AND EXISTS (SELECT 1 FROM cost_record_keys y WHERE y.source_key = k.source_key AND y.basis = 'invoiced'
                          AND NOT y.is_reversal
                          AND NOT EXISTS (SELECT 1 FROM cost_record_keys z WHERE z.correction_of_id = y.record_id)))
      ORDER BY r.source_key`;
    const out = new Map<string, CostRecord[]>();
    for (const row of rows) {
      const rec = fromRow(row);
      const tags = (rec.Tags ?? {}) as Record<string, unknown>;
      const m = modelKey(typeof tags.model === 'string' ? tags.model : rec.ResourceName);
      out.set(m, [...(out.get(m) ?? []), rec]);
    }
    return out;
  }

  /** The records an invoice should have in the ledger now. */
  private desired(
    inv: ParsedInvoice,
    estimates: Map<string, CostRecord[]>,
    locked: boolean,
    openMonth: string,
    run: string,
  ): { records: CostRecord[]; links: { estimateKey: string; key: string }[] } {
    const records: CostRecord[] = [];
    const links: { estimateKey: string; key: string }[] = [];
    const prefix = prefixOf(inv.providerKey, inv.number);
    const usage = new Map<string, InvoiceLine[]>();
    for (const l of inv.lines)
      if (l.chargeCategory === 'Usage' && l.model)
        usage.set(modelKey(l.model), [...(usage.get(modelKey(l.model)) ?? []), l]);
    const base = (l: InvoiceLine | null, model: string, cost: Money): CostRecord => {
      const sku = l?.sku ?? model;
      return {
        BilledCost: cost,
        EffectiveCost: cost,
        ListCost: cost,
        ContractedCost: cost,
        ListUnitPrice: null,
        ContractedUnitPrice: null,
        PricingQuantity: null,
        PricingUnit: null,
        ConsumedQuantity: l?.quantity ?? null,
        ConsumedUnit: l?.unit ?? null,
        BillingCurrency: USD,
        ChargePeriodStart: monthStart(inv.month),
        ChargePeriodEnd: monthStart(nextMonth(inv.month)),
        ...billingPeriod(inv.month),
        ChargeCategory: l?.chargeCategory ?? 'Usage',
        ChargeClass: null,
        ChargeDescription: null,
        ChargeFrequency: (l?.chargeCategory ?? 'Usage') === 'Usage' ? 'Usage-Based' : 'One-Time',
        PricingCategory: 'Standard',
        ServiceCategory: 'AI and Machine Learning',
        ServiceSubcategory: 'Generative AI',
        ServiceName: `${inv.provider} API`,
        ServiceProviderName: inv.provider,
        HostProviderName: null,
        InvoiceIssuerName: inv.provider,
        BillingAccountId: `${inv.providerKey}:invoice`,
        BillingAccountName: null,
        SubAccountId: null,
        SubAccountName: null,
        SubAccountType: null,
        InvoiceId: inv.number,
        ResourceId: null,
        ResourceName: model === OTHER_CHARGES ? null : model,
        ResourceType: model === OTHER_CHARGES ? null : 'AI Model',
        SkuId: `${inv.providerKey}:${sku}`,
        SkuMeter: l?.description || null,
        SkuPriceId: `${inv.providerKey}:${sku}:invoice`,
        SkuPriceDetails: null,
        Tags: {
          provider: inv.providerKey,
          ...(model === OTHER_CHARGES ? {} : { model }),
          resource: 'ai',
          invoice: inv.number,
        },
        AllocatedMethodId: null,
        AllocatedMethodDetails: null,
        AllocatedResourceId: null,
        AllocatedResourceName: null,
        AllocatedTags: null,
        x_RecordId: newId('rec'),
        x_Basis: 'invoiced',
        x_Source: 'invoice',
        x_SourceKey: '',
        x_SourceCost: cost.toDecimal(),
        x_RateCardVersion: null,
        x_IngestRunId: run,
        x_CorrectionOfId: null,
        x_WorkflowId: null,
        x_AgentId: null,
        x_ActorId: null,
        x_OriginalCost: null,
        x_OriginalCurrency: null,
        x_FxRateId: null,
      };
    };
    const inOpenMonth = (r: CostRecord): CostRecord =>
      locked ? { ...r, ...billingPeriod(openMonth), ChargeClass: 'Correction' } : r;
    // Usage by model: over the estimates, or on its own.
    for (const [model, lines] of usage) {
      const total = Money.sum(
        lines.map((l) => l.amount),
        USD,
      );
      const lineNos = lines.map((l) => l.line).join(', ');
      const ests = estimates.get(model) ?? [];
      const display = lines[0]!.model!;
      if (locked) {
        // The month is locked: book the difference in the open month, so its estimates plus this equal the invoice.
        const estimated = Money.sum(
          ests.map((e) => e.EffectiveCost),
          USD,
        );
        const trueUp = total.minus(estimated);
        const qty = lines.every((l) => l.quantity) ? lines.reduce((a, l) => a.plus(l.quantity!), Decimal.ZERO) : null;
        const unit = lines.every((l) => l.unit === lines[0]!.unit) ? lines[0]!.unit : null;
        records.push(
          inOpenMonth({
            ...base(lines[0]!, display, trueUp),
            ConsumedQuantity: qty && unit ? qty : null,
            ConsumedUnit: qty && unit ? unit : null,
            ChargeDescription: `${display} on ${inv.provider} invoice ${inv.number} (line ${lineNos}): ${amount(total)} invoiced less ${amount(estimated)} estimated in locked ${inv.month}`,
            x_SourceKey: `${prefix}trueup:${model}`,
          }),
        );
        continue;
      }
      if (!ests.length) {
        lines.forEach((l) =>
          records.push({
            ...base(l, display, l.amount),
            ChargeDescription: `${display} on ${inv.provider} invoice ${inv.number}, line ${l.line}; no estimate to replace`,
            x_SourceKey: `${prefix}line:${l.line}`,
          }),
        );
        continue;
      }
      const parts = splitOverEstimates(
        total,
        ests.map((e) => ({ key: e.x_SourceKey, cost: e.EffectiveCost, quantity: e.ConsumedQuantity })),
      );
      ests.forEach((e, i) => {
        const key = `${prefix}${e.x_SourceKey}`;
        const part = parts[i]!;
        records.push({
          ...e,
          BilledCost: part,
          EffectiveCost: part,
          ListCost: part,
          ContractedCost: part,
          ListUnitPrice: null,
          ContractedUnitPrice: null,
          PricingQuantity: null,
          PricingUnit: null,
          ChargeClass: null,
          PricingCategory: 'Standard',
          InvoiceId: inv.number,
          InvoiceIssuerName: inv.provider,
          ChargeDescription: `${display} on ${inv.provider} invoice ${inv.number} (line ${lineNos}): share of ${amount(total)} by estimate`,
          SkuPriceId: `${inv.providerKey}:${modelKey(display)}:invoice`,
          Tags: { ...((e.Tags ?? {}) as Record<string, never>), invoice: inv.number },
          x_RecordId: newId('rec'),
          x_Basis: 'invoiced',
          x_Source: 'invoice',
          x_SourceKey: key,
          x_SourceCost: part.toDecimal(),
          x_RateCardVersion: null,
          x_IngestRunId: run,
          x_CorrectionOfId: null,
          x_OriginalCost: null,
          x_OriginalCurrency: null,
          x_FxRateId: null,
        });
        links.push({ estimateKey: e.x_SourceKey, key });
      });
    }
    // Every other line posts on its own (credits, tax, purchases, lines naming only a SKU).
    for (const l of inv.lines) {
      if (l.chargeCategory === 'Usage' && l.model) continue;
      records.push(
        inOpenMonth({
          ...base(l, l.model ?? OTHER_CHARGES, l.amount),
          ChargeDescription: `${l.chargeCategory} on ${inv.provider} invoice ${inv.number}, line ${l.line}${l.description ? `: ${l.description}` : ''}`,
          x_SourceKey: `${prefix}line:${l.line}`,
        }),
      );
    }
    return { records, links };
  }

  private async post(
    tx: Tx,
    inv: ParsedInvoice,
    by: Principal,
    userId: string,
    input: { fileName?: string; note: string; origin: 'entered' | 'dev-fixture'; fileSha: string },
  ): Promise<{ id: string; months: string[] }> {
    const id = invoiceId(inv.providerKey, inv.number);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`invoice:${id}`}))`;
    const [prev] = await tx<InvoiceRow[]>`SELECT * FROM invoices WHERE id = ${id} ORDER BY version DESC LIMIT 1`;
    const openMonth = this.now().toISOString().slice(0, 7);
    const locked = await this.isLocked(tx, inv.month);
    if (locked && (await this.isLocked(tx, openMonth)))
      throw new ApiError('conflict', `${inv.month} and ${openMonth} are locked: there is no open month to book in`);
    const run = newId('run');
    await tx`
      INSERT INTO ingest_runs (id, source, kind, day, params, started_by)
      VALUES (${run}, 'invoice', 'manual', ${`${inv.month}-01`},
              ${tx.json({ invoice: inv.number, provider: inv.provider, origin: input.origin, version: (prev?.version ?? 0) + 1 })},
              ${userId})`;
    const estimates = await this.estimatesOf(tx, inv.providerKey, inv.number, inv.month);
    const want = this.desired(inv, estimates, locked, openMonth, run);
    const live = await this.liveOf(tx, inv.providerKey, inv.number);
    const periods = { isLocked: (m: string) => m === inv.month && locked, openMonth };
    const ctx = { ingestRunId: run, newId: () => newId('rec') };
    const toAppend: CostRecord[] = [];
    let added = 0;
    let fresh = 0;
    let reversed = 0;
    let unchanged = 0;
    const entered = new Map<string, string>();
    for (const r of want.records) {
      const old = live.get(r.x_SourceKey);
      if (old && fingerprint(old) === fingerprint(r)) {
        unchanged++;
        entered.set(r.x_SourceKey, old.x_RecordId);
        continue;
      }
      if (old) {
        const [rev, again] = correct(
          old,
          { ...r, ChargePeriodStart: old.ChargePeriodStart, ChargePeriodEnd: old.ChargePeriodEnd },
          periods,
          ctx,
        );
        toAppend.push(rev!, again!);
        entered.set(r.x_SourceKey, again!.x_RecordId);
        reversed++;
        added++;
      } else {
        const rec = assertValid(r);
        toAppend.push(rec);
        entered.set(r.x_SourceKey, rec.x_RecordId);
        added++;
        fresh++;
      }
    }
    const wanted = new Set(want.records.map((r) => r.x_SourceKey));
    for (const [key, old] of live)
      if (!wanted.has(key)) {
        toAppend.push(...correct(old, null, periods, ctx));
        reversed++;
      }
    const months = new Set<string>();
    if (toAppend.length) {
      await tx`INSERT INTO cost_records ${tx(toAppend.map((r) => toRow(assertValid(r))))}`;
      toAppend.forEach((r) => months.add(r.BillingPeriodStart.slice(0, 7)));
    }
    let linked = 0;
    for (const l of want.links) {
      const recordId = entered.get(l.key)!;
      const res = await tx`
        INSERT INTO invoice_estimate_links (estimated_source_key, invoiced_record_id, month, linked_by, note)
        VALUES (${l.estimateKey}, ${recordId}, ${`${inv.month}-01`}, ${userId}, ${`invoice ${inv.number}`})
        ON CONFLICT DO NOTHING`;
      linked += res.count;
    }
    const total = Money.sum(
      inv.lines.map((l) => l.amount),
      USD,
    );
    const version = (prev?.version ?? 0) + 1;
    await tx`
      INSERT INTO invoices (id, version, provider, number, month, status, origin, total_micros, currency, correction,
                            added, reversed, unchanged, linked, ingest_run_id, file_name, file_sha256, note, imported_by)
      VALUES (${id}, ${version}, ${inv.provider}, ${inv.number}, ${`${inv.month}-01`}, 'posted', ${input.origin},
              ${total.micros.toString()}, ${USD}, ${locked}, ${added}, ${reversed}, ${unchanged}, ${want.links.length},
              ${run}, ${input.fileName ?? null}, ${input.fileSha}, ${input.note}, ${userId})`;
    await tx`INSERT INTO invoice_lines ${tx(
      inv.lines.map((l) => ({
        invoice_id: id,
        version,
        line: l.line,
        model: l.model,
        sku: l.sku,
        quantity: l.quantity?.toString() ?? null,
        unit: l.unit,
        amount_micros: l.amount.micros.toString(),
        charge_category: l.chargeCategory,
        description: l.description,
      })),
    )}`;
    await tx`
      UPDATE ingest_runs SET finished_at = clock_timestamp(), outcome = 'succeeded', read_count = ${inv.lines.length},
        new_count = ${fresh}, corrected_count = ${reversed}, unchanged_count = ${unchanged}
      WHERE id = ${run}`;
    await this.snapshot(tx, id, version, inv.month, inv.providerKey);
    await this.audit.append(
      {
        ...actorOf(by),
        action: prev ? 'invoice.reimported' : 'invoice.imported',
        subjectType: 'invoice',
        subjectId: id,
        data: {
          provider: inv.provider,
          number: inv.number,
          month: inv.month,
          version,
          totalMicros: total.micros.toString(),
          lines: inv.lines.length,
          added,
          reversed,
          unchanged,
          linked: want.links.length,
          newLinks: linked,
          correction: locked,
          origin: input.origin,
          fileSha256: input.fileSha,
        },
      },
      tx,
    );
    return { id, months: [...months] };
  }

  /** Reverses an invoice whole: its estimates count again. A version with status `voided`. */
  async void(id: string, reason: string, by: Principal): Promise<InvoiceView> {
    const userId = this.who(by);
    const months = new Set<string>();
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`invoice:${id}`}))`;
      const [prev] = await tx<InvoiceRow[]>`SELECT * FROM invoices WHERE id = ${id} ORDER BY version DESC LIMIT 1`;
      if (!prev) throw notFound('Invoice');
      if (prev.status === 'voided') throw new ApiError('conflict', `Invoice ${prev.number} is voided already`);
      const month = day(prev.month).slice(0, 7);
      const openMonth = this.now().toISOString().slice(0, 7);
      const locked = await this.isLocked(tx, month);
      const run = newId('run');
      await tx`
        INSERT INTO ingest_runs (id, source, kind, day, params, started_by)
        VALUES (${run}, 'invoice', 'manual', ${`${month}-01`},
                ${tx.json({ invoice: prev.number, provider: prev.provider, void: true, reason })}, ${userId})`;
      const live = await this.liveOf(tx, prev.provider.toLowerCase(), prev.number);
      const periods = { isLocked: (m: string) => m === month && locked, openMonth };
      const out = [...live.values()].flatMap((r) =>
        correct(r, null, periods, { ingestRunId: run, newId: () => newId('rec') }),
      );
      if (out.length) {
        await tx`INSERT INTO cost_records ${tx(out.map((r) => toRow(r)))}`;
        out.forEach((r) => months.add(r.BillingPeriodStart.slice(0, 7)));
      }
      await tx`
        INSERT INTO invoices (id, version, provider, number, month, status, origin, total_micros, currency, correction,
                              added, reversed, unchanged, linked, ingest_run_id, file_name, file_sha256, note, imported_by)
        SELECT id, version + 1, provider, number, month, 'voided', origin, total_micros, currency, ${locked}, 0,
               ${out.length}, 0, 0, ${run}, file_name, file_sha256, ${reason}, ${userId}
        FROM invoices WHERE id = ${id} AND version = ${prev.version}`;
      await tx`
        INSERT INTO invoice_lines (invoice_id, version, line, model, sku, quantity, unit, amount_micros, charge_category, description)
        SELECT invoice_id, version + 1, line, model, sku, quantity, unit, amount_micros, charge_category, description
        FROM invoice_lines WHERE invoice_id = ${id} AND version = ${prev.version}`;
      await tx`
        UPDATE ingest_runs SET finished_at = clock_timestamp(), outcome = 'succeeded', read_count = 0,
          corrected_count = ${out.length} WHERE id = ${run}`;
      await this.snapshot(tx, id, prev.version + 1, month, prev.provider.toLowerCase());
      await this.audit.append(
        {
          ...actorOf(by),
          action: 'invoice.voided',
          subjectType: 'invoice',
          subjectId: id,
          data: {
            provider: prev.provider,
            number: prev.number,
            month,
            version: prev.version + 1,
            reversed: out.length,
            reason,
          },
        },
        tx,
      );
    });
    await this.afterPost([...months]);
    return this.view(id);
  }

  async view(id: string, tx: Tx = this.sql): Promise<InvoiceView> {
    const [row] = await tx<InvoiceRow[]>`
      SELECT i.*, u.email AS importer FROM invoices i LEFT JOIN users u ON u.id = i.imported_by
      WHERE i.id = ${id} ORDER BY version DESC LIMIT 1`;
    if (!row) throw notFound('Invoice');
    const lines = await tx<LineRow[]>`
      SELECT invoice_id, version, line, model, sku, quantity::text AS quantity, unit, amount_micros::text AS amount_micros,
             charge_category, description
      FROM invoice_lines WHERE invoice_id = ${id} AND version = ${row.version} ORDER BY line`;
    return this.viewOf(row, lines);
  }

  private viewOf(row: InvoiceRow, lines: LineRow[]): InvoiceView {
    return {
      id: row.id,
      provider: row.provider,
      number: row.number,
      month: day(row.month).slice(0, 7),
      version: row.version,
      status: row.status,
      origin: row.origin,
      total: amount(Money.ofMicros(row.total_micros, USD)),
      lines: lines.map((l) => ({
        line: l.line,
        model: l.model,
        sku: l.sku,
        quantity: l.quantity,
        unit: l.unit,
        amount: amount(Money.ofMicros(l.amount_micros, USD)),
        chargeCategory: l.charge_category,
        description: l.description,
      })),
      posted: { added: row.added, reversed: row.reversed, unchanged: row.unchanged, linkedEstimates: row.linked },
      correction: row.correction,
      importedBy: row.importer ?? row.imported_by,
      importedAt: row.imported_at.toISOString(),
      note: row.note,
      fileSha256: row.file_sha256,
    };
  }

  /** The invoices of a month (each at its newest version). */
  async list(month: string): Promise<InvoiceView[]> {
    const rows = await this.sql<InvoiceRow[]>`
      SELECT DISTINCT ON (i.id) i.*, u.email AS importer FROM invoices i LEFT JOIN users u ON u.id = i.imported_by
      WHERE i.month = ${`${month}-01`} ORDER BY i.id, i.version DESC`;
    const out: InvoiceView[] = [];
    for (const row of rows) {
      const lines = await this.sql<LineRow[]>`
        SELECT invoice_id, version, line, model, sku, quantity::text AS quantity, unit,
               amount_micros::text AS amount_micros, charge_category, description
        FROM invoice_lines WHERE invoice_id = ${row.id} AND version = ${row.version} ORDER BY line`;
      out.push(this.viewOf(row, lines));
    }
    return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.number.localeCompare(b.number));
  }

  /** AI cost charged in `month`, per provider × model and basis (entries and reversals net, so only live counts). */
  /**
   * Per provider × model in `month`: every live AI estimate charged in it (entries and reversals net), and what the
   * month's posted invoices bill (their lines, at each invoice's newest version: a locked month's true-up included).
   */
  private async aiByModel(tx: Tx, month: string, providerKey?: string) {
    const estimated = await tx<{ provider: string; model: string; micros: string; n: number }[]>`
      SELECT lower(coalesce(r.tags->>'provider', r.service_provider_name)) AS provider,
             lower(coalesce(r.tags->>'model', ${OTHER_CHARGES})) AS model,
             sum(r.effective_cost_micros)::text AS micros,
             (count(*) FILTER (WHERE r.correction_of_id IS NULL AND NOT EXISTS (
                SELECT 1 FROM cost_record_keys x WHERE x.correction_of_id = r.record_id)))::int AS n
      FROM cost_records r
      WHERE r.charge_period_start >= ${monthStart(month)}::timestamptz
        AND r.charge_period_start < ${monthStart(addMonths(month, 1))}::timestamptz
        AND r.service_category = 'AI and Machine Learning' AND r.basis = 'estimated'
        ${providerKey ? tx`AND lower(coalesce(r.tags->>'provider', r.service_provider_name)) = ${providerKey}` : tx``}
      GROUP BY 1, 2`;
    const invoiced = await tx<{ provider: string; model: string; micros: string; n: number; invoices: string[] }[]>`
      WITH latest AS (
        SELECT DISTINCT ON (id) id, version, provider, number, status FROM invoices
        WHERE month = ${`${month}-01`} ORDER BY id, version DESC)
      SELECT lower(i.provider) AS provider, lower(coalesce(l.model, ${OTHER_CHARGES})) AS model,
             sum(l.amount_micros)::text AS micros, count(*)::int AS n, array_agg(DISTINCT i.number) AS invoices
      FROM latest i JOIN invoice_lines l ON l.invoice_id = i.id AND l.version = i.version
      WHERE i.status = 'posted' ${providerKey ? tx`AND lower(i.provider) = ${providerKey}` : tx``}
      GROUP BY 1, 2`;
    return [
      ...estimated.map((r) => ({ ...r, basis: 'estimated', invoices: [] as string[] })),
      ...invoiced.map((r) => ({ ...r, basis: 'invoiced' })),
    ];
  }

  private async rows(tx: Tx, month: string, providerKey?: string): Promise<ReconciliationRow[]> {
    const raw = await this.aiByModel(tx, month, providerKey);
    const groups = new Map<
      string,
      { provider: string; model: string; est: Money; inv: Money; ne: number; ni: number; invoices: Set<string> }
    >();
    for (const r of raw) {
      const k = `${r.provider}\u0000${r.model}`;
      const g = groups.get(k) ?? {
        provider: r.provider,
        model: r.model,
        est: zero(),
        inv: zero(),
        ne: 0,
        ni: 0,
        invoices: new Set<string>(),
      };
      const m = Money.ofMicros(r.micros, USD);
      if (r.basis === 'estimated') {
        g.est = g.est.plus(m);
        g.ne += r.n;
      } else {
        g.inv = g.inv.plus(m);
        g.ni += r.n;
        r.invoices.forEach((i) => g.invoices.add(i));
      }
      groups.set(k, g);
    }
    return [...groups.values()]
      .filter((g) => g.ne > 0 || g.ni > 0)
      .map((g) => {
        const r = reconcile(g.est, g.inv, { estimates: g.ne, invoiced: g.ni }, this.tolerance);
        return {
          provider: g.provider,
          model: g.model,
          month,
          estimated: amount(g.est),
          invoiced: amount(g.inv),
          variance: amount(r.variance),
          variancePct: r.variancePct,
          status: r.status,
          invoices: [...g.invoices].sort(),
        };
      })
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  }

  /** A provider's rows as they stood at an import, kept (append only). */
  private async snapshot(tx: Tx, id: string, version: number, month: string, providerKey: string) {
    const rows = await this.rows(tx, month, providerKey);
    if (!rows.length) return;
    await tx`INSERT INTO reconciliations ${tx(
      rows.map((r) => ({
        id: newId('rcn'),
        invoice_id: id,
        invoice_version: version,
        month: `${month}-01`,
        provider: r.provider,
        model: r.model,
        estimated_micros: Money.parse(r.estimated, USD).micros.toString(),
        invoiced_micros: Money.parse(r.invoiced, USD).micros.toString(),
        variance_micros: Money.parse(r.variance, USD).micros.toString(),
        tolerance_pct: this.tolerance,
        status: r.status,
      })),
    )}`;
  }

  /** Reconciliation for a month: every provider × model with an estimate or an invoice line. */
  async reconciliation(month?: string): Promise<ReconciliationView> {
    const m = month ?? this.now().toISOString().slice(0, 7);
    const rows = await this.rows(this.sql, m);
    const est = Money.sum(
      rows.map((r) => Money.parse(r.estimated, USD)),
      USD,
    );
    const inv = Money.sum(
      rows.map((r) => Money.parse(r.invoiced, USD)),
      USD,
    );
    const r = reconcile(est, inv, { estimates: 1, invoiced: 1 }, this.tolerance);
    // The share invoiced of AI spend as every figure shows it (each charge once).
    const { lines } = await this.spend.lines({ fromMonth: m, toMonth: m }, false);
    const ai = lines.filter((l) => l.serviceCategory === 'AI and Machine Learning');
    const shown = Money.sum(
      ai.map((l) => l.amount),
      USD,
    );
    const shownInvoiced = Money.sum(
      ai.filter((l) => l.basis === 'invoiced').map((l) => l.amount),
      USD,
    );
    return {
      month: m,
      currency: USD,
      tolerancePct: this.tolerance,
      rows,
      totals: {
        estimated: amount(est),
        invoiced: amount(inv),
        variance: amount(r.variance),
        variancePct: r.variancePct,
        invoicedShare: invoicedShare(
          shownInvoiced,
          shown,
          ai.some((l) => l.basis === 'invoiced'),
        ),
        within: r.within,
      },
      invoices: await this.list(m),
    };
  }

  /**
   * An approved request from decision to bill: approved, reserved, consumed (its reservations), invoiced (the share of
   * its matched cost that is invoiced), and the actual against what was approved in the months so far.
   */
  async lifecycle(r: {
    id: string;
    title: string;
    status: string;
    amount_micros: string;
    currency: string;
    recurrence: 'monthly' | 'once';
    start_day: Date;
    end_day: Date | null;
    decided_at: Date | null;
    closed_by: string | null;
    cost_center: string;
    evidence: Record<string, unknown>;
    automatic: boolean;
  }): Promise<RequestLifecycle | null> {
    if (r.status !== 'approved' && r.status !== 'applied') return null;
    const res = await this.sql<
      {
        month: Date;
        amount_micros: string;
        consumed_micros: string;
        status: string;
        created_at: Date;
        from_day: Date;
      }[]
    >`SELECT month, amount_micros::text, consumed_micros::text, status, created_at, from_day FROM reservations
      WHERE request_id = ${r.id} ORDER BY month`;
    const reserved = Money.sum(
      res.map((x) => Money.ofMicros(x.amount_micros, USD)),
      USD,
    );
    const consumed = Money.sum(
      res.map((x) => Money.ofMicros(x.consumed_micros, USD)),
      USD,
    );
    const current = this.now().toISOString().slice(0, 7);
    const months = res.map((x) => day(x.month).slice(0, 7)).filter((m) => m <= current);
    const approvedToDate = Money.sum(
      months.map((m) => addsInMonth(r, m)),
      USD,
    );
    const selector = selectorOf(r.evidence);
    let matched = zero();
    let matchedInvoiced = zero();
    if (selector)
      for (const m of months) {
        const from = res.find((x) => day(x.month).slice(0, 7) === m)!;
        const { lines } = await this.spend.lines({ fromMonth: m, toMonth: m }, false);
        for (const l of lines)
          if (l.day >= day(from.from_day) && lineMatches(l, r.cost_center, selector)) {
            matched = matched.plus(l.amount);
            if (l.basis === 'invoiced') matchedInvoiced = matchedInvoiced.plus(l.amount);
          }
      }
    // The actual: what its reservations consumed (the increment above baseline); without a selector, nothing matches.
    const actual = consumed;
    const variance = actual.minus(approvedToDate);
    const share = invoicedShare(matchedInvoiced, matched, !matchedInvoiced.isZero());
    return {
      requestId: r.id,
      stages: [
        {
          key: 'approved',
          label: 'Approved',
          amount: amount(Money.ofMicros(r.amount_micros, USD)),
          at: r.decided_at?.toISOString() ?? null,
          note: r.automatic ? 'By policy, under the automatic threshold' : `By ${r.closed_by ?? 'its approvers'}`,
        },
        {
          key: 'reserved',
          label: 'Reserved',
          amount: amount(reserved),
          at: res[0]?.created_at.toISOString() ?? null,
          note: res.length
            ? `${res.length} month(s): ${res.map((x) => day(x.month).slice(0, 7)).join(', ')}`
            : 'Nothing reserved (a contract reserves seats, not money)',
        },
        {
          key: 'consumed',
          label: 'Consumed',
          amount: amount(consumed),
          at: null,
          note: selector
            ? 'Matched cost above the baseline, from its first day'
            : 'No match selector: nothing consumes it, and each month is released when it ends',
        },
        {
          key: 'invoiced',
          label: 'Invoiced',
          amount: amount(matchedInvoiced),
          at: null,
          note: selector
            ? `${share}% of its matched cost is invoiced; the rest is estimated`
            : 'Nothing matches it, so nothing is invoiced against it',
        },
      ],
      approvedToDate: amount(approvedToDate),
      actualToDate: amount(actual),
      variance: amount(variance),
      variancePct: approvedToDate.isZero()
        ? null
        : variance.toDecimal().times('100').divide(approvedToDate.toDecimal(), 1, 'halfEven').toString(),
      invoicedShare: share,
    };
  }
}

/** Invoiced ÷ shown, percent with no decimals ("71"); "0" when nothing is invoiced. */
export function invoicedShare(invoiced: Money, shown: Money, any: boolean): string {
  if (!any || shown.isZero()) return any && shown.isZero() ? '100' : '0';
  return invoiced.toDecimal().times('100').divide(shown.toDecimal(), 0, 'halfEven').toString();
}
