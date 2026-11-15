# Tasks: Periods and the close (spec 012)

- [x] Migration 0014 and grants
- [x] Close service: gates, view, explain, start
- [x] Four-eyes lock with an anchored audit entry
- [x] period_reopen request and apply
- [x] Routes, reference, OpenAPI-style docs
- [x] Console Month-end page
- [x] Integration tests and the locked-month property test (reopen-and-relock)
- [x] docs/close.md, plan, limitations

## Review of wave 4

- [x] R001 B4: `period_reopen` never escalates outside Finance CFO; with nobody eligible it waits and sends
  `request.no_approver`, at the start and at each deadline.
- [x] R002 Should-fix 1: each signature names the snapshot it signs and needs evidence its signer was shown it (24 h);
  only signatures on the current snapshot count.
- [x] R003 Should-fix 2: with no snapshot, the first signature freezes one (reason `lock`).
- [x] R004 Should-fix 3: an explanation stores its problems and their sha256; a changed list turns the step red.
- [x] R005 Should-fix 4: a reopened round is started (`close_round_starts`), re-runs steps 2 and 5, and relocks.
- [x] R006 Should-fix 6: accounts that look like services never start, accept or sign.
- [x] R007 Segregation of duties: at least two people among start, accrual acceptance and the controller's signature;
  FP&A may start.
- [x] R008 Nits: a pre-wave-4 lock reopens; gate 5 reads every anomaly; the signature's checks run in its
  transaction; month ends in `LANDLEDGER_TZ`.
