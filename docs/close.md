# The month-end close

Wave 4 (specs [012](../specs/012-close/spec.md), [016](../specs/016-snapshot/spec.md) and
[018](../specs/018-package/spec.md)). The close of a month is a checklist that Landledger computes. Nobody ticks a
step. **People close; agents draft.** Every step that changes the close is done by a person signed in with Landbright.
An API key or the local developer gets 403.

The code is in `apps/api/src/close.ts` (the gates, the view, the lock), `snapshot.ts`, `package.ts` and
`wave4-routes.ts`. The tables are in migration `0014_month_end.sql`. The console page is `/close`
(`apps/console/src/routes/month-end.tsx`).

## Periods

A month moves `open → closing → locked`.

- **Start.** `POST /api/close/:month/start` moves a month to `closing`. Only a controller or the CFO can do this, and
  only after the month has ended. A month still running gets 409, and a future month gets 400. Rules and rate cards
  freeze for that month.
- **Lock.** Locking takes two signatures (below). A locked month takes no new rows. A correction always posts to the
  open month, as in wave 1.
- **Order.** Months lock in order. A month can't lock while the month before it is still open.
- **Reopen.** A controller asks with `POST /api/close/:month/reopen {reason}`. This raises a `period_reopen` request.
  - Only the CFO decides it, never the person who asked (`pol_period_reopen_1`).
  - When approved, the month is _reopened_: `period_reopens` gets a row and the audit log gets `period.reopened`.
  - The ledger stays closed to inserts. Steps 7–9 can be done again, and the month locks again with two new
    signatures. Each lock and its signatures belong to a **round**, which counts the reopens.
- **Dry run.** A month still open shows the gates as they stand (`dryRun: true`). Nothing can be acted on.

## The ten steps

| # | Step | Green when | Can be explained |
|---|---|---|---|
| 1 | Usage ingested to the last day | Every source's completeness covers the month to its last day | yes |
| 2 | Reconciled within tolerance | Every provider × model row is within tolerance (`LANDLEDGER_RECONCILE_TOLERANCE_*`), not counting dev fixtures; each row is explained on its own (`rowKey` `provider\|model`) | yes, per row |
| 3 | Unallocated spend under its limit | Unallocated is under `LANDLEDGER_CLOSE_UNALLOCATED_PCT` (5%) of the month | yes |
| 4 | No dev-fixture or dev-anomaly rows | No record, invoice or anomaly in the month comes from a dev fixture or the dev spike | **never** |
| 5 | No open anomalies | Every anomaly whose window starts in the month is closed | yes |
| 6 | No outstanding access-review revokes | No revoke decided in a review is still waiting to take effect | yes |
| 7 | Accrual accepted | A controller accepted the month's accrual ([accruals.md](accruals.md)), and the snapshot it froze is still current | yes |
| 8 | Variance notes accepted | Every note the snapshot needs is accepted ([variance-notes.md](variance-notes.md)) | yes |
| 9 | Datarails upload done | An upload of the current snapshot succeeded after the notes were accepted ([datarails.md](datarails.md)) | yes |
| 10 | Period locked | Two signatures | **never** |

- **States.** A step is `done`, `explained`, `red` (with its problems listed) or `waiting`. Steps 7 to 10 are
  `waiting` until every step before them is done or explained.
- **Explaining.** A controller, the CFO or FP&A explains a red step with `POST /api/close/:month/explain` and a note
  of at least 3 characters. The explanation is audited as `close.explained`, and the checklist shows it with who
  wrote it and when. Explaining a step never makes its gate green. It records why closing anyway is fine.
- **Locked months.** A locked month shows its checklist as recorded at the lock (`close_locks.gates`).
- **Reopened months.** A reopened month takes steps 1–6 from its last lock and computes steps 7–9 again.

## The four-eyes lock

`POST /api/close/:month/lock` adds one signature (`close_signoffs`). The first signature waits for the second.

The month locks when a second, different person signs, and the two people are a controller and the CFO. Two people
with the same role, or the same person twice, gets 409. Before it accepts a signature, Landledger checks two things:

- steps 1–9 are done or explained;
- the live figures still hash to the snapshot's `ledger_sha256`.

If either check fails, the signature gets 409 with `details.problems`.

The second signature does all of the following in one transaction:

- sets the period to `locked`;
- writes `period.locked` to the audit log, with both signatures, the snapshot's sha256 and `checks: four-eyes`;
- stores the checklist in `close_locks`;
- enqueues the `period.locked` webhook.

It then anchors the chain's head straight away: an `audit_anchors` row, a log record to Clickland and the
`audit.anchor` webhook. The console shows the lock's audit entry and its anchor hash.

The wave 1 override is gone. A body with `override` gets 400 on both `POST /api/periods/:month/lock` and
`POST /api/close/:month/lock`. A step that can't go green is explained instead.

A property test runs against Postgres: a locked month's totals never change, whatever happens afterwards (an invoice
import, a void, a late ingest, a reopen and relock). See `apps/api/test/wave4.integration.test.ts`.

## The snapshot (spec 016)

When a controller accepts the accrual (step 7), the month's figures are frozen as canonical JSON with a sha256
(`close_snapshots`). The snapshot holds:

- totals by cost center, P&L class and provider;
- the reconciliation;
- the lifecycle of the requests reserved in the month;
- the accrual;
- the figures each variance note may cite;
- the gates as they stood.

`ledger_sha256` covers the ledger part alone, so "the figures are still the snapshot's" is a comparison of two hashes.
Notes, the Datarails upload and the package all cite the snapshot's hash, and the audit log records it.

If a late invoice moves the reconciliation, the snapshot is no longer current. Step 7 then goes red until a new
accrual is accepted, which freezes a new snapshot.

`GET /api/close/:month/snapshot` returns the snapshot, or 404 before step 7.

## The package (spec 018)

There are two ways to get the month-end package:

- `GET /api/close/:month/package?format=json|html`: one page (`html` prints well);
- `GET /api/close/:month/package.zip`: one download.

Both hold:

- the snapshot and the checklist;
- the reconciliation;
- the accrual and its journal entry;
- the accepted notes;
- the exceptions report;
- the anomalies closed in the month and the decisions made in it;
- the Datarails uploads;
- the chain proof: the head, the lock's audit entry and its anchor, and how many entries were checked.

The zip holds `<month>/*.csv`, `snapshot.json`, `package.html` and a `manifest.csv` with every file's sha256. The
console's `/close/package` links to both.

## Webhooks

`period.closing`, `period.locked`, `audit.anchor` (sent at once by a lock), `period.reopened`, `accrual.accepted`,
`notes.draft_requested`, `note.accepted` and `datarails.uploaded`. An explanation is an audit entry
(`close.explained`), not a webhook
([reference/api.md](reference/api.md#webhook-events)).
