# The month-end close

Wave 4 (specs [012](../specs/012-close/spec.md), [016](../specs/016-snapshot/spec.md) and
[018](../specs/018-package/spec.md)). The close of a month is a checklist that Landledger computes. Nobody ticks a
step. **People close; agents draft.** Every step that changes the close is done by a person signed in with Landbright.
An API key or the local developer gets 403.

The code is in `apps/api/src/close.ts` (the gates, the view, the lock), `snapshot.ts`, `package.ts`, `journal.ts` and
`wave4-routes.ts`. The tables are in migrations `0014_month_end.sql` and `0015_review_wave4.sql` (the review of wave
4). The console page is `/close` (`apps/console/src/routes/month-end.tsx`).

Nothing in the close is done by an account that looks like a service (Administrator, bots, the approvals engine's
`isServiceLike`): it doesn't start a close, accept an accrual or a note, or sign a lock (403; review of wave 4,
should-fix 6).

## Periods

A month moves `open → closing → locked`.

- **Start.** `POST /api/close/:month/start` moves a month to `closing`. A controller, the CFO or FP&A can do this
  (FP&A since the review of wave 4, so a second person can start what a controller then accepts and signs), and only
  after the month has ended (in `LANDLEDGER_TZ`). A month still running gets 409, and a future month gets 400. Rules
  and rate cards freeze for that month.
- **Lock.** Locking takes two signatures (below). A locked month takes no new rows. A correction always posts to the
  open month, as in wave 1.
- **Order.** Months lock in order. A month can't lock while the month before it is still open.
- **Reopen.** A controller asks with `POST /api/close/:month/reopen {reason}`. This raises a `period_reopen` request.
  - Only the CFO decides it, never the person who asked (`pol_period_reopen_1`).
  - It never escalates outside Finance CFO (review of wave 4, B4). With nobody in Finance CFO able to decide it (no
    CFO, one who looks like a service, or the CFO is the one asking), it waits: the step's note says why, and
    `request.no_approver` goes to the audit log and to webhooks, when it starts and again at each deadline it passes.
  - When approved, the month is _reopened_: `period_reopens` gets a row and the audit log gets `period.reopened`.
  - The ledger stays closed to inserts. Each lock and its signatures belong to a **round**, which counts the reopens.
  - A reopened round waits to be **started** (`POST /api/close/:month/start` again, by a controller, the CFO or FP&A;
    `close_round_starts`, audited `close.round_started`). Until then nothing in it can be explained or signed.
  - The round re-runs steps 2 and 5 live (a late invoice can break tolerance; review of wave 4, should-fix 4) and
    steps 7–9. Steps 1, 3, 4 and 6 stand as they were locked. The month locks again with two new signatures.
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
| 7 | Accrual accepted | A named controller accepted the month's accrual ([accruals.md](accruals.md)), and the snapshot it froze is still current. An acceptance by an account that looks like a service, made before the review of wave 4 refused one, doesn't count: the accrual is proposed and accepted again | yes |
| 8 | Variance notes accepted | Every note the snapshot needs is accepted ([variance-notes.md](variance-notes.md)) | yes |
| 9 | Datarails upload done | An upload of the current snapshot succeeded after the notes were accepted ([datarails.md](datarails.md)) | yes |
| 10 | Period locked | Two signatures | **never** |

- **States.** A step is `done`, `explained`, `red` (with its problems listed) or `waiting`. Steps 7 to 10 are
  `waiting` until every step before them is done or explained.
- **Explaining.** A controller, the CFO or FP&A explains a red step with `POST /api/close/:month/explain` and a note
  of at least 3 characters. The explanation is audited as `close.explained`, and the checklist shows it with who
  wrote it and when. Explaining a step never makes its gate green. It records why closing anyway is fine.
- **An explanation covers the problems it was written for** (review of wave 4, should-fix 3). It stores the problems
  it explained and their sha256 (sorted, so order doesn't matter). When the list changes (one open anomaly becomes
  ten, a row's variance moves from $3 to $3,000) the step turns red again and needs a new explanation. A row's
  problem names its estimated and invoiced amounts to the cent, so a moved row is a new problem.
- **Step 5** reads every anomaly of the month, however many (it read the newest 500).
- **Locked months.** A locked month shows its checklist as recorded at the lock (`close_locks.gates`). A month locked
  before wave 4 has no `close_locks` row; it still opens, and reopens, without one.
- **Reopened months.** A reopened month takes steps 1, 3, 4 and 6 from its last lock and computes steps 2, 5 and 7–9
  again, once the round is started.

## The four-eyes lock

`POST /api/close/:month/lock {snapshotSha256}` adds one signature (`close_signoffs`). The first signature waits for
the second.

The month locks when a second, different person signs, and the two people are a controller and the CFO. Two people
with the same role, or the same person twice, gets 409. Landledger checks everything inside the signing transaction,
under the month's lock, so an accrual accepted at the same moment can't slip between the check and the signature:

- the round is started, and steps 1–9 are done or explained;
- the live figures still hash to the snapshot's `ledger_sha256`;
- **the signature names the snapshot it signs** (`snapshotSha256`, as the close showed it), and it is the current one;
- **the signer was shown that snapshot** in the last 24 hours. Each time a person is served the close, the snapshot or
  the package, `close_snapshot_views` records it;
- the duties rule (below).

If a check fails, the signature gets 409 with `details.problems` or the snapshot's current sha256.

Each signature stores the snapshot's sha256 and when its signer was shown it (`seen_at`), and only signatures on the
current snapshot count (review of wave 4, should-fix 1). If the CFO signs snapshot A and a late invoice forces a new
accrual and snapshot B, the CFO's signature no longer counts: both sign B.

**A month with no snapshot** (steps 7–9 explained, so no accrual froze one) gets one at the first signature, with the
reason `lock` (should-fix 2). That signature names no snapshot; the second names the one it froze. The package and
the lock then cite it like any other.

The second signature does all of the following in one transaction:

- sets the period to `locked`;
- builds the round's package and stores it (below);
- writes `period.locked` to the audit log, with both signatures (each with its snapshot and when it was seen), the
  snapshot's sha256, the package's sha256 and `checks: four-eyes`;
- stores the checklist and the package's sha256 in `close_locks`;
- enqueues the `period.locked` webhook.

It then anchors the chain's head straight away: an `audit_anchors` row, a log record to Clickland and the
`audit.anchor` webhook. The console shows the lock's audit entry and its anchor hash.

### Segregation of duties

Besides the CFO, at least two different people take part in a round (review of wave 4; [plan.md](plan.md), Decision
10). Among whoever started the round, accepted the accrual and signs as controller, there are at least two. A
controller who started the close and accepted the accrual can't also sign it: another controller signs, or another
person (FP&A, say) starts the round. The check runs at the controller's signature (409 `Segregation of duties: …`),
and the close shows who did each (`duties`: `startedBy`, `accrualAcceptedBy`, `controllerSignedBy`).

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

**Each lock round stores its package** (review of wave 4, should-fix 5). The second signature builds it, stores its
files, manifest and the manifest's sha256 in `close_packages`, and puts that sha256 in `close_locks.package_sha256`
and in the `period.locked` audit entry. A locked month is then served its stored package, never rebuilt, so later
exceptions, decisions or reversals don't move it. The chain proof is read at download and sits outside the manifest.
A reopened round stores a new package; the earlier one stays.

There are two ways to get the month-end package:

- `GET /api/close/:month/package?format=json|html`: one page (`html` prints well);
- `GET /api/close/:month/package.zip`: one download.

Both hold:

- the snapshot and the checklist;
- the reconciliation;
- the accrual, its frozen journal (`accrual-journal-entry.csv`) and the roll-forward (`accrual-roll-forward.csv`);
- the lock's signatures, each with the snapshot it signed and when it was seen (`lock-signatures.csv`);
- the accepted notes;
- the exceptions report;
- the anomalies closed in the month and the decisions made in it;
- the Datarails uploads;
- the chain proof: the head, the lock's audit entry and its anchor, and how many entries were checked.

The zip holds `<month>/*.csv`, `snapshot.json`, `package.json`, `package.html` and a `manifest.csv` with every
file's sha256. The console's `/close/package` links to both, and shows the stored package's sha256.

## Webhooks

`period.closing`, `period.locked`, `audit.anchor` (sent at once by a lock), `period.reopened`, `accrual.accepted`,
`notes.draft_requested`, `note.accepted`, `datarails.uploaded` and `request.no_approver` (a reopen waiting for the
CFO). An explanation is an audit entry
(`close.explained`), not a webhook
([reference/api.md](reference/api.md#webhook-events)).
