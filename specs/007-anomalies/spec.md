# Feature 007: Anomalies (wave 3, "Plan and reconcile")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md)

## Why

Finance's promise: an alert the hour a cost jumps. And controls that hold one request at a time can still be gamed in
patterns: a spend split under a threshold, an automatic approval raised again and again, a relayed approval pressed
seconds after the card arrived, one approver waving through one requester.

## User stories

1. **As a budget owner**, when a cost center, service, agent or model costs far more than usual today, I hear of it
   within the hour (webhook `cost.anomaly`, a Clickland alert) and see it on Overview.
2. **As a controller**, approval patterns that look like a control being worked around are listed with the requests
   behind them.
3. **As anyone**, I acknowledge an anomaly with a note; it leaves Needs you and stays in the list, audited.

## Acceptance

- **Cost anomalies**: per dimension (cost center, service, agent, model) and key, each day's cost (by charge day,
  direct layer, ledger and today's provisional rows) against a robust baseline of the 14 days before: median and MAD
  (scaled by 1.4826). Anomalous when the jump above the median is at least `LANDLEDGER_ANOMALY_MIN_USD` (default 1)
  and at least half the median, and the robust score (jump ÷ scaled MAD) is at least 3.5 (a flat baseline, MAD 0,
  counts any such jump). Needs 7 observed days in the baseline (a day counts when any source was read). Today is
  checked as it accrues (cost so far, never projected), every hour.
- Each anomaly is stored once per rule, dimension, key and day (append only) and sent as webhook `cost.anomaly`,
  and as a log record to Clickland (`landledger.event=cost.anomaly`) that a Clickland alert rule counts: the rule
  (`pnpm --filter @landledger/api anomaly clickland-alert`) is installed with a Clickland key holding `alerts:write`.
- **Approval-pattern anomalies**, each with its requests: `split` (3 or more requests from one requester on one cost
  center within 72 hours, each under the automatic threshold, together at or above it); `automatic_ratchet` (3 or
  more automatic approvals for one requester or agent and cost center within 30 days); `fast_relay` (a relayed
  decision under 10 seconds after its step's card was served); `same_pair` (one approver deciding 5 or more of one
  requester's steps in 90 days, at least 80% of that requester's). Webhook `approval.anomaly`.
- **Acknowledge** (a person with `requests:write`; auditors read only): a note, audited; open anomalies are those
  not acknowledged, from the last 14 days.
- **Dev only**: `pnpm --filter @landledger/api anomaly spike` writes a test spike as one provisional row today from
  the source `dev-anomaly` (never a real source, never booked into the ledger), refused unless
  `LANDLEDGER_DEV_ANOMALY=on`; `anomaly reverse` takes every `dev-anomaly` row out again. (Built as a provisional
  row, not a ledger record and its reversal, so that a test leaves nothing in the append-only ledger.)
- **Console**: Overview's Needs you lists open anomalies; an Anomalies section (its own screen) lists both kinds.

## Out of scope

Seasonality in the baseline; hourly records (the ledger is daily; today accrues hourly).
