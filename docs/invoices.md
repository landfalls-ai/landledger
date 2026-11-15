# Invoices and reconciliation

Wave 3, [spec 005](../specs/005-invoices/spec.md). Every AI figure starts as an estimate (tokens × the rate card,
[ingest.md](ingest.md)); a provider's invoice is what the company pays. Landledger posts the invoice beside the
estimates it replaces, never adds the two, and shows the gap per provider, model and month.

## Importing

`POST /api/invoices/import` (the console: **Reconciliation → Import an invoice**), by the controller or the CFO signed
in. A key never imports. The file is a CSV:

```
provider,invoice_number,period,model,sku,quantity,unit,amount,currency[,charge_category][,description]
Anthropic,INV-2026-11-0042,2026-11,claude-sonnet-4-5,input-tokens,4200000,Tokens,12.600000,USD,Usage,…
```

- `period` is a month (`YYYY-MM`) that is over in `LANDLEDGER_TZ` (review of wave 3, B1): an invoice for the month
  still running is refused (`period 2026-11 hasn't ended yet (Asia/Jerusalem)`), so no estimate of that month can
  still be on its way. One invoice (provider and number) covers one month, and stays in it: importing it again under
  another month is a `409` (void it first, should-fix 8).
- `currency` is `USD`; any other line refuses the whole file with `422` until FX is set up.
- `amount` has at most six decimals; negative only for `Credit` and `Adjustment`.
- A line names a `model` or a `sku`. A Usage line has a quantity and a FOCUS unit (`Tokens`, `1000000 Tokens`).
- `charge_category` is `Usage` (default), `Credit`, `Tax`, `Adjustment` or `Purchase` (FOCUS 1.4 ChargeCategory).
- A bad file imports nothing; every problem comes back with its line number.
- `origin: dev-fixture` is for a development API only (`LANDLEDGER_DEV_AUTH=on`, on this machine; `403` otherwise,
  B4). Its records are tagged `origin: dev-fixture`, link no estimate, and count in no total (month to date, the
  invoiced share, budgets, forecasts, exports, MCP, Clickland's metrics): they show on Reconciliation only, badged.
  Voiding one works on any API (it takes test data out), so a dev fixture imported while the API ran with dev sign-in
  can be voided once it runs with Landbright.

Fixtures: `apps/api/fixtures/invoices/anthropic-2026-11.csv` (two Claude models and a credit, $23.50) and
`ollama-2026-11.csv` (local models, $0).

## Posting

Each import is a new version of the invoice (`invoices`, `invoice_lines`: append only, audited `invoice.imported` or
`invoice.reimported`) and an ingest run with source `invoice`.

- **Usage lines with a model** are summed per model and split over the live estimates of that provider and model in
  the month, by estimated cost (by quantity when every estimate is $0, equally otherwise), with `split`: the parts
  total the invoice to the micro-unit. Each part is an `invoiced` record that copies the estimate's dimensions and
  tags (so it is allocated to the same cost center), with `BilledCost = EffectiveCost`, no rate card, `InvoiceId` the
  invoice number, `x_Source = invoice` and the key `invoice:<provider>:<number>:<estimate key>`. A link
  (`invoice_estimate_links`) names the estimate it replaces.
- **A model with no estimate**, and every other line (credits, tax, purchases, SKU-only lines), posts on its own over
  the whole month (`invoice:<provider>:<number>:line:<n>`), tagged with the provider and model.
- **A locked month** never moves: the true-up (invoiced − the month's estimates still shown, per model) is booked in
  the open month with `ChargeClass = Correction` and the locked month's charge period (`…:trueup:<model>`), and links
  those estimates `trued_up` so a second invoice for the same model and month subtracts only what is left (B2). Other
  lines go the same way.
- **An estimate that arrives after its month was invoiced** (a late ingest) is linked `late` at once: it drops out of
  every figure, and its reconciliation row says _N estimates after invoice: re-reconcile_. The next import or void of
  that provider and month re-plans the split over every estimate (B1).

## Never counted twice

Every read (`spend.ts`, so Overview, Explore, Budgets, exports, MCP, metrics and reservations) shares one rule
(`apps/api/src/read-rule.ts`): an estimate is left out while the invoiced entry its `split` or `late` link names was
live _as of the estimate's own billing month_ (entered in or before it, not reversed in or before it). A re-imported
invoice keeps it replaced; a void while the month is open gives it back; once the month locks nothing later moves it
(B3). Dev-fixture records and the `dev-anomaly` spike are left out too.

Property-tested against Postgres (`apps/api/test/invoices.property.integration.test.ts`, review of wave 3): random
sequences of estimates (before and after an invoice, and after the month locked), one or two invoices per provider and
month imported, re-imported and voided, and the month locking at any point. After every step a provider's figure
across all months is what its live invoices bill for each model they bill, plus every estimate of the models none
bills; and once its month locks, that month's own figure never changes again. Two invoices in a locked month and a
late estimate are examples beside it. The split itself is property-tested in `apps/api/test/invoices.test.ts`.

## Corrections and voids

Importing the same provider and number again compares each record by key: unchanged records are skipped, changed ones
are reversed and re-entered, vanished ones reversed (`libs/focus` `correct`; in a locked month, in the open month as a
Correction). `POST /api/invoices/:id/void { reason }` reverses every live record of the invoice and stores a `voided`
version (audited `invoice.voided`); in a locked month the estimates it replaced come back as restores booked in the
open month. A void also re-plans the provider's other live invoices for that month, so an estimate the voided one
freed is never counted beside an invoice that bills its model. Nothing is edited.

## Reconciliation

`GET /api/reconciliation?month=` and the console's **Reconciliation** page, per provider × model × month:

| Column | What |
|---|---|
| Estimated | every live estimate charged in the month (linked or not; reversals net) |
| Invoiced | the month's posted invoices' lines (each at its newest version) |
| Variance | invoiced − estimated, and as a percent of estimated (one decimal; none when nothing was estimated) |
| Status | `matched` when \|variance\| ≤ tolerance × \|estimated\| or at most the floor; `outside`; `not_invoiced` (no invoice line); `no_estimate` |
| Late | estimates that arrived after the invoice, with the note _estimates after invoice: re-reconcile_ |
| Dev | `devFixture`: a development fixture's row, badged and in no total |

The tolerance is `LANDLEDGER_RECONCILE_TOLERANCE_PCT` (default `2`, ±2%) with an absolute floor,
`LANDLEDGER_RECONCILE_TOLERANCE_USD` (default `0.50`), so cents never read as outside. Each import stores the provider's rows as
they stood (`reconciliations`). The totals carry the share of the month's AI spend, as every figure shows it, that is
invoiced; Overview and Explore say the same of any total ("71% invoiced").

## From approval to invoice

`GET /api/requests/:id/lifecycle` (and the Request page) follows an approved request on one basis (should-fix 7):
**approved** (amount, when, by whom or by policy), **reserved** (its reservations), **consumed** (its matched cost, as
every figure shows it, above its reservation's baseline, a day, from its first day; uncapped, so an overrun shows),
**invoiced** (the invoiced share of what it consumed, so it never exceeds Consumed). The variance is Consumed against
what was approved in the months so far.

## Not yet

PDF invoices and an inbox (wave 5), accruals for usage not yet invoiced (wave 4), other currencies.
