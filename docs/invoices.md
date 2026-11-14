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

- `period` is a month (`YYYY-MM`) that has started; one invoice (provider and number) covers one month.
- `currency` is `USD`; any other line refuses the whole file with `422` until FX is set up.
- `amount` has at most six decimals; negative only for `Credit` and `Adjustment`.
- A line names a `model` or a `sku`. A Usage line has a quantity and a FOCUS unit (`Tokens`, `1000000 Tokens`).
- `charge_category` is `Usage` (default), `Credit`, `Tax`, `Adjustment` or `Purchase` (FOCUS 1.4 ChargeCategory).
- A bad file imports nothing; every problem comes back with its line number.
- `origin: dev-fixture` labels a development fixture everywhere it shows.

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
- **A locked month** never moves: the true-up (invoiced − the month's estimates, per model) is booked in the open month
  with `ChargeClass = Correction` and the locked month's charge period (`…:trueup:<model>`). Other lines go the same way.

## Never counted twice

Every read (`spend.ts`, so Overview, Explore, Budgets, exports, MCP, metrics and reservations) leaves out an estimate
while a live invoiced entry exists for the key of a record it is linked to. A re-imported invoice keeps it replaced; a
voided one gives it back. Property-tested: shown = Σ invoiced + Σ estimates not replaced, for any split
(`apps/api/test/invoices.test.ts`).

## Corrections and voids

Importing the same provider and number again compares each record by key: unchanged records are skipped, changed ones
are reversed and re-entered, vanished ones reversed (`libs/focus` `correct`; in a locked month, in the open month as a
Correction). `POST /api/invoices/:id/void { reason }` reverses every live record of the invoice and stores a `voided`
version (audited `invoice.voided`). Nothing is edited.

## Reconciliation

`GET /api/reconciliation?month=` and the console's **Reconciliation** page, per provider × model × month:

| Column | What |
|---|---|
| Estimated | every live estimate charged in the month (linked or not; reversals net) |
| Invoiced | the month's posted invoices' lines (each at its newest version) |
| Variance | invoiced − estimated, and as a percent of estimated (one decimal; none when nothing was estimated) |
| Status | `matched` when \|variance\| ≤ tolerance × \|estimated\|; `outside`; `not_invoiced` (no invoice line); `no_estimate` |

The tolerance is `LANDLEDGER_RECONCILE_TOLERANCE_PCT` (default `2`, ±2%). Each import stores the provider's rows as
they stood (`reconciliations`). The totals carry the share of the month's AI spend, as every figure shows it, that is
invoiced; Overview and Explore say the same of any total ("71% invoiced").

## From approval to invoice

`GET /api/requests/:id/lifecycle` (and the Request page) follows an approved request: **approved** (amount, when, by
whom or by policy), **reserved** (its reservations), **consumed** (matched cost above its baseline), **invoiced** (the
share of its matched cost that is invoiced), and the actual against what was approved in the months so far.

## Not yet

PDF invoices and an inbox (wave 5), accruals for usage not yet invoiced (wave 4), other currencies.
