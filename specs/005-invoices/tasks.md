# Tasks 005: Invoices and reconciliation

Ordered; each task ends with its tests passing.

- [ ] T001 The contract (`wave3.ts`) and the routes in `docs/reference/api.md`.
- [ ] T002 Migration 0012: invoices, invoice lines, reconciliations, links by estimate and record; grants; the read rule.
- [ ] T003 The CSV parser with every problem by line; USD only (422).
- [ ] T004 `planInvoice` (pure): split by estimated cost, by quantity, alone; property tests (parts sum to the invoice;
      shown total never double counts).
- [ ] T005 Posting, re-import (reversal and re-entry), void; a locked month's true-up as a Correction; allocation of
      what was posted; audit.
- [ ] T006 Reconciliation per provider × model × month with the tolerance; snapshots; property tests of the variance.
- [ ] T007 The lifecycle of an approved request.
- [ ] T008 The fixtures (Anthropic, Ollama $0); integration tests against Postgres.
- [ ] T009 Console: Reconciliation, the lifecycle card, "N% invoiced".
- [ ] T010 Docs: `docs/invoices.md`, the references, plan and history.
