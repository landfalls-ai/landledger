# Money

How Landledger keeps amounts exact: `libs/money` (`@landledger/money`) and the money columns of `cost_records`.
Spec: [specs/001-money-and-records](../specs/001-money-and-records/spec.md). Research:
[research/focus.md](research/focus.md) §2 and §6.

## Units

- An amount is a **bigint of micro-units** (10⁻⁶ of the major unit) with an ISO 4217 code: `Money.micros`, and
  `*_micros bigint` plus `billing_currency char(3)` in Postgres. One scale for every currency (a JPY amount is
  micro-yen), so a sum never mixes scales. Postgres `bigint` holds ±9.2 trillion major units; `Money` refuses anything
  beyond (`MoneyOverflowError`).
- Not cents: an AI call costs fractions of a cent (1,200 input and 380 output tokens of a $1 / $5 per million model is
  $0.0031), and FOCUS's own detail runs to six decimals. A hundred such calls are $0.31, not a hundred rounded zeros.
- **Rates and quantities** are exact `Decimal`s (a bigint coefficient and a scale, up to 18 decimals when parsed) with a
  unit in FOCUS Unit Format: `Rate.of('3', 'USD', '1000000 Tokens')`, `Quantity.of('2400000', 'Tokens')`. A quantity
  is expressed in the rate's unit before multiplying (2,400,000 Tokens is 2.4 × `1000000 Tokens`).
- **No floats.** `Decimal`, `Money` and `Quantity` take strings, bigints or each other; a `number` is a type error and
  is refused at runtime too, as are `1e-3`, `NaN`, `Infinity`, `+1` and empty strings. Postgres returns `bigint` and
  `numeric` as strings, which they take exactly. On the wire an amount is a decimal string (`"-0.003100"`), never a JSON
  number (`MoneyJson`, `toWire`).

## Two rounding modes, each with one job

| When | Mode | Why |
|---|---|---|
| A computed amount becomes micro-units: `Money.fromProduct(rate, quantity)`, an FX conversion | `halfEven` (banker's) | Millions of rows are rounded and then summed; half-even has no upward bias, so the sum stays inside FOCUS's tolerance |
| An amount is posted or shown at the currency's minor unit (USD 2, JPY 0, BHD 3): `toMinor()`, `posted()`, `toCsv()`, `formatMoney()` | `halfAwayFromZero` | What finance means by rounding, what Excel's `ROUND` and invoices do, so a figure on screen matches the one an analyst recomputes from the export |

Every other operation is exact: adding, subtracting, negating, comparing, splitting. `Decimal.divide` is the one
inexact operation and asks for a scale and a mode.

FOCUS's reconciliation tolerance, `MAX(100 × subunit, √rows × 0.5 × subunit)`, is `withinFocusTolerance(difference,
rows)`, computed in integers.

## Splits

`split(amount, weights)` floors each share to the micro-unit and gives the micro-units left over one at a time to the
parts with the largest fractional remainders, ties to the lowest index; zero weights get nothing; a negative amount
splits like its absolute value, negated. The parts always add up to the amount exactly. Allocation (spec 003) and the
cluster split (spec 002) both use it.

## FX

One reporting currency, USD (decision 6). `convert(amount, to, date, lookup)` uses the latest recorded rate for the
latest date on or before `date`, rounds half-even to the micro-unit and returns the rate's id beside the amount; it
refuses when there is none and never derives an inverse. USD → USD needs no rate. `fx_rates` is append-only: a later
rate for the same pair and date supersedes an earlier one.

A charge in another currency is converted when it is entered, and keeps where it came from: `x_OriginalCost`,
`x_OriginalCurrency` and `x_FxRateId` (columns `original_cost`, `original_currency`, `fx_rate_id` → `fx_rates`,
migration 0006) hold the source's amount, its currency and the rate used, all three or none, never the billing
currency itself; a reversal negates `x_OriginalCost` too. The ledger's amounts stay in USD. A record whose amounts are
themselves in another currency never reaches a sum: reads refuse it by name (`reportingAmount`), and `Money.sum`
throws `CurrencyMismatchError` on mixed currencies, so a conversion is always explicit and dated.

## Estimated and invoiced

Every figure is labelled `estimated` or `invoiced`, and the two are never added for the same charge. When an invoice
line arrives it is entered as an `invoiced` record and linked to the estimates it replaces (`invoice_estimate_links`:
the estimate's source key, the invoice record, the billing month, who linked them; append-only, refused for a locked
month or across months). Every read leaves out an estimated record whose source key is linked to a live invoiced
record, so the charge counts once, at the invoiced figure; the estimate stays in the ledger as it was. Linking by
source key keeps a corrected estimate linked. (Wave 1 has no invoices yet; the table and the read rule are in place.)

## Records and corrections

Every `cost_records` row is a FOCUS 1.4 record (`libs/focus`): `x_Basis` says `estimated` (usage × rate card,
`BilledCost` 0, `EffectiveCost` = `ContractedCost`) or `invoiced` (`BilledCost` = `EffectiveCost` for usage).
`ListCost` and `ContractedCost` are the unit price × `PricingQuantity` to the micro-unit. `check(record)` returns every
rule a record breaks; the database repeats the rules it can.

Nothing is edited. A correction is FOCUS's ledger style:

- a **reversal**: every additive column (the four costs, `PricingQuantity`, `ConsumedQuantity`, `x_SourceCost`,
  `x_OriginalCost`) negated,
  every other column equal, `x_CorrectionOfId` = the original's `x_RecordId`;
- and, when the figure changed, a **re-entry** with the corrected values and the same `x_SourceKey`.

A source key has one live entry per basis: a re-entry is refused until the entry before it is reversed, and
`source_revision` counts them. In an open month both rows stay in the original's month with `ChargeClass` null. For a
**locked** month they go to the open month with `ChargeClass = Correction`, `BillingPeriod` the open month and
`ChargePeriod` the original day, so a locked month's totals never change.

## Periods

Each UTC month is `open → closing → locked`, one step at a time, never back. The first record of a month creates it
open; `closing` still takes ingest (rules and rate cards freeze for the month); `locked` is final (FOCUS's `Closed`)
and refuses inserts, in the database, for every role including the owner. Closing and locking need a person signed in
with Landbright (controller or CFO); an API key never does it, whatever its scope. Months lock in order.
