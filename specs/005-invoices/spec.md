# Feature 005: Invoices and reconciliation (wave 3, "Plan and reconcile")

**Status**: specified 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · **Contract**:
`libs/contracts/src/wave3.ts`, [reference/api.md](../../docs/reference/api.md#wave-3-plan-and-reconcile-specs-005011)

## Why

Every AI figure so far is an estimate: tokens × the rate card. The providers' invoices are what the company pays.
Finance needs the invoice beside the estimate, the gap between them per provider, model and month, and totals that
never count one charge twice. Approved requests need a trail from the decision to the bill.

## User stories

1. **As a controller**, I import a provider's invoice as a CSV (provider, invoice number, period, line items, USD) and
   see each line posted as `invoiced` cost beside the estimates it replaces.
2. **As FP&A**, I open Reconciliation for November and see, per provider and model, estimated against invoiced, the
   variance and whether it is inside ±2%.
3. **As anyone reading a total**, a figure that mixes estimated and invoiced cost says how much is invoiced
   ("71% invoiced"), and never adds an estimate to the invoice that replaced it.
4. **As a controller**, a provider re-issues an invoice: importing it again corrects the ledger by reversal and
   re-entry; voiding one reverses it whole. Nothing is edited.
5. **As a budget owner**, an approved request shows its lifecycle: approved → reserved → consumed → invoiced, with the
   variance against what was approved.

## Acceptance

- **CSV**: header `provider,invoice_number,period,model,sku,quantity,unit,amount,currency`, optional
  `charge_category` (`Usage` default, `Credit`, `Tax`, `Adjustment`, `Purchase`) and `description`. `period` is
  `YYYY-MM` and not in the future; `currency` is `USD` (anything else: the whole file is refused, `422`); `amount` has
  at most six decimals (negative only for `Credit` and `Adjustment`); a line names a `model` or a `sku`. Every
  problem is reported with its line number and a bad file imports nothing. One file may hold several invoices
  (grouped by provider and number).
- **Posting** (FOCUS 1.4): each Usage line group (provider × model) is split over the live estimates of that provider
  and model in the period, by their estimated cost (by quantity when every estimate is zero), with `split` (exact to
  the micro-unit). Each part is an `invoiced` record (`BilledCost = EffectiveCost`, no rate card, `InvoiceId` the
  invoice number, the estimate's dimensions and tags) linked to the estimate it replaces (`invoice_estimate_links`).
  A group with no estimate, and every non-Usage line, posts on its own. `ChargeClass` is null in an open month; for a
  locked month the true-up (invoiced − estimated) is booked in the open month as `ChargeClass = Correction`.
- **Never double counts**: every read leaves out an estimate whose key is linked to a live invoiced entry
  (property-tested: Σ shown = Σ invoiced + Σ unlinked estimates, for any split).
- **Corrections**: importing the same provider and number again compares each record by source key: unchanged is
  skipped, changed is reversed and re-entered, vanished is reversed. `POST /api/invoices/:id/void` reverses it whole.
  Each import is a version (append only), audited.
- **Reconciliation** per provider × model × month: estimated (every live estimate, linked or not), invoiced, variance
  = invoiced − estimated, variance % of estimated, within when |variance| ≤ tolerance × estimated (default ±2%,
  `LANDLEDGER_RECONCILE_TOLERANCE_PCT`); statuses `matched`, `outside`, `not_invoiced`, `no_estimate`. A snapshot is
  stored at each import.
- **Lifecycle** of an approved request: approved (amount, when, by whom), reserved, consumed, invoiced (the share of
  its matched cost that is invoiced), and the variance of the actual against the approved amount to date.
- **Fixtures**: `apps/api/fixtures/invoices/anthropic-2026-11.csv` (an Anthropic-shaped invoice) and
  `ollama-2026-11.csv` (local models, $0).
- **Console**: Reconciliation (invoices, the table per provider and model, import for a controller or the CFO), the
  share invoiced on Overview and Explore, the lifecycle on the Request page.

## Out of scope

PDF invoices, an inbox, cloud bills (wave 5); accruals and the month-end checklist (wave 4); other currencies.
