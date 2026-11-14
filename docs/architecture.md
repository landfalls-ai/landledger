# Architecture (proposed)

Landledger is the land family's cost subledger: what technology and AI cost, who owns each cost, which spend was
approved, and why a month came out as it did. It is management reporting (showback). The accounting system and
Datarails stay the books of record; payments, the vendor master and journal entries are out of scope.

The family in one line: **Clickland measures, Landledger accounts, Landflow acts, Landbright says who, Datarails
reports.**

## Processes

| Process | What | Port (dev) |
|---|---|---|
| `apps/api` | Fastify 5 API, the MCP server (`/api/mcp`), SCIM 2.0 (`/scim/v2`), the background jobs | 4810 |
| `apps/console` | React 19 + Vite console for finance (`docs/ui.md`) | 4811 |
| `apps/views` | the MCP App `ui://landledger/view`: spend, budget and request cards that render in Claude and in Landflow chats | built into the API |
| Postgres 18 | everything Landledger keeps (compose project `landledger-infra`) | 25532 |
| `fake-datarails` | a stand-in for Datarails' MCP server and upload API, for tests and the demo | 4819 |

One database. Cost records are small next to telemetry (one row per resource, charge and day), so Postgres with
monthly partitions holds years of them; detail beneath a day (a pod, a trace) is read from Clickland on demand, never
copied.

## Code map

```
apps/api            routes, jobs, MCP server, SCIM server, webhooks out
apps/console        the finance console
apps/views          the MCP App view
libs/contracts      zod schemas and types shared by everything (the API contract)
libs/money          Money (bigint micro-units + ISO 4217 code), Decimal, Rate and Quantity, split, FX by date; no floats
libs/focus          the 45 FOCUS 1.4 columns kept and the x_ columns, check(record), reverse and correct
libs/pricing        rate lookup by day, provider and model; priceAiCall (three input buckets, long context); priceCluster (allocated + idle)
libs/allocation     the rules engine: selectors → cost center, team, product, P&L class, capitalisable; direct and spread layers
libs/schema         Postgres migrations (append-only list)
libs/tokens         @land/tokens, copied from Landflow with a drift test (as Clickland does)
deploy/             compose (infra, fakes), Kubernetes later (namespace landledger-dev)
specs/NNN-name/     spec, plan, tasks per feature (the Landbright method)
```

## The data

| Table | Holds | Changes |
|---|---|---|
| `cost_records` | one row per resource, charge and day in 45 FOCUS 1.4 columns ([research/focus.md](research/focus.md) §3; amounts as bigint micro-units, partitioned by billing month), plus `x_RecordId`, `x_Basis` (`estimated` or `invoiced`), `x_Source`, `x_SourceKey`, `x_SourceCost`, `x_RateCardVersion`, `x_IngestRunId`, `x_CorrectionOfId`, `x_WorkflowId`, `x_AgentId`, `x_ActorId`, and for a charge in another currency `x_OriginalCost`, `x_OriginalCurrency`, `x_FxRateId`; `cost_records_focus` shows them under FOCUS names | append only; a correction is a reversal (additive columns negated, `x_CorrectionOfId` set) and a re-entry; `ChargeClass = Correction` only for a locked month, booked in the open month with the original charge day ([money.md](money.md)) |
| `ingest_runs`, `provisional_usage` | each ingest run (source, day, counts, warnings, outcome); today's figures so far, same row shape | a run is finished once; provisional rows are replaced every hour and never summed with records |
| `allocations` | each record's split to cost center, team, product, P&L class, capitalisable flag, with the rule and its version | rebuilt for open periods only |
| `cost_centers`, `teams`, `products` | the dimensions, with owners (Landbright identities) | versioned |
| `rate_cards`, `rate_card_versions`, `rate_lines` | prices per FOCUS pricing unit: `Core-Hours`, `GiB-Hours`, `GB-Months`, `GB`, `1000000 Tokens` per model | a version is a proposal until a person approves it; then its lines never change; effective-dated |
| `allocation_rules` | ordered selectors (namespace, label, service, agent, workflow, provider) and shared-cost splits | a change is a request; effective-dated |
| `fx_rates` | rate per currency pair and date, with its source | append only; a conversion records the rate's id |
| `budgets` | amount per cost center and month, version, source (Datarails, CSV, entered) | versioned |
| `forecasts` | per cost center and month, from drivers (tokens, pod-hours, runs), with a range | recomputed daily |
| `requests` | a proposed spend: kind, amount (monthly or once), cost center, evidence, origin (Landflow run, pull request, Landbright request, console) | status moves forward only |
| `policies` | thresholds and ordered steps per request kind and cost center, approvers by Landbright group | a change is a request |
| `decisions` | step, person, approve or reject, comment, the hash of the evidence they saw | append only |
| `reservations` | budget reserved by an approved request until real cost arrives | reserved → consumed or released |
| `contracts` | vendor, product, cost center, value, seats, term, renewal and notice dates | versioned |
| `invoices`, `reconciliations` | provider invoices and how estimated usage matched them | append only |
| `invoice_estimate_links` | an invoice line and the estimates it replaces, by the estimate's source key | append only; reads never add a linked estimate to its invoice ([money.md](money.md#estimated-and-invoiced)) |
| `cost_center_codes` | every cost center code, plus `SHARED-POOL` and `UNALLOCATED` | append only; allocations and budgets reference it |
| `periods` | each month: open, closing, locked; who closed and locked it | one step forward at a time, by a person; locked is final and refuses inserts; a month locks only when whole (ended, every source-day complete, no provisional rows, every record allocated) unless a controller overrides with a reason |
| `audit_log` | every change above, each entry carrying the hash of the one before | append only |
| `audit_anchors` | the chain's head (seq, hash) each time it was sent outside the database, and where | append only |
| `outbox` | webhook deliveries (Standard Webhooks, the Clickland pattern) | retried, then kept |

## Jobs

| Job | Every | Does |
|---|---|---|
| ingest | hour | pulls AI usage from Landflow and usage totals from Clickland, prices them with the current rate card, appends `estimated` records |
| allocate | after ingest | applies the rules to open periods' new records |
| evaluate | after allocate | budget left, forecast, *at risk* and *over* states; sends `budget.at_risk` once per crossing |
| reconcile | on invoice import | matches invoices to estimated usage per provider and month; appends `invoiced` records and the differences |
| expire | hour | moves request steps past their deadline to escalation; consumes or releases reservations |
| exceptions | week | lists spend above a threshold that no approved request covers |
| emit | minute | sends cost metrics to Clickland over OTLP; delivers the outbox |

## How it meets the land family

```
              Landbright ──OIDC sign-in, groups claim, SCIM──►  Landledger  ◄──usage totals, Agent Value── Clickland
                                                                  │  ▲   │                                  ▲
               cost metrics (OTLP: landledger.cost.*) ────────────┼──┼───┼──────────────────────────────────┘
                                                                  │  │   │
          webhooks: request.step_pending, request.decided,        │  │   │  MCP: spend_by, budget_status,
          budget.at_risk, period.closing ─────────────────────────┘  │   └─ explain_variance, create_request …
                                                                     │                          ▲
          Landflow ── AI usage (pull) · requests, reservations, ─────┘                          │
          relayed decisions (landledger plugin)                                   Claude, Landflow agents, Landlens

          Datarails ◄── month-end actuals and notes (upload API) ── Landledger ── budgets (MCP, read) ──► Datarails
```

### Landflow: the hands

- **AI usage, pulled hourly.** `GET /api/usage?groupBy=…&kinds=ai.call` and `GET /api/insights/ai-usage` with a
  Landflow API key (`lf_`): tokens per model, agent, workflow, team and person. Landledger prices the tokens with its own
  approved rate card and keeps Landflow's estimate beside it, so a drift between the two shows.
- **The `landledger` plugin** (TypeScript SDK, like the `clickland` plugin; HTTP, gRPC, broker and MCP):
  - **Landledger** node: Budget → Check, Cost → Query, Request → Create / Get, Reservation → Create / Release,
    Period → Status. Usable as an AI tool, so agents can check a budget before they act.
  - **Landledger Trigger**: an app webhook for `request.step_pending`, `request.decided`, `budget.at_risk`,
    `cost.anomaly` and `period.closing`.
  - A knowledge kind: an agent asks "why is ENG-AGENTS over?" and gets the drivers with links.
- **Approvals.** Landledger owns the request, the policy and the decision. Landflow carries the conversation:
  1. A flow (infra change, AI budget, tool) creates the request and waits on `request.decided`.
  2. Landledger sends `request.step_pending` naming the step's approvers.
  3. A Landflow flow posts the card in Slack or Teams, or a signed email link; the phone's "Needs you" works too.
  4. A button press comes back to Landflow, which relays it as `POST /api/requests/:id/decisions` with a key
     scoped `decisions:relay` and the person's Landbright identity. Landledger checks that the person is in the
     step's group and isn't the requester, then records it. People can also decide in Landledger's console.
- **Agents request; people decide.** No API key, MCP tool or agent token can decide. The relay scope only carries a
  person's decision, and the MCP server exposes no decide tool.
- **Caps follow budgets.** An approved AI budget writes the matching cap through Landflow's
  `PUT /api/settings/ai-caps` and the agent's limits, so the hard stop and the budget agree.

### Clickland: the eyes

- **Usage totals, pulled daily** (and hourly for the current day): a new Clickland route, `POST /api/usage/rollup`,
  returns CPU core-hours, memory GiB-hours, storage GB-days and network GB per day × namespace, workload, container and
  service, from the kubelet and Docker metrics it already stores. Landledger prices them; Clickland never sees a rate.
- **Agent Value:** `GET /api/agents/value` gives each agent's outcomes and time saved. Landledger reports it as
  capacity freed, with a blended role rate, never salaries.
- **The cost lens, back the other way:** Landledger sends `landledger.cost.estimated` and `landledger.cost.invoiced`
  as OTLP metrics, labelled by service, namespace, agent and cost center, to Clickland's collector. Clickland's
  services page, dashboards and alert rules use them like any metric: engineers see cost next to latency, and a cost
  anomaly is a Clickland alert whose webhook reaches Landflow. Only estimated technology cost leaves Landledger; rates,
  contracts and budgets stay in it.
- **Drill-down:** a service in Explore links to its Clickland page; a cost spike links to the traces of that window.
- Landledger's own traces, metrics and logs go to Clickland like every land app's.

### Landbright: who

- **Sign-in:** Landledger is an OIDC relying party (client `landledger-local`, scopes `openid email profile roles`).
  Group names in the `roles` claim map to roles: `Finance CFO`, `Finance Controllers`, `Finance FP&A`,
  `Budget Owners`, `Landledger Auditors`, `Engineering` (request and read own).
- **SCIM 2.0** at `/scim/v2` (Users, Groups) for when Landbright pushes (its wave 2); until then users and groups come
  from the claim at sign-in.
- **Policies name groups,** so changing who approves is a Landbright change, with Landbright's own approvals and
  audit.
- **Paid seats:** a Landbright access request for an app with seats starts a Landflow flow that raises a *tool or
  seat* request here; Landbright grants only after `request.decided` says approved.
- **Auditor access** is a time-boxed Landbright bundle.

### Landfall: stays agnostic

Landfall knows nothing about Landledger. When an incident closes, a Landflow flow (through Landflow's `landfall`
plugin) asks Landledger for the cost of the incident's window on the affected services, and writes it to the
postmortem through Landfall's generic interface and to a Clickland note. Revenue for cost-to-serve per customer is
not in Landfall today (its billing app is empty); it comes later from a Stripe export or Datarails.

### Landlens: the cluster IDE

Reads `GET /api/costs?namespace=&workload=` (or the MCP tool) to show a workload's cost beside its pods, so the
engineer changing replicas sees the money.

### Datarails: the books' side

- **Budgets in:** over Datarails' hosted MCP server (`mcp.datarails.com`, OAuth with a dedicated least-privilege
  user), read only, into `budgets` with source `datarails`.
- **Actuals out:** at month-end, invoiced actuals, the accrual proposal and accepted variance notes upload to a
  Filebox through Datarails' Data Gateway Service. Notional cluster cost goes only as a memo line, never as actuals.
- Built and tested against `fake-datarails`; a real tenant is wave 5 and your decision.

### Claude and other MCP clients

`/api/mcp` (stateless Streamable HTTP, the Clickland pattern): `spend_by`, `budget_status`, `explain_variance`,
`list_requests`, `get_request`, `create_request`, `reserve`, `period_status`, `render_view`. Views render as the MCP
App `ui://landledger/view`. A person's session sees what their role allows; an agent's key sees what its scopes allow,
and never decides.

## Security and controls

- Roles from Landbright groups; per-cost-center scoping for budget owners.
- Requester ≠ approver, enforced in the API, not only in the console.
- Rate cards, rules and policies change only through approved requests, effective-dated.
- Periods lock; corrections post forward.
- Secrets at rest: session ID tokens and webhook signing secrets are sealed with AES-256-GCM under
  `LANDLEDGER_SECRET_KEY` (`apps/api/src/secrets.ts`); API keys and session cookies are stored as sha256 only.
- The audit log is hash-chained (`sha256(previous_hash ‖ entry)`); `GET /api/audit/verify` walks it. A chain proves
  no entry changed, not that the newest weren't cut off, so its head is **anchored** outside the database every hour
  (`apps/api/src/anchors.ts`): an OpenTelemetry log record and span with `audit.seq` and `audit.hash` to Clickland,
  and webhook `audit.anchor`, recorded in `audit_anchors`. Verify compares the chain with the last anchor and reports
  `truncated` when the log ends before it; a copy kept by Clickland or a webhook receiver catches a cut that took the
  local anchors too.
- API keys `ll_…` with scopes (`read`, `requests:write`, `reservations:write`, `decisions:relay`, `ingest`, `admin`),
  shown once, stored hashed.
- Webhooks signed with Standard Webhooks (as Clickland's).
- Local only: OrbStack, development credentials, fakes for every outside service.
