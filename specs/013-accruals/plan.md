# Plan: Accruals (spec 013)

- Tables `accruals`, `accrual_lines`, `accrual_decisions` (0014). `apps/api/src/accruals.ts` (`Accruals`): propose,
  accept (with `Snapshots.freezeIn`), view, journal CSV; reversals read from `invoice_estimate_links` and `invoices`.
- Console: `routes/accruals.tsx` (Close → Accruals).

The contract is `libs/contracts/src/wave4.ts` (pushed first, then changed only additively); the routes are in
[docs/reference/api.md](../../docs/reference/api.md#wave-4-month-end-specs-012019).
