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
| `split` | 3 or more requests of one kind from one requester (a person, or an agent) on one cost center, within 72 hours of the first. Each is under the policy's automatic threshold and together they reach it. | requester and cost center, from the first request |
| `automatic_ratchet` | 3 or more automatic approvals for one requester or agent on one cost center within 30 days | requester and cost center, from the first approval |
| `fast_relay` | a decision relayed under 10 seconds after its card (the evidence hash it cites) was first served to the relay | the decision |
| `same_pair` | one approver made 5 or more of one requester's decisions in 90 days, and at least 80% of them | approver and requester, from the first decision |

The month's automatic total already stops the fourth request of a split from going through by policy (a person
decides it). The anomaly is how Finance hears that the pattern happened.

## What happens to one

- **Stored once:** the `anomalies` table is append only and unique per kind, rule, dimension, key and window start,
  so the next hour's scan adds nothing. The audit log records `anomaly.cost` or `anomaly.approval` (system).
- **Webhook:** `cost.anomaly` or `approval.anomaly`, with `{ anomaly: AnomalyView, url }` (the console's
  `/anomalies?id=…`).
- **Clickland:** a cost anomaly is also logged as an OpenTelemetry log record through the API's OTLP exporter:
  `landledger.event=cost.anomaly`, `landledger.anomaly.{id,rule,dimension,key,observed,baseline,cost_center,dev,url}`.
  A Clickland alert rule counts these records (Clickland's alerts count log and trace rows only).
  `pnpm --filter @landledger/api anomaly clickland-alert` installs the rule, or brings it up to date, through
  Clickland's API with `LANDLEDGER_CLICKLAND_ALERTS_KEY`, a key holding `alerts:write`:

  ```json
  { "name": "Landledger cost anomaly", "signal": "logs", "query": "landledger.event:cost.anomaly",
    "groupBy": "landledger.anomaly.dimension", "thresholdType": "above", "threshold": 0,
    "windowMinutes": 60, "intervalMinutes": 5, "severity": "sev3",
    "labels": { "team": "finance", "app": "landledger" }, "runbookUrl": "http://localhost:4811/anomalies" }
  ```

  Clickland's code is not changed ([integrations.md](integrations.md#clickland)).
- **Acknowledge:** `POST /api/anomalies/:id/acknowledge { note }`, by a person signed in with `requests:write`.
  Auditors read only; a key never acknowledges. It is audited `anomaly.acknowledged` and done once (409 after). Open
  anomalies are the ones from the last 14 days that nobody has acknowledged.
- **Console:** Overview's _Needs you_ lists open anomalies (three, then a link). **Control → Anomalies** lists both
  kinds with their figures, the requests behind a pattern, and who acknowledged each, with what note.

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
- Both are refused unless `LANDLEDGER_DEV_ANOMALY=on`, which the API itself refuses unless it listens on loopback.
  Both are audited (`dev_anomaly.spiked`, `dev_anomaly.reversed`).
- The anomaly a spike raises stays, append only, marked `dev: true` (shown as _dev test_), and is acknowledged like
  any other.

## Not yet

Seasonality (weekday and weekend) in the baseline; hourly records (the ledger is daily, and today accrues hourly).
