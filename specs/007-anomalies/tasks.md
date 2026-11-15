# Tasks 007: Anomalies

- [x] T001 Robust statistics (median, MAD) in micro-units; the cost detector (pure) with tests.
- [x] T002 Migration: anomalies, acknowledgements, `dev-anomaly` source.
- [x] T003 The job: series per dimension, store once, webhook `cost.anomaly`, a log record to Clickland.
- [x] T004 Approval-pattern detectors (split, ratchet, fast relay, same pair); webhook `approval.anomaly`; tests.
- [x] T005 Routes: list, acknowledge, scan; auditors refused.
- [x] T006 The dev spike and its reversal (CLI, refused unless `LANDLEDGER_DEV_ANOMALY=on`); the Clickland alert rule.
- [x] T007 Console: Needs you, Anomalies.
- [x] T008 Docs: `docs/anomalies.md`, references, integrations, plan and history.

## Review of wave 3

- [x] R001 Should-fix 10: only cost anomalies to Clickland's logs, ids and figures, no summary or names.
- [x] R002 Should-fix 11: the dev spike in no figure, expiring after two hours, only against a loopback database; a
  real jump on the same key is not marked dev.
- [x] R003 Should-fix 13: the figure followed and re-alerted at 2× (`anomaly_observations`); assign and close with an
  outcome (`anomaly_actions`), audited; nothing ages out; the people a pattern names can't act on it.
- [x] R004 Should-fix 16: splits by the person who answers for them, across cost centers and kinds, open and approved
  requests only, under each policy line.
- [x] R005 Should-fix 17: `same_pair` per step, only where more than one could decide; stable keys for it and
  `automatic_ratchet`.
- [x] R006 Nits: the runbook URL from `LANDLEDGER_CONSOLE_URL`.
- [x] R007 Console: status, figures now and first, Assign and Close, "this pattern names you".
