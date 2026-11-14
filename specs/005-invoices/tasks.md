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
