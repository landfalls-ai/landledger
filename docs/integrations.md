# Integrations: what the siblings need

Wave 3 talks to Clickland, Landflow and Landbright through their own APIs. Landledger does not change their code
(plan.md, "Changes in the siblings"). This page says, for each, what Landledger calls, what it needs from them, and
what they would have to add to do better. Keys live in the untracked `apps/api/.env.local`; nothing here is a secret.

## Clickland

### Cost anomalies as Clickland alerts (spec 007)

- **What fits today:** Clickland's alerts count **log and trace rows** in a window. The `landledger.cost.*` series
  Landledger sends are OTLP **metrics**, and no alert rule can watch a metric. So Landledger logs each cost anomaly
  (and each escalation, at twice the figure) as an OTel log record (`landledger.event=cost.anomaly`, with ids and
  figures, never a summary or a name) through its own OTLP exporter. Approval patterns name people and are never
  logged (review of wave 3, should-fix 10).
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
     `runbookUrl` per group, not one fixed URL (the rule's `runbookUrl` is `LANDLEDGER_CONSOLE_URL/anomalies` today).
  4. **Resolve or close an alert** from outside (`POST /api/alerts/:id/resolve` or an event that clears a group), so
     closing an anomaly in Landledger closes it in Clickland too. Today the alert clears when its window runs out.

### Agent Value (spec 008)

- **Calls:** `GET /api/agents/value?from&to` with `LANDLEDGER_CLICKLAND_VALUE_KEY` (`read`, minted from Clickland's
  `POST /api/keys` with the dev bootstrap key). Landledger takes each agent's runs, outcomes, success rate and value,
  and Clickland's hourly rate. It takes no cost from Clickland: cost comes from Landledger's ledger.
- **Matching:** by agent name within Landflow's service (`landflow-host`). Clickland keys agents as `service/name`,
  and Landledger knows them by Landflow's agent id (`ag_…`) and name.
- **Clickland would need,** to match without names and to say what an agent is worth:
  1. Landflow's **agent id** on the value report's agent rows (Landflow's spans carry it as an attribute;
     Clickland could expose it as `agentId`), so a renamed agent stays matched. Until then a name shared by two agents
     matches neither.
  2. An **`outcomesInstrumented` flag per agent** (an outcome definition covers it), so "no outcome" can be told from
     "not measured". Landledger already reads it when present; until then an agent is measured once it has an
     outcome, and otherwise says _Outcomes not measured_ (should-fix 14). Sub-agents never get outcomes.
  3. A **`month` window** or the `to` as given: it takes `from` and `to`, which is enough today.

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
7. **Access denied, or the grant revoked later:** `POST /api/requests/:id/seats/release`
   `{ reason: "access_denied" | "grant_revoked" | "not_needed", note }` with the same key (the creating key may release
   its own request's seat). The seat goes back to the contract and the request's reservations are released; webhook
   `seat.released`. A seat approved and never applied goes back by itself 30 days after approval (`expired`).

**Landflow would need:** the tool-or-seat template itself (the steps above as a flow in Landflow's templates), and a
step for "cost approved, access denied or grant revoked" that calls the seat-release endpoint, so a seat never stays
reserved for a grant that didn't happen.

### Landbright would need

1. **A seat cost on the bundle's target**: `landbrightApp` (the key Landledger's contract names, such as `linear`)
   and a flag that a grant of it costs a seat. The flow reads it from the request's bundle.
2. **An external step in the policy**: a step settled not by people voting in Landbright but by a system, with the
   machine API settling it (`POST /api/v1/requests/:id/steps/:step/settle` `{ outcome, reference }`, a dedicated
   scope, audited with the reference). Today every step is people voting, so the cost decision would have to be
   relayed as a person's vote, which it is not. Until then the flow can only comment, and access and cost are
   decided apart.
3. **Seats used from grants** (later): the count of active grants per `landbrightApp`, with the `as_of` time it was
   taken, so Landledger could read seats used live instead of from the contract import (the contract CSV takes
   `seats_used_as_of` today).

### Landbright: what Landledger already relies on

- Sign-in (OIDC), roles from groups, SCIM 2.0 people, back-channel logout ([identity.md](identity.md)). Landbright
  signs each logout delivery attempt afresh, with a new random `jti` and `iat` (its
  `apps/control/src/logout/logout-sender.ts`), so a `jti` is never repeated by it; Landledger ends a person's sessions
  created before each valid token's `iat` whatever its `jti`, and audits a seen `jti` as a replay. Nothing new for wave
  3 beyond the above.

## Landbright's seat-cost gate (proposed by Landbright)

Landbright's answer to "Landbright would need" above, as it proposed it. Landledger records it here and is ready for
its side; Landbright builds its own.

- **An external step:** a policy step of `kind: 'external'`, settled by a system rather than by people voting, through
  `POST /api/v1/requests/:id/steps/:step/settle` `{ outcome, reference }` with a dedicated `steps:settle` scope,
  audited with the reference (Landledger's request id). Landflow holds that scope and settles it from Landledger's
  `request.decided` (step 5 of the flow).
- **The cost step first,** with its own deadline: access approvers in Landbright see a request whose cost is already
  decided, and a cost step that runs out ends the request rather than waiting on it.
- **Break-glass skips it:** an emergency grant goes through without the cost step, and the flow then raises the cost
  request after the fact with `origin: { type: 'landbright_request', …, breakGlass: true }`. Landledger accepts the
  flag (additive, review of wave 3) and lists every such request on the exceptions report (`breakGlass`) until it is
  approved; the Request page says _break-glass: granted first, approved after_.
- **An extension rides on the first request** (no new cost request) unless it crosses the contract's renewal date or
  changes the number of seats; then it is a new seat request.
- **Seats used = grants + standing SCIM members,** reported separately (grants through requests, and people holding
  the app through a SCIM group), each with its `as_of` time, so Landledger can tell seats it approved from seats that
  came with a group.

## Wave 4: month-end

### Landflow: variance notes

Accepting the accrual (close step 7) sends `notes.draft_requested`, once per snapshot. Its `data` holds the month,
the snapshot's sha256, every note needed with the figures it may cite, and `draftUrl`. Landflow's flow writes each
note and posts it to `POST /api/notes/:month/drafts`, using a key that holds only `notes:draft`. On this machine that
key is named `landflow notes` and is kept as `LANDLEDGER_NOTES_KEY` in `~/.config/land-family/landledger-landflow.env`.

Each draft names:

- its agent;
- its sponsor, the person who answers for the agent and who never accepts the note (the key's minter never accepts
  it either, whatever sponsor the draft names);
- the Landflow run.

Each cited figure must match the snapshot to the cent, and every amount the text states must be one it cites, or the
draft is refused with 422. A note already accepted on the current snapshot takes no new draft (409). Landflow can
read the figures first from `GET /api/notes/:month/figures`.

**Rounding.** Landledger posts an amount half away from zero at the cent from its six-decimal string
([money.md](money.md)). A flow that formats a figure with `Number(v).toFixed(2)` can differ by a cent at a half cent
(binary floating point), and a stated amount that differs from its cite is refused. Landflow's flows should state
the posted figure Landledger gives, or round the string itself (review of wave 4, nit; Landflow's to change).

**Left to Landflow** (review of wave 4, should-fix 15–18): the tool-or-seat flow's 409 after a crash between
_Create_ and _Remember the seat request_ (look the request up and write the row; an hourly reconcile), a rejected
break-glass seat that stays granted and an extension approved after its grant ended, and the incident-cost flow's
labels and its windows over 31 days.

If no agent answers, a person drafts from the template ([variance-notes.md](variance-notes.md)). Building Landflow's
flow is Landflow's work.

### Landflow and Landfall: an incident's cost

When an incident closes, Landflow's flow calls `GET /api/cost/window?services=…&from=…&to=` with a `read` key. It
writes the answer, labelled _estimated_, into Landfall's postmortem ([spend.md](spend.md#an-incidents-cost)).
Landfall itself knows nothing of Landledger.

### Datarails

The connector talks to `fake-datarails` on this machine ([datarails.md](datarails.md)). It reads budgets over MCP
and sends actuals and notes through the FileBox upload. There is no tenant: wave 5 builds our own FP&A product, fed
by Landledger ([plan.md](plan.md), Decision 4), and the connector stays as the contract it takes.

### Landlens

Landlens is meant to read a workload's cost. That was moved from wave 3 to wave 4, and it is still open. Explore's
`GET /api/spend` already groups by namespace and workload, and `GET /api/cost/window` takes service names.
