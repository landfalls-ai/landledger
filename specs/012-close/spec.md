# Feature 012: Periods and the close (wave 4, "Month-end")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · **Page**:
[docs/close.md](../../docs/close.md)

## Why

Month-end is where finance trusts or redoes the technology lines. Wave 1 locked a month when it was whole; wave 4
makes the close a checklist anyone can read: ten steps in order, each a gate Landledger computes, each showing who did
it and when, ending in a lock two people sign. A locked month never moves; reopening one is a request the CFO decides.

## User stories

1. **As the controller**, I open Month-end for October and see the ten steps, which are green, which are red and why;
   I explain a red step with a note when the review allows it, and sign the lock.
2. **As the CFO**, I sign the lock second; the month locks, the lock's audit entry is anchored at once, and October
   never changes again.
3. **As the controller**, I find a wrong note after the lock and ask to reopen October; the CFO approves the
   `period_reopen` request; I fix the note and re-upload; two of us lock it again. Corrections still post to November.
4. **As anyone with `read`**, I dry-run November's checklist while it is still running and see which gates are red.

## Acceptance

- `GET /api/close?month=` returns the steps in order, each `done`, `explained`, `red` (with problems) or `waiting`,
  with who and when; a month still open is a dry run.
- Gates: (1) `lockProblems` (ended, complete runs, no provisional rows, allocated); (2) every reconciliation row
  within tolerance or with nothing to invoice, else explained row by row; (3) Unallocated ≤
  `LANDLEDGER_CLOSE_UNALLOCATED_PCT` (5) percent of the month; (4) no live dev-fixture record and no `dev-anomaly` row;
  (5) no anomaly of the month open; (6) no access-review revoke outstanding; (7) the accrual accepted (and the snapshot
  current); (8) every needed note accepted on the current snapshot; (9) an upload of the current snapshot with the
  accepted notes; (10) locked this round.
- `POST /api/close/:month/explain`: controller, CFO or FP&A; note ≥ 3 characters; never steps 4 or 10; audited.
- `POST /api/close/:month/lock`: steps 1–9 done or explained and the figures still the snapshot's; two different
  people, a controller and the CFO; the second signature locks (`periods.status = locked`), writes `period.locked`
  with both signatures, the gates and the snapshot's sha256, anchors the chain head at once, sends `period.locked`.
- `POST /api/close/:month/reopen`: a controller raises a `period_reopen` request; the policy `pol_period_reopen_1`
  is the CFO alone; approved, `period_reopens` gets a round, the month shows reopened, its ledger stays closed to
  inserts, and it locks again with two new signatures (anchored again).
- An API key never starts, explains, signs or reopens (403); the database keeps every table append only.
- Property test: a locked month's shown totals never change under import, void, late ingest or reopen-and-relock.

## Out of scope

Posting journals (Landledger never posts to a GL); reopening that lets records into a locked month.
