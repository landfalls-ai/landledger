import { assertValid, InvalidRecordError } from './check.js';
import { billingPeriod, monthOf } from './periods.js';
import { type CostRecord, ulid } from './record.js';

/** What `correct` needs to know about the months: which are locked and which is open now. */
export interface PeriodState {
  isLocked(month: string): boolean;
  /** The month a correction to a locked month is booked in (`YYYY-MM`). */
  openMonth: string;
}

export interface EntryContext {
  /** The ingest run (or manual run) appending the rows. */
  ingestRunId: string;
  /** Makes `x_RecordId`s; a ULID by default. */
  newId?: () => string;
}

/**
 * The reversal of a record (FOCUS ledger style, `correction_handling.md:49`): every additive column negated, every
 * other column equal, `x_CorrectionOfId` = the original. Booked in `billingMonth` (the original's month unless given);
 * when that differs from the original's charge month it is a `Correction`.
 */
export function reverse(
  original: CostRecord,
  ctx: EntryContext,
  billingMonth = monthOf(original.BillingPeriodStart),
): CostRecord {
  if (original.x_CorrectionOfId !== null)
    throw new InvalidRecordError([
      {
        column: 'x_CorrectionOfId',
        rule: 'reverse-reversal',
        message: 'A reversal is never reversed: re-enter instead',
      },
    ]);
  return assertValid({
    ...original,
    ...billingPeriod(billingMonth),
    ChargeClass: billingMonth === monthOf(original.ChargePeriodStart) ? null : 'Correction',
    BilledCost: original.BilledCost.negate(),
    EffectiveCost: original.EffectiveCost.negate(),
    ListCost: original.ListCost.negate(),
    ContractedCost: original.ContractedCost.negate(),
    PricingQuantity: original.PricingQuantity?.negate() ?? null,
    ConsumedQuantity: original.ConsumedQuantity?.negate() ?? null,
    x_SourceCost: original.x_SourceCost?.negate() ?? null,
    x_OriginalCost: original.x_OriginalCost?.negate() ?? null,
    x_RecordId: (ctx.newId ?? ulid)(),
    x_IngestRunId: ctx.ingestRunId,
    x_CorrectionOfId: original.x_RecordId,
  });
}

/**
 * Corrects a record: its reversal and, when given, a re-entry with the corrected values (same source key and basis,
 * same charge period). In an open month both stay in the original's month with no `ChargeClass`; if that month is
 * locked, both go to the open month with `ChargeClass = Correction` and the original charge dates
 * (`appendix/correction_handling_examples/closed_billing_period.md:11`). Nothing is edited.
 */
export function correct(
  original: CostRecord,
  replacement: CostRecord | null,
  periods: PeriodState,
  ctx: EntryContext,
): CostRecord[] {
  const own = monthOf(original.BillingPeriodStart);
  const month = periods.isLocked(own) ? periods.openMonth : own;
  if (periods.isLocked(month)) throw new RangeError(`${month} is locked: corrections go to an open month`);
  const reversal = reverse(original, ctx, month);
  if (!replacement) return [reversal];
  if (replacement.x_SourceKey !== original.x_SourceKey || replacement.x_Basis !== original.x_Basis)
    throw new InvalidRecordError([
      { column: 'x_SourceKey', rule: 're-entry-key', message: 'A re-entry keeps the source key and basis it corrects' },
    ]);
  if (
    replacement.ChargePeriodStart !== original.ChargePeriodStart ||
    replacement.ChargePeriodEnd !== original.ChargePeriodEnd
  )
    throw new InvalidRecordError([
      {
        column: 'ChargePeriodStart',
        rule: 're-entry-period',
        message: 'A re-entry keeps the charge period it corrects',
      },
    ]);
  const reentry = assertValid({
    ...replacement,
    ...billingPeriod(month),
    ChargeClass: reversal.ChargeClass,
    x_RecordId: (ctx.newId ?? ulid)(),
    x_IngestRunId: ctx.ingestRunId,
    x_CorrectionOfId: null,
  });
  return [reversal, reentry];
}
