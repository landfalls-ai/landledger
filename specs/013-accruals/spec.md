# Feature 013: Accruals (wave 4, "Month-end")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · **Page**:
[docs/accruals.md](../../docs/accruals.md)

## Why

At month-end some usage is known but not yet invoiced. The controller books an accrual for it, and reverses it when
the invoice posts. Landledger proposes the accrual from its own figures, the controller accepts it, and Landledger
exports the journal entry for the controller to book. Landledger never posts to a GL.

## User stories

1. **As the controller**, I see October's proposal: per AI provider and model, the estimates not yet invoiced; per
   contract, its value for the month not yet invoiced; I accept it as shown.
2. **As the controller**, I download the journal entry (debit expense by P&L class and cost center, credit accrued
   liabilities) and book it myself.
3. **As the controller**, when October's invoice posts in November, the accrual line shows reversed by that invoice,
   and November's journal carries the reversal, so nothing counts twice.

## Acceptance

- `POST /api/accruals/:month/propose` (controller, CFO or FP&A) for an ended month that is closing (or reopened):
  usage lines from the month's estimates the read rule still shows (provider, model, cost center, P&L class, the
  estimates' source keys); contract lines for contracts whose term covers the month and whose vendor has no invoice
  for it (value ÷ term months, by days). A new version supersedes an unaccepted one.
- `POST /api/accruals/:id/accept` (a controller): the proposal's sha256 as shown; steps 1–6 done or explained;
  freezes the snapshot (spec 016) in the same transaction; audited; `accrual.accepted` then `notes.draft_requested`.
- Reversal: a usage line is reversed by the first invoice link (`split`, `late` or `trued_up`) on any of its estimates;
  a contract line by an invoice from its vendor for the month; booked in the month the link was made.
- `GET /api/accruals/journal.csv?month=`: balanced rows, the month's accepted accrual and the reversals booked in it.
- Exact money; USD only; accruals are never cost records, so no figure counts them.

## Out of scope

Posting to a GL; partial reversals (a line reverses whole when its invoice posts).
