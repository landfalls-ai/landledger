# Plan 005: Invoices and reconciliation

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-15

## Technical context

| Project | What it gains |
|---|---|
| `libs/contracts` | `wave3.ts`: `InvoiceImportInput`, `InvoiceView`, `ReconciliationView`, `RequestLifecycle` |
| `libs/schema` | `0012_wave3.sql`: `invoices` (one row per imported version, append only), `invoice_lines`, `reconciliations` (snapshots), `invoice_estimate_links` keyed by estimate and invoiced record (a voided invoice frees its estimates for the next one) |
| `apps/api` | `csv.ts` (the CSV reader budgets already used), `invoices.ts` (parse, plan the posting, post, void, reconcile, lifecycle); reads in `spend.ts` treat an estimate as replaced while any live invoiced entry of a linked key exists |
| `apps/console` | `routes/reconciliation.tsx`; the lifecycle card on `request.tsx`; "N% invoiced" on Explore's total |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| 1. Agents request; people decide | PASS | Importing and voiding are for a signed-in controller or CFO; a key never imports an invoice. |
| 2. Estimated or invoiced | PASS | Invoiced records are `basis = invoiced`; the share invoiced is shown wherever totals mix both. |
| 3. Money is exact | PASS | Amounts parsed as decimals to micro-units; parts with `split` (sum exact, property-tested); variance in micro-units, its percent with `Decimal.divide` half-even. |
| 4. Nothing is edited | PASS | Re-imports and voids are reversals and re-entries; invoices and reconciliations append only; a locked month gets a Correction in the open month. |
| 5. Nobody depends on it | PASS | No outbound call. |
| 6. Local only | PASS | Fixtures only; no provider is called. |
| 7. Spec-driven | PASS | This spec, tests per acceptance line. |

## Design

- **Planning is pure** (`planInvoice`): given the invoice's lines and the period's live estimates, it returns the
  records to hold (key, amount, the estimate it replaces). The writer compares that plan with what the ledger holds
  for the invoice's keys (fingerprint: amount, category, estimate key) and appends the difference.
- **Keys**: `invoice:<provider>:<number>:<estimate key>` for a part, `invoice:<provider>:<number>:line:<n>` for a line
  posted alone, `invoice:<provider>:<number>:trueup:<model>` for a locked month's correction.
- **Matching**: provider by `tags.provider` or `ServiceProviderName` (case-insensitive), model by `tags.model`.
- **The read rule** (spend.ts) is unchanged in meaning: an estimate is left out while a live invoiced entry exists for
  the source key of an invoiced record it is linked to, so a re-entered invoice keeps its estimates replaced and a
  voided one gives them back.
- **Lifecycle**: from the request's reservations (reserved, consumed) and its `match` selector over the reserved
  months' lines: the invoiced share of the matched cost applies to what was consumed.
