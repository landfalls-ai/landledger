# Feature 001: Money and cost records (wave 1)

**Status**: specified 2026-11-14 (wave 0) · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md)

## Why

Everything Landledger reports is a sum of cost records, so the records and the arithmetic under them come first. A
figure finance reads has to be exact (no float drift between Explore, a budget and an export), say whether it is an
estimate or an invoice, and stay what it was once its month is locked. This feature is `libs/money`, `libs/focus`,
the `cost_records`, `periods` and `fx_rates` tables, and the one way to correct a record.

Research: [docs/research.md](../../docs/research.md) D5–D9, [FOCUS 1.4](../../docs/research/focus.md).

## User stories

1. **As a finance analyst**, I read a day's AI cost as `$11.88` and its records add up to exactly that, in Explore, in
   the CSV and in Excel; a call that cost $0.0031 isn't rounded away before it is summed.
2. **As a finance analyst**, I see on every figure whether it is **estimated** (usage × rate card) or **invoiced**,
   and a total of invoiced cost never contains an estimate.
3. **As the controller**, I lock October; nothing anyone does afterwards changes an October total. Late usage for 30
   October appears in November as a correction line dated 30 October.
4. **As an engineer** writing ingest or allocation, I build a record through `libs/focus`, and it refuses a record that
   breaks a FOCUS rule or Landledger's own (a float, a missing unit, a cost that isn't price × quantity, a correction
   that doesn't reverse its original exactly).
5. **As an auditor**, I follow a correction to the record it reverses, and the rate card version that priced each one.
6. **As a finance analyst**, an amount in another currency is converted at the rate for its date, and the rate used is
   recorded beside it.

## Acceptance

- `libs/money` has no `number` arithmetic on amounts: amounts are `bigint` micro-units (10⁻⁶ of the major unit) with an
  ISO 4217 code; rates and quantities are exact decimals parsed from strings; a `number` passed where an amount, rate
  or quantity is expected is a type error, and a non-finite or float string is refused at runtime.
- Rounding is explicit and named: `halfEven` when a computed amount (price × quantity, an FX conversion) becomes
  micro-units; `halfAwayFromZero` when an amount is posted or shown at the currency's minor unit (USD 2, JPY 0, BHD 3).
  `split(amount, weights)` returns parts that sum exactly to the amount (largest remainder, ties to the lowest index).
- Property tests: Σ of split parts = the whole for any weights; `a + b − b = a`; a sum is the same in any order;
  rounding each row then summing never differs from the FOCUS tolerance `MAX(100 × subunit, √rows × 0.5 × subunit)`
  against rounding the sum.
- `libs/focus` exports the 45 kept FOCUS 1.4 columns and Landledger's `x_` columns with their types and nullability,
  a `check(record)` that returns every rule a record breaks, and the mapping between table columns and FOCUS names.
- `cost_records` accepts inserts only: an `UPDATE` or `DELETE` fails in the database, for the application role and for
  the owner alike. Inserting a record whose `BillingPeriod` is a locked month fails in the database.
- A record whose `x_Basis` is `estimated` has `BilledCost` 0; one that is `invoiced` has `BilledCost` = `EffectiveCost`
  for uncovered usage. `ListCost` = `ListUnitPrice` × `PricingQuantity` and `ContractedCost` = `ContractedUnitPrice` ×
  `PricingQuantity` to the micro-unit.
- `correct(original, replacement?)` appends a reversal (every additive column negated, every other column equal,
  `x_CorrectionOfId` = the original) and, when given, a re-entry. In an open month `ChargeClass` stays null; for a
  locked month both rows go to the open month with `ChargeClass = Correction` and the original `ChargePeriod`.
- `periods` move `open → closing → locked` only; locking needs a person (not an API key) and records who and when;
  a locked month can't be reopened.
- `fx_rates` is append-only; `convert(amount, to, date)` uses the latest recorded rate for the latest date on or before
  `date`, refuses when there is none, and returns the rate's id with the result. USD → USD needs no rate.
- `cost_records_focus` (a view) presents the table under FOCUS column names with decimal amounts, so an export is a
  select.

## Out of scope

Ingest and pricing (spec 002), allocation (spec 003), invoices and reconciliation (wave 3), budgets and requests
(waves 1–2), the console's figures (wave 1, on top of this), FX sources (one currency, USD, until a provider prices in
another), a FOCUS export file (wave 5 at the earliest).
