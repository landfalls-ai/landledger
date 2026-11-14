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

## Tool or seat (spec 010)

A paid seat is spend. Landbright owns access (the bundle, its policy, the grant), Landledger owns the cost (the
request, its policy, the decision, the seats on the contract), and Landflow carries the conversation between them.
Neither decision leaves its system: Landbright's approvers decide access in Landbright; Landledger's approvers
decide the cost in Landledger. Landledger changes neither repo; this is what each would add
([contracts.md](contracts.md#a-seat-tool-or-seat)).

### Landflow: the flow, step by step

With the `landflow requests` key (`read`, `requests:write`) and a webhook subscription (`landflow webhooks`):

1. **Trigger:** Landbright's `request.created` for a bundle whose target carries a seat cost (below), through the
   Webhook trigger Landbright's flows already use (JWT checked against Landbright's JWKS).
2. **Find the contract:** `GET /api/contracts/seats?landbrightApp=<the target's landbrightApp>` →
   `{ contract, seatPrice, left }`. A `404` means no contract grants the app: the flow says so in Landbright (a
   comment on the request) and stops; Finance imports the contract first.
3. **Raise the cost request:** `POST /api/requests` with `kind: "tool_or_seat"`, `amount` = seats × `seatPrice`,
   `recurrence: "monthly"`, the contract's cost center, `seat: { contractId, seats: 1, seatPrice }`, the requester
   (`{ kind: "person", person: { sub } }`, the Landbright `sub` of the person asking), `origin` the `landflow_run`
   (verified when the key is bound to the workflow) with the Landbright request as a related source
   (`landbright_request`, its id and URL), and `idempotencyKey: "landbright-<REQ-n>"` so a retried run raises it once. The
   named person confirms it from their own session (a key naming a person always waits for that), then the cost
   center's owner decides with the seats left in front of them.
4. **Wait** for `request.decided` with that request's id. It carries `request.seat` (`status: reserved` when
   approved), so the flow needs no other call.
5. **Tell Landbright:** approved → settle Landbright's cost step (below) as approved, citing the Landledger request
   id; rejected, cancelled or expired → settle it as denied with Landledger's reason. Landbright's own approvers still
   decide access.
6. **After the grant** (`grant.provisioned` or the grant's `active` for that request):
   `POST /api/requests/:id/applied` `{ note: "Granted in Landbright as REQ-n", links: [<Landbright request URL>] }`.
   The seat moves from reserved to used.

A revoked grant does not give the seat back today; the contract's next import (with a fresh _seats used_) does.

### Landbright would need

1. **A seat cost on the bundle's target**: `landbrightApp` (the key Landledger's contract names, such as `linear`)
   and a flag that a grant of it costs a seat. The flow reads it from the request's bundle.
2. **An external step in the policy**: a step settled not by people voting in Landbright but by a system, with the
   machine API settling it (`POST /api/v1/requests/:id/steps/:step/settle` `{ outcome, reference }`, a dedicated
   scope, audited with the reference). Today every step is people voting, so the cost decision would have to be
   relayed as a person's vote, which it is not. Until then the flow can only comment, and access and cost are
   decided apart.
3. **Seats used from grants** (later): the count of active grants per `landbrightApp`, so Landledger could read seats
   used live instead of from the contract import.

### Landbright: what Landledger already relies on

- Sign-in (OIDC), roles from groups, SCIM 2.0 people, back-channel logout ([identity.md](identity.md)). Nothing new
  for wave 3 beyond the above.
