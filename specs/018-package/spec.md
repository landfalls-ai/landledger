# Feature 018: The month-end package (wave 4, "Month-end")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · **Page**:
[docs/close.md](../../docs/close.md)

## Why

The controller hands the auditor one thing: the month as closed, with its evidence and the proof that nothing was
changed since.

## User stories

1. **As the controller**, I open October's package and download it: one page and a zip of CSVs.
2. **As the auditor**, I check each file's sha256 against the manifest and the chain proof against the anchor.

## Acceptance

- `GET /api/close/:month/package` (JSON), `?format=html` (printable, no scripts), `GET …/package.zip`.
- Holds the snapshot, the reconciliation, the accrual, the notes, exceptions, anomalies closed in the month, decisions
  in the month, the uploads and the chain proof (verify, the lock entry, its anchor).
- The zip: one CSV each and `manifest.csv` with every file's sha256.

## Out of scope

PDF; signing the zip.
