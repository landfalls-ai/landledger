# Tasks 005: Invoices and reconciliation

Ordered; each task ends with its tests passing.

- [x] T001 The contract (`wave3.ts`) and the routes in `docs/reference/api.md`.
- [x] T002 Migration 0012: invoices, invoice lines, reconciliations, links by estimate and record; grants; the read rule.
- [x] T003 The CSV parser with every problem by line; USD only (422).
- [x] T004 `splitOverEstimates` and `shownTotal` (pure): split by estimated cost, by quantity, alone; property tests (parts sum to the invoice;
      shown total never double counts).
- [x] T005 Posting, re-import (reversal and re-entry), void; a locked month's true-up as a Correction; allocation of
      what was posted; audit.
- [x] T006 Reconciliation per provider × model × month with the tolerance; snapshots; property tests of the variance.
- [x] T007 The lifecycle of an approved request.
- [x] T008 The fixtures (Anthropic, Ollama $0); integration tests against Postgres.
- [x] T009 Console: Reconciliation, the lifecycle card, "N% invoiced".
- [x] T010 Docs: `docs/invoices.md`, the references, plan and history.

## Review of wave 3

- [x] R001 B1: refuse an invoice whose month isn't over in `LANDLEDGER_TZ`; link a late estimate `late` and flag its row
  (_estimates after invoice: re-reconcile_); re-plan on the next import or void.
- [x] R002 B2: a locked month's true-up links what it trued up (`trued_up`), so a second invoice subtracts only the rest.
- [x] R003 B3: one read rule (`read-rule.ts`), judged as of the estimate's own billing month; a void in a locked month
  books the estimates back in the open month; a void re-plans the provider's other invoices.
- [x] R004 B4: `dev-fixture` only with dev auth on loopback; tagged, linking nothing, in no total; badged on
  Reconciliation. Voiding one works on any API, so the live fixtures imported under dev sign-in could be voided
  (done live: month to date for November $30.77 → $7.27).
- [x] R005 Should-fix 7: the lifecycle on one basis (consumed above the baseline, uncapped; invoiced a share of it).
- [x] R006 Should-fix 8: an invoice posted for one month can't be imported for another (void it first).
- [x] R007 Nits: the tolerance's floor (`LANDLEDGER_RECONCILE_TOLERANCE_USD`); a true-up re-imported after its booking
  month locked goes to the open month; the provider matched the same way in posting and reconciliation; the dev
  principal imports contracts too.
- [x] R008 Property tests against Postgres (`invoices.property.integration.test.ts`): never double counted, a locked
  month never moves, two invoices in a locked month, a late estimate.
