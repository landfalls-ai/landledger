# Anomalies

Wave 3, [spec 007](../specs/007-anomalies/spec.md). Finance's promise is an alert the hour a cost jumps. Approval
controls that hold one request at a time can still be worked around in patterns, so those are watched too.
`apps/api/src/anomalies.ts`.

## Cost

Every hour (and on `POST /api/anomalies/scan`), today and yesterday are checked. Today is checked as it accrues: the
cost so far, never projected.

- **Series:** each day's cost per dimension and key: cost center, service, agent and model. It reads the direct layer
  as Explore does: ledger records by charge day, today's provisional rows, and an estimate an invoice replaced counted
  once. Corrections booked for a locked month are not a day's usage and are left out.
- **Baseline:** the 14 days before. A day counts when Landflow or Clickland was read that day; a key with nothing on
  an observed day counts $0 there. At least **7 observed days** are needed.
- **Rule:** with median _m_ and median absolute deviation _MAD_, a day costing _x_ is anomalous when all three hold:
  - _x − m_ is at least `LANDLEDGER_ANOMALY_MIN_USD` (default $1);
  - _x − m_ is at least _m_ / 2;
  - the robust score (_x − m_) / (1.4826 × _MAD_) is at least 3.5.

  A flat baseline (_MAD_ 0) counts any jump that passes the first two tests, new spend included.
- Exact: medians and deviations are micro-unit integers (an even count's middle is rounded half to even). The score
  is a decimal to two places.

## Approval patterns

| Rule | When | Key |
|---|---|---|
| `split` | 3 or more requests by the person who answers for them (the requester, or an agent's sponsor), across cost centers, agents and kinds, within 72 hours of the first. Only requests still open or approved count (a rejected or cancelled one splits nothing). Each is under one of the policy's lines (the automatic threshold, and each step's `amountAtLeast` or `amountAbove`: $500, $5,000, $25,000 by default) and together they reach it; a request at or above that line doesn't mask the run. | person and line, from the first request |
| `automatic_ratchet` | 3 or more automatic approvals for one person on one cost center in a calendar month | person and cost center, from the month's start |
| `fast_relay` | a decision relayed under 10 seconds after its card (the evidence hash it cites) was first served to the relay | the decision |
| `same_pair` | per approval step, one approver made 5 or more of one requester's decisions at that step in 90 days, and at least 80% of them, counting only decisions where more than one person could have decided (a cost center with a single owner is no pattern) | approver, requester and step, from the quarter's start |

Review of wave 3 (should-fix 16, 17): keys are stable (a month or a quarter, not a rolling window), so the next
scan never raises the same pattern again.

The month's automatic total already stops the fourth request of a split from going through by policy (a person
decides it). The anomaly is how Finance hears that the pattern happened.

## What happens to one

- **Stored once, then followed:** the `anomalies` table is append only and unique per kind, rule, dimension, key and
  window start, so the next hour's scan raises nothing new. A cost anomaly's figure moves with the day: a higher one
  is kept in `anomaly_observations` (`current`, `currentAt`), and at twice the figure last alerted it alerts again
  (`alerts`, audited `anomaly.escalated`, the webhook with `escalation: true`). A $5 jump at 09:00 that ends the day
  at $500 says so. The audit log records `anomaly.cost` or `anomaly.approval` (system).
- **Webhook:** `cost.anomaly` or `approval.anomaly`, with `{ anomaly: AnomalyView, url, escalation }` (the console's
  `/anomalies?id=…`).
- **Clickland:** a cost anomaly, and only a cost anomaly, is also logged as an OpenTelemetry log record through the
  API's OTLP exporter, with ids and figures and never a summary or a name (should-fix 10):
  `landledger.event=cost.anomaly`,
  `landledger.anomaly.{id,rule,dimension,key,observed,baseline,cost_center,dev,escalation,url}`. Approval patterns,
  which name people, never leave Landledger except as the signed webhook.
  A Clickland alert rule counts these records (Clickland's alerts count log and trace rows only).
  `pnpm --filter @landledger/api anomaly clickland-alert` installs the rule, or brings it up to date, through
  Clickland's API with `LANDLEDGER_CLICKLAND_ALERTS_KEY`, a key holding `alerts:write`:

  ```json
  { "name": "Landledger cost anomaly", "signal": "logs", "query": "landledger.event:cost.anomaly",
    "groupBy": "landledger.anomaly.dimension", "thresholdType": "above", "threshold": 0,
    "windowMinutes": 60, "intervalMinutes": 5, "severity": "sev3",
    "labels": { "team": "finance", "app": "landledger" }, "runbookUrl": "<LANDLEDGER_CONSOLE_URL>/anomalies" }
  ```

  The runbook is this Landledger's own Anomalies page (`LANDLEDGER_CONSOLE_URL`).

  Clickland's code is not changed ([integrations.md](integrations.md#clickland)).
- **Acknowledge, assign, close** (should-fix 13), each by a person signed in with `requests:write`, each with a note,
  audited and append only (`anomaly_acks`, `anomaly_actions`). Auditors read only; a key never acts.
  - `POST /api/anomalies/:id/acknowledge { note }`: seen (`anomaly.acknowledged`), once (409 after).
  - `POST /api/anomalies/:id/assign { assignee: { email } | { id }, note }`: to an active person
    (`anomaly.assigned`); assigned again, the latest counts.
  - `POST /api/anomalies/:id/close { outcome, note }`: `expected`, `fixed` or `false_positive`
    (`anomaly.closed`), once (409 after); nothing acts on a closed one.
  - The people a pattern names (its requests' requesters and sponsors, a same-pair approver, a fast relay's decider:
    `named`) never acknowledge, assign or close it (403), and it is never assigned to them (400).
- **Open** is every anomaly not closed, however old: nothing ages out. `status`: `open`, `acknowledged`, `closed`.
- **Console:** Overview's _Needs you_ lists the ones nobody has seen yet and the ones assigned to you (three, then a
  link). **Control → Anomalies** lists both kinds with their figures (now and first seen, how many alerts), the
  requests behind a pattern, who acknowledged, who it is assigned to, and how it closed; Acknowledge, Assign and Close
  each ask for a note, and a pattern that names you says so instead.

## The dev spike (this machine only)

A cost anomaly can be triggered on purpose, to check the whole path (webhook, log record, Clickland's alert). The
spike is never in the ledger:

```bash
LANDLEDGER_DEV_ANOMALY=on pnpm --filter @landledger/api anomaly spike --amount 25   # one provisional row today
pnpm --filter @landledger/api anomaly scan                                         # or wait for the hour
LANDLEDGER_DEV_ANOMALY=on pnpm --filter @landledger/api anomaly reverse            # takes it out again
```

- `spike` writes one **provisional** row for today from the source `dev-anomaly`, service `landledger-dev-anomaly`,
  with its own ingest run. Provisional rows are today's figures; they are never booked into `cost_records`.
- `reverse` deletes every `dev-anomaly` provisional row and reports how many `dev-anomaly` records the ledger holds
  (always 0).
- Both are refused unless `LANDLEDGER_DEV_ANOMALY=on`, which the API itself refuses unless it listens on loopback,
  and unless the database is on this machine (`localhost`, `127.0.0.1`, `::1`). Both are audited
  (`dev_anomaly.spiked`, `dev_anomaly.reversed`).
- A spike nobody reverses expires: the hourly scan deletes it two hours on (`dev_anomaly.expired`).
- It is never in a figure: every read but the anomaly scan leaves the `dev-anomaly` source out (should-fix 11).
- The scan judges each key with and without dev rows: the anomaly is marked `dev: true` (shown as _dev test_) only when
  it is anomalous because of them, so a real jump on the same key that day is not hidden.

## Not yet

Seasonality (weekday and weekend) in the baseline; hourly records (the ledger is daily, and today accrues hourly);
closing Clickland's alert when an anomaly is closed (integrations.md).
