# Feature 016: The frozen close snapshot (wave 4, "Month-end")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · **Page**:
[docs/close.md](../../docs/close.md)

## Why

Notes, the Datarails upload and the month-end package must all describe the same month. At step 7 Landledger freezes
the month's figures and their sha256; everything after cites the hash, and the audit log records it.

## User stories

1. **As the auditor**, I see the hash the notes, the upload and the package cite, and that the audit log recorded it.
2. **As the controller**, if a figure moves after the freeze (a late invoice before the lock), the close says so and
   the accrual is proposed again.

## Acceptance

- Frozen when the accrual is accepted: by cost center (estimated, invoiced, notional, budget), P&L class, provider,
  the reconciliation, the requests reserved in the month (approved, consumed, invoiced to date), the accrual, the notes'
  figures and the gates; canonical JSON and its sha256; a `ledger_sha256` over the ledger part.
- `current` while the live ledger part still hashes the same; the lock refuses a stale snapshot.
- Audited `close.snapshot_frozen` with the sha256. `GET /api/close/:month/snapshot`.

## Out of scope

A snapshot of the spread layer (shared pool split); it reports the direct layer.
