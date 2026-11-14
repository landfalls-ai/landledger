# Integrations: what the siblings need

Wave 3 talks to Clickland, Landflow and Landbright through their own APIs. Landledger does not change their code
(plan.md, "Changes in the siblings"). This page says, for each, what Landledger calls, what it needs from them, and
what they would have to add to do better. Keys live in the untracked `apps/api/.env.local`; nothing here is a secret.

## Clickland

### Cost anomalies as Clickland alerts (spec 007)

- **What fits today:** Clickland's alerts count **log and trace rows** in a window. The `landledger.cost.*` series
  Landledger sends are OTLP **metrics**, and no alert rule can watch a metric. So Landledger logs each cost anomaly
  as an OTel log record (`landledger.event=cost.anomaly`, with the anomaly's attributes) through its own OTLP exporter.
  One alert rule counts those records: query `landledger.event:cost.anomaly`, grouped by
  `landledger.anomaly.dimension`, above 0 in 60 minutes, every 5 minutes, `sev3`, labels
  `team: finance, app: landledger` ([anomalies.md](anomalies.md)).
- **Installed by:** `pnpm --filter @landledger/api anomaly clickland-alert`, `POST`/`PUT /api/alerts` with
  `LANDLEDGER_CLICKLAND_ALERTS_KEY`. The key is minted from Clickland's `POST /api/keys`, with the dev bootstrap key,
  on this machine only, and has the scopes `read` and `alerts:write`.
- **Clickland would need,** to do it without log records:
  1. **Metric alerts:** an alert `signal: "metrics"` over a metric query (`metric`, `aggregation`, `where`,
     `groupBy`) with a threshold. Landledger could then alert on `landledger.cost.estimated` directly, though only
     with a fixed threshold. The median and MAD baseline would stay in Landledger.
  2. **Or an events API:** `POST /api/events` (an `events:write` scope) for a client to post a typed event that
     alerts and Landfall see, without going through OTLP logs.
  3. A rule's **labels in the log query result**, so the alert's webhook could carry the anomaly's URL as
     `runbookUrl` per group, not one fixed URL.

### Agent Value (spec 008)

- **Calls:** `GET /api/agents/value?from&to` with `LANDLEDGER_CLICKLAND_VALUE_KEY` (`read`, minted from Clickland's
  `POST /api/keys` with the dev bootstrap key). Landledger takes each agent's runs, outcomes, success rate and value,
  and Clickland's hourly rate. It takes no cost from Clickland: cost comes from Landledger's ledger.
- **Matching:** by agent name within Landflow's service (`landflow-host`). Clickland keys agents as `service/name`,
  and Landledger knows them by Landflow's agent id (`ag_…`) and name.
- **Clickland would need,** to match without names:
  1. Landflow's **agent id** on the value report's agent rows (Landflow's spans carry it as an attribute;
     Clickland could expose it as `agentId`), so a renamed agent stays matched.
  2. A **`month` window** or the `to` as given: it takes `from` and `to`, which is enough today.

## Landflow

### What Landledger reads

- `ai.call` events (Landflow's usage ledger) for AI cost, with each call's agent (`agentId`, the agent's name) and
  workflow ([ingest.md](ingest.md)).

### Agents (spec 008)

- **Compute per agent:** Landledger can show an agent's compute only when the workloads it runs carry the agent. Landflow
  would need to label the pods and containers an agent starts with `landflow.agent.id` (a Kubernetes label, which
  Clickland's rollup can group by), as it already labels them with the workflow.
- **Names:** an agent renamed in Landflow is a new name in Clickland's telemetry; the agent id on Landflow's spans
  (above) would keep it matched.
