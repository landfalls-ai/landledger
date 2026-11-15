# Plan: Periods and the close (spec 012)

- Migration `0014_month_end.sql`: `close_explanations`, `close_signoffs` (unique per month, round, person and role),
  `close_locks`, `period_reopens`, the `period_reopen` kind and its policy; all append only, granted to the app.
- `apps/api/src/close.ts` (`Close`): `view(month)` computes the gates from `Periods.lockProblems`,
  `Invoices.reconciliation`, `Spend.lines`, the anomalies, the access reviews and the wave 4 tables; `explain`,
  `start`, `sign` (the four-eyes lock, then `anchorAudit`), `requestReopen` (through `Requests.raiseChange`).
- `Requests.applyChange` applies `period_reopen`; `Periods.lockIn` locks inside the signing transaction.
- Routes in `apps/api/src/wave4-routes.ts`; `/api/periods/:month/lock` delegates to the signature.
- Console: `routes/close.tsx` (Month-end), October locked and November dry run, explain and sign forms.

The contract is `libs/contracts/src/wave4.ts` (pushed first, then changed only additively); the routes are in
[docs/reference/api.md](../../docs/reference/api.md#wave-4-month-end-specs-012019).
