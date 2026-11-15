# Tasks 011: Access review

- [x] T001 The contract: `AccessReviewView`, `AttestInput`, webhook `access_review.due`.
- [x] T002 Migration 0012: reviews, items (snapshots), attestations (append only, never by the person an item is
  about), notices.
- [x] T003 Open the quarter's review (controller or CFO, once a quarter) with a snapshot of people, keys, links, relay
  channels and cost center owners, each with who it is about.
- [x] T004 Attest keep or revoke (a reason to revoke), once per item, audited; the last completes the review.
- [x] T005 The hourly `access_review.due`, once a quarter while not complete.
- [x] T006 Console: Setup → Access review (keep and revoke, never on your own items).
- [x] T007 Tests: who may open and attest, completion, append only in the database.
- [x] T008 Docs: `docs/access-review.md`, references, plan and history.

## Review of wave 3

- [x] R001 Should-fix 9: a revoke of a key, a Slack link or a person's sessions done at once when the attester confirms
  (`access_review_revocations`); any other tracked until the access is gone (`outstanding`); completion held while one
  is.
- [x] R002 Webhooks and sessions reviewed; a key or channel no person stands behind attested by the CFO only (`cfoOnly`);
  a relay channel's creator matched by id; who an item is about checked as it stands now.
- [x] R003 Items granted after the review opened join it (`addedAt`), a cost center whose owners changed joins again;
  the open 2026-Q4 review migrated by the same sync, nothing attested.
- [x] R004 A weekly reminder while not complete; a missed quarter recorded (`access_review.missed`, `missed`).
- [x] R005 Console: the new kinds, confirm before an at-once revoke, outstanding and revoked, added, CFO-only, missed.
- [x] R006 Tests: confirm and revoke at once, an outstanding revoke holding completion, items added after opening,
  sessions, CFO-only, reminders, a missed quarter.
