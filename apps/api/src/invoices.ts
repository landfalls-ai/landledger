/**
 * Invoices and reconciliation (spec 005, review of wave 3). A provider's invoice comes in as a CSV once its month is
 * over (in LANDLEDGER_TZ); each Usage line group (provider × model) is split over the live estimates it replaces and
 * posted as `invoiced` records linked to them, so no read ever adds an estimate to the invoice that replaced it. A group
 * with no estimate, and every other line, posts on its own. For a locked month the open month gets one true-up per
 * model: what the invoice bills less the estimates still shown, linked (`trued_up`) so a second invoice never subtracts
 * them again. An estimate that arrives after its month was invoiced is linked `late` (it drops out, and the row says
 * "estimates after invoice: re-reconcile"); the next import or void re-plans the split. Hiding is judged as of the
 * estimate's own billing month, so once that month locks nothing done later moves it: a void books the estimates back
 * in the open month instead. Importing the same invoice again corrects by reversal and re-entry. A `dev-fixture` invoice
 * (dev auth on this machine only) is tagged, links nothing and is left out of every figure but Reconciliation's.
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
import { localParts } from './business-hours.js';
import { day, type Sql, type Tx } from './db.js';
import { ApiError, notFound } from './errors.js';
import { newId, sha256 } from './ids.js';
import { actorOf, type Principal } from './principal.js';
import { addsInMonth, lineMatches, selectorOf } from './reservations.js';
import { DEV_FIXTURE, hiddenSql } from './read-rule.js';
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
 * file `currency` (the route answers 422). Lines are grouped into invoices by provider and number. `today` is the local
 * date (LANDLEDGER_TZ): an invoice is for a month that is over.
 */
export function parseInvoiceCsv(
  csv: string,
  today: string,
  timeZone = 'UTC',
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
    else if (month === today.slice(0, 7))
      problems.push(
        `${at}: period ${month} hasn't ended yet (${timeZone}): an invoice is imported once its month is over`,
      );
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

/**
 * Variance and status of one provider × model × month (spec 005). Within: |variance| ≤ tolerance% × |estimated|, or at
 * most the absolute floor (`LANDLEDGER_RECONCILE_TOLERANCE_USD`, $0.50 by default), so cents never read as outside.
 */
export function reconcile(
  estimated: Money,
  invoiced: Money,
  counts: { estimates: number; invoiced: number },
  tolerancePct: string,
  floorUsd = '0',
): { variance: Money; variancePct: string | null; status: ReconcileStatus; within: boolean } {
  const variance = invoiced.minus(estimated);
  const variancePct = estimated.isZero()
    ? null
    : variance.toDecimal().times('100').divide(estimated.toDecimal(), 1, 'halfEven').toString();
  // |variance| ≤ tolerance% × |estimated|, compared exactly: |variance| × 100 ≤ tolerance × |estimated|.
  const within =
    variance.abs().toDecimal().times('100').compare(estimated.abs().toDecimal().times(tolerancePct)) <= 0 ||
    variance.abs().toDecimal().compare(floorUsd) <= 0;
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

const AI = 'AI and Machine Learning';
const invoiceId = (providerKey: string, number: string) => `inv_${sha256(`${providerKey}:${number}`).slice(0, 20)}`;
const prefixOf = (providerKey: string, number: string) => `invoice:${providerKey}:${number}:`;
const modelKey = (m: string | null | undefined) => (m ?? OTHER_CHARGES).toLowerCase();
const modelOf = (r: CostRecord) => {
  const t = (r.Tags ?? {}) as Record<string, unknown>;
  return modelKey(typeof t.model === 'string' ? t.model : r.ResourceName);
};
/**
 * What makes two records of an invoice the same charge: re-importing an unchanged line leaves it alone, wherever it was
 * booked (a line posted while its month was open stays put after the month locks).
 */
const fingerprint = (r: CostRecord) =>
  [
    r.x_Basis,
    r.EffectiveCost.micros,
    r.ChargeCategory,
    r.ConsumedQuantity?.toString() ?? '',
    r.ConsumedUnit ?? '',
    r.ChargePeriodStart,
    r.ChargeDescription ?? '',
  ].join('|');

/**
 * A key entered again after it was reversed with nothing in its place takes a new generation (`#g2`, `#g3`, review of
 * wave 4, B1): links name a record's key, and a link made to the old generation (a `late` estimate, a `trued_up`
 * claim) must never come back to life when the invoice bills the same model again.
 */
const GENERATION = /#g\d+$/;
export const baseKey = (key: string) => key.replace(GENERATION, '');

const LIVE = `NOT EXISTS (SELECT 1 FROM cost_record_keys x WHERE x.correction_of_id = r.record_id) AND r.correction_of_id IS NULL`;
/** A key with a live invoiced entry (an entry no reversal answers), whatever month either was booked in. */
const LIVE_KEY = (col: string) =>
  `EXISTS (SELECT 1 FROM cost_record_keys y WHERE y.source_key = ${col} AND y.basis = 'invoiced' AND NOT y.is_reversal
     AND NOT EXISTS (SELECT 1 FROM cost_record_keys z WHERE z.correction_of_id = y.record_id))`;
const PROVIDER = `lower(coalesce(r.tags->>'provider', r.service_provider_name))`;

/** The months a period state needs: a month at or before the last locked one takes nothing (cost_records_enter). */
async function periodsIn(tx: Tx, now: Date) {
  const rows = await tx<{ month: Date; status: string }[]>`SELECT month, status FROM periods WHERE status = 'locked'`;
  const lastLocked =
    rows
      .map((p) => day(p.month).slice(0, 7))
      .sort()
      .at(-1) ?? '';
  const thisMonth = now.toISOString().slice(0, 7);
  return {
    isLocked: (m: string) => m <= lastLocked,
    openMonth: thisMonth > lastLocked ? thisMonth : nextMonth(lastLocked),
  };
}

export class Invoices {
  constructor(
    private readonly sql: Sql,
    private readonly audit: AuditLog,
    private readonly spend: Spend,
    private readonly config: Partial<
      Pick<Config, 'reconcileTolerancePct' | 'reconcileToleranceUsd' | 'devAuth' | 'timeZone'>
    >,
    private readonly now: () => Date = () => new Date(),
    /** Called with the months records landed in, so they are allocated (services: allocation.allocatePending). */
    private readonly afterPost: (months: string[]) => Promise<void> = async () => {},
  ) {}

  private get tolerance() {
    return this.config.reconcileTolerancePct ?? '2';
  }

  private get floor() {
    return this.config.reconcileToleranceUsd ?? '0.5';
  }

  /**
   * Who imports or voids: a person who is the controller or the CFO. A `dev-fixture` invoice only while the API runs
   * with dev auth (which is loopback only, config.ts), where the local developer may handle fixtures too.
   */
  /** Who imports or voids: the controller or the CFO. A dev fixture comes in on a dev API only; voiding one is taking
   * test data out, so it works on any API (the live API runs with Landbright, not dev sign-in). */
  private who(by: Principal, origin: 'entered' | 'dev-fixture', action: 'import' | 'void' = 'import') {
    if (origin === 'dev-fixture' && action === 'import' && !this.config.devAuth)
      throw new ApiError(
        'forbidden',
        'A dev-fixture invoice is for a development API only (LANDLEDGER_DEV_AUTH=on, on this machine)',
      );
    if (by.kind === 'dev' && origin === 'dev-fixture') return 'cli';
    if (by.kind !== 'person')
      throw new ApiError('forbidden', 'Invoices are imported by a person signed in with Landbright; a key never does');
    if (!by.roles.some((r) => r === 'controller' || r === 'cfo'))
      throw new ApiError('forbidden', 'Importing and voiding invoices is for the controller or the CFO');
    return by.id;
  }

  /** Imports a CSV: each invoice in it is posted (or corrected) and versioned. A bad file imports nothing. */
  async import(
    input: { csv: string; fileName?: string; note: string; origin: 'entered' | 'dev-fixture' },
    by: Principal,
  ): Promise<{ invoices: InvoiceView[]; reconciliation: ReconciliationView[] }> {
    const userId = this.who(by, input.origin);
    const tz = this.config.timeZone ?? 'UTC';
    const today = localParts(this.now().getTime(), tz).date;
    const parsed = parseInvoiceCsv(input.csv, today, tz);
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

  /** Every live record an invoice holds (its key prefix), whatever its basis: its lines, true-ups and restores. */
  private async liveOf(tx: Tx, prefix: string): Promise<Map<string, CostRecord>> {
    const rows = await tx<CostRow[]>`
      SELECT r.* FROM cost_records r
      WHERE r.source = 'invoice' AND starts_with(r.source_key, ${prefix}) AND ${tx.unsafe(LIVE)}`;
    return new Map(rows.map((r) => [`${r.basis}:${baseKey(r.source_key as string)}`, fromRow(r)]));
  }

  /** The key a fresh entry takes: the base key, or its next generation when the base key was entered before. */
  private async freshKey(tx: Tx, key: string, basis: string): Promise<string> {
    const [{ n }] = (await tx`
      SELECT count(DISTINCT source_key)::int AS n FROM cost_record_keys
      WHERE basis = ${basis} AND (source_key = ${key} OR starts_with(source_key, ${`${key}#g`}))`) as unknown as [
      { n: number },
    ];
    return n ? `${key}#g${n + 1}` : key;
  }

  /**
   * The live AI estimates of a provider charged in a month, by model, that no other live invoice claims (by any link):
   * the estimates this invoice replaces (an open month) or trues up (a locked one).
   */
  private async estimatesOf(tx: Tx, providerKey: string, prefix: string, month: string) {
    const rows = await tx<CostRow[]>`
      SELECT r.* FROM cost_records r
      WHERE r.basis = 'estimated' AND r.source NOT IN ('invoice', 'dev-anomaly') AND r.service_category = ${AI}
        AND r.charge_period_start >= ${monthStart(month)}::timestamptz
        AND r.charge_period_start < ${monthStart(nextMonth(month))}::timestamptz
        AND ${tx.unsafe(PROVIDER)} = ${providerKey} AND ${tx.unsafe(LIVE)}
        AND NOT EXISTS (
          SELECT 1 FROM invoice_estimate_links l JOIN cost_record_keys k ON k.record_id = l.invoiced_record_id
          WHERE l.estimated_source_key = r.source_key AND NOT starts_with(k.source_key, ${prefix})
            AND ${tx.unsafe(LIVE_KEY('k.source_key'))})
      ORDER BY r.source_key`;
    const out = new Map<string, CostRecord[]>();
    for (const row of rows) {
      const rec = fromRow(row);
      const m = modelOf(rec);
      out.set(m, [...(out.get(m) ?? []), rec]);
    }
    return out;
  }

  /** Estimate keys this invoice's live records claim by a `split` link (the line shares). */
  private async splitClaims(tx: Tx, prefix: string): Promise<Set<string>> {
    const rows = await tx<{ k: string }[]>`
      SELECT DISTINCT l.estimated_source_key AS k FROM invoice_estimate_links l
      JOIN cost_record_keys k ON k.record_id = l.invoiced_record_id
      WHERE l.kind = 'split' AND starts_with(k.source_key, ${prefix}) AND ${tx.unsafe(LIVE_KEY('k.source_key'))}`;
    return new Set(rows.map((r) => r.k));
  }

  /**
   * What this invoice's links keep out of the figures now, per estimate key (every row of it: entries, reversals and
   * re-entries), with the newest row for its dimensions. Before a locked month's void these come back as a restore.
   */
  private async hiddenBy(tx: Tx, prefix: string) {
    const rows = await tx<CostRow[]>`
      SELECT r.* FROM cost_records r
      WHERE r.basis = 'estimated' AND r.source NOT IN ('invoice', 'dev-anomaly') AND ${hiddenSql(tx, prefix)}
      ORDER BY r.recorded_at, r.record_id`;
    const byKey = new Map<string, { amount: Money; last: CostRecord }>();
    for (const row of rows) {
      const rec = fromRow(row);
      const k = byKey.get(rec.x_SourceKey);
      byKey.set(rec.x_SourceKey, {
        amount: (k?.amount ?? zero()).plus(rec.EffectiveCost),
        last: rec.x_CorrectionOfId ? (k?.last ?? rec) : rec,
      });
    }
    const byModel = new Map<string, Money>();
    for (const v of byKey.values())
      byModel.set(modelOf(v.last), (byModel.get(modelOf(v.last)) ?? zero()).plus(v.amount));
    return { byKey, byModel };
  }

  /**
   * An estimate back in the open month (an estimated Correction with the estimate's dimensions): what an invoice's
   * links keep out of a locked month once the invoice no longer bills it (a void, or a re-import without its model).
   */
  private restore(
    h: { amount: Money; last: CostRecord },
    prefix: string,
    key: string,
    openMonth: string,
    run: string,
    opts: { description: string },
  ): CostRecord {
    return assertValid({
      ...h.last,
      BilledCost: zero(),
      EffectiveCost: h.amount,
      ListCost: h.amount,
      ContractedCost: h.amount,
      ListUnitPrice: null,
      ContractedUnitPrice: null,
      PricingQuantity: null,
      PricingUnit: null,
      ConsumedQuantity: null,
      ConsumedUnit: null,
      ...billingPeriod(openMonth),
      ChargeClass: 'Correction',
      ChargeDescription: opts.description,
      x_RecordId: newId('rec'),
      x_Basis: 'estimated',
      x_Source: 'invoice',
      x_SourceKey: `${prefix}restore:${key}`,
      x_SourceCost: h.amount.toDecimal(),
      x_RateCardVersion: null,
      x_IngestRunId: run,
      x_CorrectionOfId: null,
    });
  }

  /** The estimate keys an invoice's live records claim, by any link (split, late or trued_up). */
  private async claims(tx: Tx, prefix: string): Promise<Set<string>> {
    const rows = await tx<{ k: string }[]>`
      SELECT DISTINCT l.estimated_source_key AS k FROM invoice_estimate_links l
      JOIN cost_record_keys k ON k.record_id = l.invoiced_record_id
      WHERE starts_with(k.source_key, ${prefix}) AND ${tx.unsafe(LIVE_KEY('k.source_key'))}`;
    return new Set(rows.map((r) => r.k));
  }

  /** An invoiced record of `inv` with `cost` (the shape every line, share and true-up starts from). */
  private base(inv: ParsedInvoice, l: InvoiceLine | null, model: string, cost: Money, run: string, dev: boolean) {
    const sku = l?.sku ?? model;
    const rec: CostRecord = {
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
      ServiceCategory: AI,
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
        ...(dev ? { origin: DEV_FIXTURE } : {}),
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
    return rec;
  }

  /**
   * The records an invoice should hold now, and its links.
   *
   * An open month: each model's Usage lines split over its estimates (`split` links), or on their own without one.
   * A locked month (or one before a locked month): per model, its records net to R = T − E + H, where T is what the
   * invoice bills for it, E the estimates it claims (every one no other live invoice claims) and H what its links keep
   * out of the figures (shares posted before the lock). Records already booked stay; one true-up in the open month
   * makes up the rest, and carries `trued_up` links to the estimates it claims, so no later invoice subtracts them
   * again. Every other line posts on its own (in the open month when locked). Dev fixtures link nothing.
   */
  private desired(
    inv: ParsedInvoice,
    ctx: {
      estimates: Map<string, CostRecord[]>;
      locked: boolean;
      openMonth: string;
      run: string;
      dev: boolean;
      live: Map<string, CostRecord>;
      hidden: { byKey: Map<string, { amount: Money; last: CostRecord }>; byModel: Map<string, Money> };
      split: Set<string>;
    },
  ): { records: CostRecord[]; links: { estimateKey: string; key: string; kind: 'split' | 'trued_up' }[] } {
    const { estimates, locked, openMonth, run, dev, live, split } = ctx;
    const hidden = ctx.hidden.byModel;
    const records: CostRecord[] = [];
    const links: { estimateKey: string; key: string; kind: 'split' | 'trued_up' }[] = [];
    const prefix = prefixOf(inv.providerKey, inv.number);
    const usage = new Map<string, InvoiceLine[]>();
    for (const l of inv.lines)
      if (l.chargeCategory === 'Usage' && l.model)
        usage.set(modelKey(l.model), [...(usage.get(modelKey(l.model)) ?? []), l]);
    const inOpenMonth = (r: CostRecord): CostRecord =>
      locked ? { ...r, ...billingPeriod(openMonth), ChargeClass: 'Correction' } : r;
    // Every other line posts on its own (credits, tax, purchases, lines naming only a SKU).
    const lineKeys = new Set<string>();
    for (const l of inv.lines) {
      if (l.chargeCategory === 'Usage' && l.model) continue;
      const key = `${prefix}line:${l.line}`;
      lineKeys.add(key);
      records.push(
        inOpenMonth({
          ...this.base(inv, l, l.model ?? OTHER_CHARGES, l.amount, run, dev),
          ChargeDescription: `${l.chargeCategory} on ${inv.provider} invoice ${inv.number}, line ${l.line}${l.description ? `: ${l.description}` : ''}`,
          x_SourceKey: key,
        }),
      );
    }
    if (locked) {
      const liveUsage = new Map<string, CostRecord[]>();
      for (const r of live.values()) {
        const k = baseKey(r.x_SourceKey);
        if (r.x_Basis !== 'invoiced' || r.ChargeCategory !== 'Usage' || lineKeys.has(k)) continue;
        if (k.startsWith(`${prefix}trueup:`) || k.startsWith(`${prefix}restore:`)) continue;
        liveUsage.set(modelOf(r), [...(liveUsage.get(modelOf(r)) ?? []), { ...r, x_SourceKey: k }]);
      }
      const models = new Set([...usage.keys(), ...liveUsage.keys(), ...hidden.keys()]);
      for (const model of [...models].sort()) {
        const lines = usage.get(model) ?? [];
        // A model this version no longer bills gives up every claim (review of wave 4, B1): what its links still keep
        // out of the locked month (read after its records were reversed) comes back in the open month as restores,
        // one per estimate, as a void books them; no record or link of it claims an estimate any more.
        if (!lines.length) {
          for (const [key, h] of ctx.hidden.byKey)
            if (modelOf(h.last) === model && !h.amount.isZero())
              records.push(
                this.restore(h, prefix, key, openMonth, run, {
                  description: `Estimate back: ${h.last.ResourceName ?? model} is no longer on ${inv.provider} invoice ${inv.number}; it stays replaced in locked ${inv.month}`,
                }),
              );
          continue;
        }
        const ests = estimates.get(model) ?? [];
        const t = Money.sum(
          lines.map((l) => l.amount),
          USD,
        );
        const e = Money.sum(
          ests.map((x) => x.EffectiveCost),
          USD,
        );
        const h = hidden.get(model) ?? zero();
        const kept = liveUsage.get(model) ?? [];
        records.push(...kept);
        const keptSum = Money.sum(
          kept.map((r) => r.EffectiveCost),
          USD,
        );
        const trueUp = t.minus(e).plus(h).minus(keptSum);
        const unclaimed = ests.filter((x) => !split.has(x.x_SourceKey));
        // A billed model always holds a record, even at $0.00 (review of wave 4, B1): a later estimate is linked
        // `late` to it, so it never counts beside the invoice.
        if (trueUp.isZero() && !unclaimed.length && kept.length) continue;
        const display = lines[0]!.model!;
        const qty = lines.every((l) => l.quantity) ? lines.reduce((a, l) => a.plus(l.quantity!), Decimal.ZERO) : null;
        const unit = lines.every((l) => l.unit === lines[0]!.unit) ? lines[0]!.unit : null;
        const key = `${prefix}trueup:${model}`;
        const lineNos = lines.map((l) => l.line).join(', ');
        records.push(
          inOpenMonth({
            ...this.base(inv, lines[0]!, display, trueUp, run, dev),
            ChargeCategory: 'Usage',
            ChargeFrequency: 'Usage-Based',
            ConsumedQuantity: qty && unit ? qty : null,
            ConsumedUnit: qty && unit ? unit : null,
            ChargeDescription: `${display} on ${inv.provider} invoice ${inv.number} (line ${lineNos}): ${amount(t)} invoiced less ${amount(e)} estimated${h.isZero() ? '' : `, ${amount(h)} of it replaced before the lock`}${keptSum.isZero() ? '' : ` and ${amount(keptSum)} posted then`}, in locked ${inv.month}`,
            x_SourceKey: key,
          }),
        );
        if (!dev) for (const x of unclaimed) links.push({ estimateKey: x.x_SourceKey, key, kind: 'trued_up' });
      }
      return { records, links };
    }
    // An open month: Usage by model, over the estimates or on its own.
    for (const [model, lines] of usage) {
      const total = Money.sum(
        lines.map((l) => l.amount),
        USD,
      );
      const lineNos = lines.map((l) => l.line).join(', ');
      const ests = estimates.get(model) ?? [];
      const display = lines[0]!.model!;
      if (!ests.length) {
        lines.forEach((l) =>
          records.push({
            ...this.base(inv, l, display, l.amount, run, dev),
            ChargeDescription: `${display} on ${inv.provider} invoice ${inv.number}, line ${l.line}; no estimate to replace`,
            // The model is in the key (review of wave 4, B1): a `late` link names this line's key, so a re-issued
            // invoice that puts another charge on the same line number must never keep that estimate replaced.
            x_SourceKey: `${prefix}line:${l.line}:${model}`,
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
          Tags: {
            ...((e.Tags ?? {}) as Record<string, never>),
            invoice: inv.number,
            ...(dev ? { origin: DEV_FIXTURE } : {}),
          },
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
        if (!dev) links.push({ estimateKey: e.x_SourceKey, key, kind: 'split' });
      });
    }
    return { records, links };
  }

  private async post(
    tx: Tx,
    inv: ParsedInvoice,
    by: Principal,
    userId: string,
    input: { fileName?: string; note: string; origin: 'entered' | 'dev-fixture'; fileSha: string },
    /** Re-plan the provider's other live invoices of the month if this version frees estimates (false in a re-plan). */
    replan = true,
  ): Promise<{ id: string; months: string[] }> {
    const id = invoiceId(inv.providerKey, inv.number);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`invoice:${id}`}))`;
    const [prev] = await tx<InvoiceRow[]>`SELECT * FROM invoices WHERE id = ${id} ORDER BY version DESC LIMIT 1`;
    // Should-fix 8: an invoice keeps its month; to move it, void it first.
    if (prev && prev.status === 'posted' && day(prev.month).slice(0, 7) !== inv.month)
      throw new ApiError(
        'conflict',
        `Invoice ${inv.number} is posted for ${day(prev.month).slice(0, 7)}: void it before importing it for ${inv.month}`,
      );
    if (prev && prev.status === 'posted' && prev.origin !== input.origin)
      throw new ApiError(
        'conflict',
        `Invoice ${inv.number} was imported as ${prev.origin}: void it before importing it as ${input.origin}`,
      );
    const dev = input.origin === 'dev-fixture';
    const periods = await periodsIn(tx, this.now());
    const locked = periods.isLocked(inv.month);
    const { openMonth } = periods;
    const run = newId('run');
    await tx`
      INSERT INTO ingest_runs (id, source, kind, day, params, started_by)
      VALUES (${run}, 'invoice', 'manual', ${`${inv.month}-01`},
              ${tx.json({ invoice: inv.number, provider: inv.provider, origin: input.origin, version: (prev?.version ?? 0) + 1 })},
              ${userId})`;
    const prefix = prefixOf(inv.providerKey, inv.number);
    const claimedBefore = dev || !replan ? new Set<string>() : await this.claims(tx, prefix);
    const plan = async (live: Map<string, CostRecord>) =>
      this.desired(inv, {
        estimates: dev ? new Map() : await this.estimatesOf(tx, inv.providerKey, prefix, inv.month),
        locked,
        openMonth,
        run,
        dev,
        live,
        hidden: locked && !dev ? await this.hiddenBy(tx, prefix) : { byKey: new Map(), byModel: new Map() },
        split: locked && !dev ? await this.splitClaims(tx, prefix) : new Set(),
      });
    const ctx = { ingestRunId: run, newId: () => newId('rec') };
    const months = new Set<string>();
    let reversed = 0;
    let live = await this.liveOf(tx, prefix);
    // A locked month: the records this version no longer wants are reversed first, so what the links still keep out
    // is read after the reversals, as a void reads it (review of wave 4, B1). Otherwise an estimate linked `late` to
    // a reversed record would come back twice: once itself, and once in a restore.
    if (locked && !dev) {
      const first = new Set((await plan(live)).records.map((r) => `${r.x_Basis}:${r.x_SourceKey}`));
      const gone = [...live].filter(([key]) => !first.has(key)).flatMap(([, old]) => correct(old, null, periods, ctx));
      if (gone.length) {
        await tx`INSERT INTO cost_records ${tx(gone.map((r) => toRow(assertValid(r))))}`;
        gone.forEach((r) => months.add(r.BillingPeriodStart.slice(0, 7)));
        reversed += gone.length;
        live = await this.liveOf(tx, prefix);
      }
    }
    const want = await plan(live);
    const toAppend: CostRecord[] = [];
    let added = 0;
    let fresh = 0;
    let unchanged = 0;
    const entered = new Map<string, string>();
    for (const r of want.records) {
      const old = live.get(`${r.x_Basis}:${r.x_SourceKey}`);
      if (old && fingerprint(old) === fingerprint(r)) {
        unchanged++;
        entered.set(r.x_SourceKey, old.x_RecordId);
        continue;
      }
      if (old) {
        const [rev, again] = correct(
          old,
          {
            ...r,
            x_SourceKey: old.x_SourceKey,
            ChargePeriodStart: old.ChargePeriodStart,
            ChargePeriodEnd: old.ChargePeriodEnd,
          },
          periods,
          ctx,
        );
        toAppend.push(rev!, again!);
        entered.set(r.x_SourceKey, again!.x_RecordId);
        reversed++;
        added++;
      } else {
        const rec = assertValid({ ...r, x_SourceKey: await this.freshKey(tx, r.x_SourceKey, r.x_Basis) });
        toAppend.push(rec);
        entered.set(r.x_SourceKey, rec.x_RecordId);
        added++;
        fresh++;
      }
    }
    const wanted = new Set(want.records.map((r) => `${r.x_Basis}:${r.x_SourceKey}`));
    for (const [key, old] of live)
      if (!wanted.has(key)) {
        toAppend.push(...correct(old, null, periods, ctx));
        reversed++;
      }
    if (toAppend.length) {
      await tx`INSERT INTO cost_records ${tx(toAppend.map((r) => toRow(assertValid(r))))}`;
      toAppend.forEach((r) => months.add(r.BillingPeriodStart.slice(0, 7)));
    }
    let linked = 0;
    for (const l of want.links) {
      const recordId = entered.get(l.key)!;
      const res = await tx`
        INSERT INTO invoice_estimate_links (estimated_source_key, invoiced_record_id, month, linked_by, note, kind)
        VALUES (${l.estimateKey}, ${recordId}, ${`${inv.month}-01`}, ${userId}, ${`invoice ${inv.number}`}, ${l.kind})
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
                            added, reversed, unchanged, linked, ingest_run_id, file_name, file_sha256, note, imported_by,
                            imported_at)
      VALUES (${id}, ${version}, ${inv.provider}, ${inv.number}, ${`${inv.month}-01`}, 'posted', ${input.origin},
              ${total.micros.toString()}, ${USD}, ${locked}, ${added}, ${reversed}, ${unchanged}, ${want.links.length},
              ${run}, ${input.fileName ?? null}, ${input.fileSha}, ${input.note}, ${userId}, ${this.now()})`;
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
    // Estimates this version gave up (a model no longer billed) are free again: every other live invoice of the
    // provider and month re-plans over them, as after a void, so none counts beside an invoice that bills its model
    // (review of wave 4, B1).
    if (claimedBefore.size) {
      const after = await this.claims(tx, prefix);
      if ([...claimedBefore].some((k) => !after.has(k)))
        await this.replanOthers(tx, inv.provider, inv.number, inv.month, id, by, userId, months);
    }
    return { id, months: [...months] };
  }

  /** Re-posts the provider's other live invoices of a month over the estimates as they now stand. */
  private async replanOthers(
    tx: Tx,
    provider: string,
    number: string,
    month: string,
    exceptId: string,
    by: Principal,
    userId: string,
    months: Set<string>,
    why = 'was re-imported without a model it billed',
  ) {
    for (const other of await this.othersOf(tx, provider.toLowerCase(), month, exceptId)) {
      const r = await this.post(
        tx,
        other.inv,
        by,
        userId,
        {
          fileName: other.fileName ?? undefined,
          note: `Re-planned after ${provider} invoice ${number} ${why}`,
          origin: 'entered',
          fileSha: other.fileSha,
        },
        false,
      );
      r.months.forEach((m) => months.add(m));
    }
  }

  /**
   * Reverses an invoice whole. In an open month its estimates count again at once. In a locked month (or one before a
   * locked month) they stay out of that month, which never moves: each comes back in the open month as a restore (an
   * estimated Correction with the estimate's dimensions), so the totals are the estimates again. A version `voided`.
   */
  async void(id: string, reason: string, by: Principal): Promise<InvoiceView> {
    const [head] = await this.sql<InvoiceRow[]>`SELECT * FROM invoices WHERE id = ${id} ORDER BY version DESC LIMIT 1`;
    if (!head) throw notFound('Invoice');
    const userId = this.who(by, head.origin, 'void');
    const months = new Set<string>();
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`invoice:${id}`}))`;
      const [prev] = await tx<InvoiceRow[]>`SELECT * FROM invoices WHERE id = ${id} ORDER BY version DESC LIMIT 1`;
      if (!prev) throw notFound('Invoice');
      if (prev.status === 'voided') throw new ApiError('conflict', `Invoice ${prev.number} is voided already`);
      const month = day(prev.month).slice(0, 7);
      const periods = await periodsIn(tx, this.now());
      const locked = periods.isLocked(month);
      const run = newId('run');
      await tx`
        INSERT INTO ingest_runs (id, source, kind, day, params, started_by)
        VALUES (${run}, 'invoice', 'manual', ${`${month}-01`},
                ${tx.json({ invoice: prev.number, provider: prev.provider, void: true, reason })}, ${userId})`;
      const prefix = prefixOf(prev.provider.toLowerCase(), prev.number);
      const live = await this.liveOf(tx, prefix);
      const out = [...live.values()].flatMap((r) =>
        correct(r, null, periods, { ingestRunId: run, newId: () => newId('rec') }),
      );
      if (out.length) await tx`INSERT INTO cost_records ${tx(out.map((r) => toRow(r)))}`;
      // What the links still keep out (a locked month's shares): back in the open month, per estimate.
      const restores: CostRecord[] = [];
      if (locked)
        for (const [key, h] of (await this.hiddenBy(tx, prefix)).byKey) {
          if (h.amount.isZero()) continue;
          restores.push(
            this.restore(h, prefix, key, periods.openMonth, run, {
              description: `Estimate back after ${prev.provider} invoice ${prev.number} was voided; it stays replaced in locked ${month}`,
            }),
          );
        }
      if (restores.length) await tx`INSERT INTO cost_records ${tx(restores.map((r) => toRow(r)))}`;
      [...out, ...restores].forEach((r) => months.add(r.BillingPeriodStart.slice(0, 7)));
      await tx`
        INSERT INTO invoices (id, version, provider, number, month, status, origin, total_micros, currency, correction,
                              added, reversed, unchanged, linked, ingest_run_id, file_name, file_sha256, note, imported_by,
                              imported_at)
        SELECT id, version + 1, provider, number, month, 'voided', origin, total_micros, currency, ${locked},
               ${restores.length}, ${out.length}, 0, 0, ${run}, file_name, file_sha256, ${reason}, ${userId}, ${this.now()}
        FROM invoices WHERE id = ${id} AND version = ${prev.version}`;
      await tx`
        INSERT INTO invoice_lines (invoice_id, version, line, model, sku, quantity, unit, amount_micros, charge_category, description)
        SELECT invoice_id, version + 1, line, model, sku, quantity, unit, amount_micros, charge_category, description
        FROM invoice_lines WHERE invoice_id = ${id} AND version = ${prev.version}`;
      await tx`
        UPDATE ingest_runs SET finished_at = clock_timestamp(), outcome = 'succeeded', read_count = 0,
          new_count = ${restores.length}, corrected_count = ${out.length} WHERE id = ${run}`;
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
            restored: restores.length,
            origin: prev.origin,
            reason,
          },
        },
        tx,
      );
      // The estimates it claimed are free again: every other live invoice of the provider and month re-plans its
      // split over them (a new version each), so they never count beside an invoice that bills their model.
      if (prev.origin !== 'dev-fixture')
        await this.replanOthers(tx, prev.provider, prev.number, month, id, by, userId, months, 'was voided');
    });
    await this.afterPost([...months]);
    return this.view(id);
  }

  /** The other live (entered) invoices of a provider and month, as their lines stand: what a void re-plans. */
  private async othersOf(tx: Tx, providerKey: string, month: string, exceptId: string) {
    const heads = await tx<(InvoiceRow & { file_name: string | null })[]>`
      SELECT DISTINCT ON (id) * FROM invoices
      WHERE lower(provider) = ${providerKey} AND month = ${`${month}-01`} AND id <> ${exceptId}
      ORDER BY id, version DESC`;
    const out: { inv: ParsedInvoice; fileName: string | null; fileSha: string }[] = [];
    for (const h of heads.filter((x) => x.status === 'posted' && x.origin === 'entered')) {
      const lines = await tx<LineRow[]>`
        SELECT * , quantity::text AS quantity, amount_micros::text AS amount_micros FROM invoice_lines
        WHERE invoice_id = ${h.id} AND version = ${h.version} ORDER BY line`;
      out.push({
        inv: {
          provider: h.provider,
          providerKey,
          number: h.number,
          month,
          lines: lines.map((l) => ({
            line: l.line,
            model: l.model,
            sku: l.sku,
            quantity: l.quantity === null ? null : Decimal.parse(l.quantity),
            unit: l.unit,
            amount: Money.ofMicros(l.amount_micros, USD),
            chargeCategory: l.charge_category as ChargeCategory,
            description: l.description,
          })),
        },
        fileName: h.file_name,
        fileSha: h.file_sha256,
      });
    }
    return out;
  }

  /**
   * Ingest calls this with the estimates it just entered: one charged in a month whose provider and model a live
   * invoice already bills is linked `late` to it, so it never counts on top of the invoice; its row says "estimates
   * after invoice: re-reconcile" until the next import or void re-plans the split. Returns how many it linked.
   */
  async coverLate(tx: Tx, records: readonly CostRecord[]): Promise<number> {
    let n = 0;
    for (const r of records) {
      if (r.x_Basis !== 'estimated' || r.x_CorrectionOfId || r.ServiceCategory !== AI) continue;
      if (r.x_Source === 'invoice' || r.x_Source === 'dev-anomaly') continue;
      const tags = (r.Tags ?? {}) as Record<string, unknown>;
      const provider = (typeof tags.provider === 'string' ? tags.provider : r.ServiceProviderName).toLowerCase();
      const month = r.ChargePeriodStart.slice(0, 7);
      const billed = r.BillingPeriodStart.slice(0, 10);
      const [target] = await tx<{ record_id: string }[]>`
        SELECT r.record_id FROM cost_records r
        WHERE r.source = 'invoice' AND r.basis = 'invoiced' AND r.charge_category = 'Usage'
          AND ${tx.unsafe(PROVIDER)} = ${provider}
          AND lower(coalesce(r.tags->>'model', ${OTHER_CHARGES})) = ${modelOf(r)}
          AND coalesce(r.tags->>'origin', '') <> ${DEV_FIXTURE}
          AND r.charge_period_start >= ${monthStart(month)}::timestamptz
          AND r.charge_period_start < ${monthStart(nextMonth(month))}::timestamptz
          AND r.billing_period_start <= ${billed}::timestamptz AND ${tx.unsafe(LIVE)}
        ORDER BY r.recorded_at, r.record_id LIMIT 1`;
      if (!target) continue;
      const res = await tx`
        INSERT INTO invoice_estimate_links (estimated_source_key, invoiced_record_id, month, linked_by, note, kind)
        VALUES (${r.x_SourceKey}, ${target.record_id}, ${billed}, 'invoices', 'arrived after its month was invoiced', 'late')
        ON CONFLICT DO NOTHING`;
      n += res.count;
    }
    return n;
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

  /** The invoices of a month (each at its newest version in that month; a month changes only after a void). */
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

  /**
   * Per provider × model charged in `month`: every live AI estimate (entries and reversals net, wherever booked; never
   * a restore), how many of them arrived after their month was invoiced and wait for a re-import, and what the month's
   * posted invoices bill (their lines at each invoice's newest version), real and dev fixtures apart.
   */
  private async aiByModel(tx: Tx, month: string, providerKey?: string) {
    const estimated = await tx<{ provider: string; model: string; micros: string; n: number; late: number }[]>`
      SELECT ${tx.unsafe(PROVIDER)} AS provider,
             lower(coalesce(r.tags->>'model', ${OTHER_CHARGES})) AS model,
             sum(r.effective_cost_micros)::text AS micros,
             (count(*) FILTER (WHERE ${tx.unsafe(LIVE)}))::int AS n,
             (count(*) FILTER (WHERE ${tx.unsafe(LIVE)} AND EXISTS (
                SELECT 1 FROM invoice_estimate_links l JOIN cost_record_keys k ON k.record_id = l.invoiced_record_id
                WHERE l.estimated_source_key = r.source_key AND l.kind = 'late' AND ${tx.unsafe(LIVE_KEY('k.source_key'))})
              AND NOT EXISTS (
                SELECT 1 FROM invoice_estimate_links l JOIN cost_record_keys k ON k.record_id = l.invoiced_record_id
                WHERE l.estimated_source_key = r.source_key AND l.kind <> 'late' AND ${tx.unsafe(LIVE_KEY('k.source_key'))})))::int AS late
      FROM cost_records r
      WHERE r.charge_period_start >= ${monthStart(month)}::timestamptz
        AND r.charge_period_start < ${monthStart(addMonths(month, 1))}::timestamptz
        AND r.service_category = ${AI} AND r.basis = 'estimated' AND r.source NOT IN ('invoice', 'dev-anomaly')
        ${providerKey ? tx`AND ${tx.unsafe(PROVIDER)} = ${providerKey}` : tx``}
      GROUP BY 1, 2`;
    const invoiced = await tx<
      { provider: string; model: string; micros: string; n: number; invoices: string[]; dev: boolean }[]
    >`
      WITH latest AS (
        SELECT DISTINCT ON (id) id, version, provider, number, status, origin FROM invoices
        WHERE month = ${`${month}-01`} ORDER BY id, version DESC)
      SELECT lower(i.provider) AS provider, lower(coalesce(l.model, ${OTHER_CHARGES})) AS model,
             sum(l.amount_micros)::text AS micros, count(*)::int AS n, array_agg(DISTINCT i.number) AS invoices,
             i.origin = ${DEV_FIXTURE} AS dev
      FROM latest i JOIN invoice_lines l ON l.invoice_id = i.id AND l.version = i.version
      WHERE i.status = 'posted' ${providerKey ? tx`AND lower(i.provider) = ${providerKey}` : tx``}
      GROUP BY 1, 2, 6`;
    return { estimated, invoiced };
  }

  private async rows(tx: Tx, month: string, providerKey?: string): Promise<ReconciliationRow[]> {
    const { estimated, invoiced } = await this.aiByModel(tx, month, providerKey);
    const key = (p: string, m: string) => `${p}\u0000${m}`;
    const est = new Map(estimated.map((r) => [key(r.provider, r.model), r]));
    const out: ReconciliationRow[] = [];
    const row = (
      provider: string,
      model: string,
      e: (typeof estimated)[number] | undefined,
      i: (typeof invoiced)[number] | undefined,
      devFixture: boolean,
    ): ReconciliationRow => {
      const em = Money.ofMicros(e?.micros ?? '0', USD);
      const im = Money.ofMicros(i?.micros ?? '0', USD);
      const r = reconcile(em, im, { estimates: e?.n ?? 0, invoiced: i?.n ?? 0 }, this.tolerance, this.floor);
      const late = devFixture ? 0 : (e?.late ?? 0);
      return {
        provider,
        model,
        month,
        estimated: amount(em),
        invoiced: amount(im),
        variance: amount(r.variance),
        variancePct: r.variancePct,
        status: r.status,
        invoices: [...(i?.invoices ?? [])].sort(),
        devFixture,
        lateEstimates: late,
        note: late ? 'estimates after invoice: re-reconcile' : null,
      };
    };
    const real = invoiced.filter((i) => !i.dev);
    for (const i of real) out.push(row(i.provider, i.model, est.get(key(i.provider, i.model)), i, false));
    for (const e of estimated)
      if (!real.some((i) => key(i.provider, i.model) === key(e.provider, e.model)) && e.n > 0)
        out.push(row(e.provider, e.model, e, undefined, false));
    for (const i of invoiced.filter((x) => x.dev))
      out.push(row(i.provider, i.model, est.get(key(i.provider, i.model)), i, true));
    return out.sort(
      (a, b) =>
        Number(a.devFixture) - Number(b.devFixture) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );
  }

  /** A provider's rows as they stood at an import, kept (append only). */
  private async snapshot(tx: Tx, id: string, version: number, month: string, providerKey: string) {
    const rows = (await this.rows(tx, month, providerKey)).filter((r) => !r.devFixture);
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

  /** Reconciliation for a month: every provider × model with an estimate or an invoice line; dev fixtures apart. */
  async reconciliation(month?: string): Promise<ReconciliationView> {
    const m = month ?? this.now().toISOString().slice(0, 7);
    const rows = await this.rows(this.sql, m);
    const real = rows.filter((r) => !r.devFixture);
    const est = Money.sum(
      real.map((r) => Money.parse(r.estimated, USD)),
      USD,
    );
    const inv = Money.sum(
      real.map((r) => Money.parse(r.invoiced, USD)),
      USD,
    );
    const r = reconcile(est, inv, { estimates: 1, invoiced: 1 }, this.tolerance, this.floor);
    // The share invoiced of AI spend as every figure shows it (each charge once; dev fixtures never).
    const { lines } = await this.spend.lines({ fromMonth: m, toMonth: m }, false);
    const ai = lines.filter((l) => l.serviceCategory === AI);
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
      toleranceUsd: amount(Money.parse(this.floor, USD)),
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
        lateEstimates: real.reduce((n, x) => n + x.lateEstimates, 0),
      },
      invoices: await this.list(m),
    };
  }

  /**
   * An approved request from decision to bill, on one basis: its matched cost as every figure shows it (each charge
   * once, invoiced where invoiced), above its baseline, from its first day. Consumed is that, uncapped, so an overrun
   * shows; Invoiced is the invoiced share of it, so it never exceeds Consumed; the variance is Consumed against what
   * was approved for the months so far. Without a selector nothing matches it.
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
        baseline_daily_micros: string | null;
      }[]
    >`SELECT month, amount_micros::text, consumed_micros::text, status, created_at, from_day,
             baseline_daily_micros::text FROM reservations
      WHERE request_id = ${r.id} ORDER BY month`;
    const reserved = Money.sum(
      res.map((x) => Money.ofMicros(x.amount_micros, USD)),
      USD,
    );
    const current = this.now().toISOString().slice(0, 7);
    const today = this.now().toISOString().slice(0, 10);
    const months = res.map((x) => day(x.month).slice(0, 7)).filter((m) => m <= current);
    const approvedToDate = Money.sum(
      months.map((m) => addsInMonth(r, m)),
      USD,
    );
    const selector = selectorOf(r.evidence);
    let consumed = zero();
    let matched = zero();
    let matchedInvoiced = zero();
    if (selector)
      for (const m of months) {
        const from = res.find((x) => day(x.month).slice(0, 7) === m)!;
        const baseline = Money.ofMicros(from.baseline_daily_micros ?? '0', USD);
        const { lines } = await this.spend.lines({ fromMonth: m, toMonth: m }, false);
        const byDay = new Map<string, Money>();
        for (const l of lines)
          if (l.day >= day(from.from_day) && l.day <= today && lineMatches(l, r.cost_center, selector)) {
            matched = matched.plus(l.amount);
            if (l.basis === 'invoiced') matchedInvoiced = matchedInvoiced.plus(l.amount);
            byDay.set(l.day, (byDay.get(l.day) ?? zero()).plus(l.amount));
          }
        for (const v of byDay.values()) {
          const above = v.minus(baseline);
          if (above.sign() > 0) consumed = consumed.plus(above);
        }
      }
    const share = invoicedShare(matchedInvoiced, matched, !matchedInvoiced.isZero());
    // The invoiced part of what it consumed, in proportion to how much of its matched cost is invoiced.
    const invoiced = matched.isZero()
      ? zero()
      : Money.fromDecimal(
          consumed.toDecimal().times(matchedInvoiced.toDecimal()).divide(matched.toDecimal(), 6, 'halfEven'),
          USD,
        );
    const variance = consumed.minus(approvedToDate);
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
            ? 'Its matched cost above the baseline, from its first day, as every figure shows it (uncapped)'
            : 'No match selector: nothing consumes it, and each month is released when it ends',
        },
        {
          key: 'invoiced',
          label: 'Invoiced',
          amount: amount(invoiced),
          at: null,
          note: selector
            ? `${share}% of its matched cost is invoiced: that share of what it consumed; the rest is estimated`
            : 'Nothing matches it, so nothing is invoiced against it',
        },
      ],
      approvedToDate: amount(approvedToDate),
      actualToDate: amount(consumed),
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
