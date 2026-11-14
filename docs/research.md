# Landledger: research

What studying OpenCost and FOCUS taught us, and what Landledger takes from them. Gathered on 14 November 2026 from:

- the OpenCost source (`upstream/opencost`, release **v1.121.3**, `2f1af7f`, 2026-09-16, Apache-2.0), its allocation,
  sharing, idle, pricing, currency and inference-cost packages read file by file;
- the OpenCost UI (`upstream/opencost-ui`, release **v1.121.2**, `5babf86`, Apache-2.0; no UI release was cut for
  1.121.3), for how allocation and idle are shown;
- the FOCUS specification (`upstream/focus-spec`, tag **v1.4**, `f1eeb30`, ratified 2026-06-04, CC-BY-4.0);
- Craft Anything 0.6.1 source graphs of OpenCost's allocation and pricing code and of the UI
  (`study/opencost-source-graph.md`);
- a read-only probe of Clickland's ClickHouse on this machine (`study/clickland-live/probe.md`), to see what the usage
  rollup can be built from;
- Landflow's usage and AI-usage code and reference (`landflow-clickland` at `c054aa8a`: `docs/reference/api.md`,
  `docs/second-brain.md`, `apps/web/src/lib/server/ai-usage/`, `apps/web/src/lib/server/usage/`).

The detail is in two reports: [OpenCost](research/opencost.md) and [FOCUS 1.4](research/focus.md). Claims cite
`upstream/<repo>/<file>:<line>` or a file in `study/`; claims from documentation only are marked [docs] in the reports.
`scripts/fetch-upstream.sh` re-fetches the exact sources.

---

## 1. The finding that decides the design

OpenCost is a **calculator**: every query recomputes cost from metrics and the current price config, in `float64`, with
no periods, no price history, no corrections and no reconciliation to invoices (opencost.md §9, §11). FOCUS is a
**ledger format**: 1.4 defines append-only "ledger" corrections, closed billing periods, invoice reconciliation and a
rounding tolerance (focus.md §1, §6). So Landledger takes OpenCost's *cost model* (what a workload costs) and FOCUS's
*record model* (how that cost is written down and corrected), and builds neither OpenCost's Prometheus layer nor a
FOCUS export. The usage comes from Clickland and Landflow; the arithmetic is Landledger's own, in exact decimals.

## 2. What a workload costs (from OpenCost)

1. **Resource-hours × a unit price, per resource**, summed: CPU core-hours, memory GiB-hours, storage, network
   (`upstream/opencost/pkg/costmodel/allocation_helpers.go:1927`-`:1929`).
2. **The charge is max(request, usage), integrated per sample.** OpenCost's exporter writes the pointwise maximum every
   minute and averages it over the window (`pkg/costmodel/costmodel.go:773`, `metrics.go:676`); the request is a floor
   (`allocation_helpers.go:265`). On this machine the difference is large: for `landflow-dev` over two hours,
   Σ max(request, usage) = 1.49 core-hours against max(Σ request, Σ usage) = 1.07, **+40%**
   (`study/clickland-live/probe.md` §5). A daily total of requests and a daily total of usage cannot recover it, so the
   maximum must be taken in Clickland, per sample.
3. **Idle is capacity minus allocated, per resource**, per cluster or node (`pkg/costmodel/costmodel.go:2137`-`:2139`),
   and can be shared in proportion to each workload's cost of that resource (`core/pkg/opencost/allocation.go:2304`).
   On this machine the node has 18 allocatable cores and 15.7 GiB, and the busiest namespaces used under 2 of 36
   core-hours in two hours (probe §5): **idle is most of the cluster's cost.**
4. **Shared namespaces, labels and fixed overhead** are split weighted by cost or evenly, with coefficients computed
   over everything before filters so a filtered view keeps its shares (`allocation.go:2227`-`:2288`). The open API
   exposes none of it (`pkg/costmodel/costmodel.go:1745`-`:1750`).
5. **Custom prices for on-premises clusters** are one rate per unit (`configs/default.json`) or a CSV whose
   `EndTimestamp` and `Version` columns are parsed but never used (`pkg/cloud/provider/csvprovider.go:48`, `:55`): a new
   price reprices the past. Hours per month are 730 (`core/pkg/util/timeutil/timeutil.go:33`).
6. **Network**: only egress that OpenCost's own daemon classifies is priced; total bytes are recorded unpriced
   (`pkg/costmodel/allocation.go:448`-`:453`). **Storage**: a claim's requested size × hours held
   (`allocation_helpers.go:2358`).

## 3. How it is written down (from FOCUS 1.4)

1. **`BilledCost` is invoiced money only**: "not estimated or inferred values" (`billedcost.md:20`). Landledger's
   estimated rows carry `BilledCost` 0 and the estimate in `EffectiveCost` (= rate card × quantity): the one documented
   departure, and the data-shape form of "notional cost never goes to the books as actuals" (focus.md §2).
2. **Ledger corrections**: a reversal with negated amounts and a re-entry, never an edit
   (`attributes/correction_handling.md:49`). `ChargeClass = Correction` is only for a correction to a closed period,
   which is booked in the open period with the original charge dates
   (`appendix/correction_handling_examples/closed_billing_period.md:11`).
3. **Split cost allocation** (1.3): one charge split into allocated rows plus a null-`AllocatedResourceId` unallocated
   portion that add up to the origin (`attributes/data_generator_calculated_split_cost_allocation_handling.md:9`-`:11`).
   That is cluster capacity → workloads + idle, in FOCUS's own columns.
4. **Units**: `Token` is a recommended unit, prices per million are `1000000 Tokens`, GB and GiB differ
   (`attributes/unit_format.md:28`, `:82`, `:88`, `:121`). **Custom columns** take the `x_` prefix, Pascal case, `Id`
   and `Name` suffixes (`attributes/custom_column_handling.md:23`-`:31`).
5. **Periods**: the Billing Period dataset's `Open` / `Closed`, closed being final unless the customer asks
   (`datasets/billing_period/columns/billingperiodstatus.md:13`).
6. **Reconciliation tolerance**: `MAX(100 × subunit, √rows × 0.5 × subunit)` (`appendix/rounding_variance_tolerance.md:9`),
   for wave 3's invoice matching.

## 4. What the sources give Landledger today

- **Clickland** already stores, every ~30 s, `k8s.container.cpu_request`, `k8s.container.memory_request`,
  `container.cpu.usage`, `container.memory.working_set` and `k8s.node.allocatable_cpu` / `_memory`, keyed by cluster,
  namespace, pod, container and node (probe §1, §3, §4). It stores **no workload owner and no pod labels**: a
  container's attributes are cluster, namespace, node, pod name and uid, container and image (probe §4), so "the
  `landflow-web` Deployment" or "label `team=billing`" can't be selected yet. It stores **no pod network and no volume
  metrics** (probe §2):
  its kubelet receiver collects the `node`, `pod` and `container` groups only
  (`clickland/deploy/k8s/cluster-metrics/cluster-metrics.yaml:74`). Docker containers have usage and network bytes but
  no requests.
- **Landflow** records each AI call (`ai.call`) with provider, model, operation, input and output tokens and its own
  cost estimate, under a stable id (`landflow-clickland/apps/web/src/lib/server/ai-usage/index.ts:174`-`:183`). The
  event **lacks cache-read and cache-write tokens**, which the `ai_usage` table and `/api/insights/ai-usage` carry
  (`apps/web/src/lib/shared/ai-usage.ts:9`-`:15`). A long-context tier prices a whole request
  (`apps/web/src/lib/server/ai-usage/prices.ts:146`), so pricing must be per call. Events' `day` is the instance's time
  zone (`apps/web/src/lib/shared/brain.ts:89`); raw events are kept 90 days, `ai_usage` 400 days, and the daily rollups
  keep no model (`docs/second-brain.md:63`-`:64`). The events route filters `at >= from AND at <= to`, both inclusive,
  newest first, at most 5,000 (`apps/web/src/lib/server/usage/query.ts:108`, `:143`-`:147`).

## 5. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Cluster cost = node **allocatable** × rate card, split into one row per workload container (its allocated quantity) and one **idle** row per cluster, day and resource, in FOCUS's split-cost columns | §2.3, §3.3: totals reconcile to the cluster; idle is visible |
| D2 | Ask Clickland's `POST /api/usage/rollup` for, per UTC day × cluster × namespace × workload × container: CPU and memory **requested, used and allocated** (Σ per-sample max), node allocatable, network bytes sent, and claim capacity when it exists, the workload's owner kind and name and its pod labels, in raw units (core-hours, byte-hours, bytes) as decimal strings | §2.2, §4: the architecture's rollup (used totals only) can't support max(request, usage), idle or label rules |
| D3 | Idle is the *Shared pool* row by default; a weighted per-resource split into teams is an opt-in allocation rule; coefficients are computed before filters | §2.3–2.4; ui.md: shared and idle never folded into teams |
| D4 | Shared namespaces, labels and fixed overhead are allocation rules: weighted, even, or fixed ratios; versioned, effective-dated, changed by request | §2.4: finance owns the split; OpenCost's open API has none of it |
| D5 | The rate card is versioned and effective-dated in exact decimals; every row carries `x_RateCardVersion`; GB-month → GB-hour uses 730 h, stated on the card | §2.5: past months must not move when a price changes |
| D6 | Money: integer **micro-units** (6 decimal places) with an ISO 4217 code; rates and quantities exact decimals; computed amounts round **half-even** to micro-units; posted figures round **half away from zero** to the currency's minor unit; splits use largest remainder | OpenCost is `float64` throughout (opencost.md §9); FOCUS rows carry sub-cent amounts (`rounding_variance_tolerance.md:3`); a $0.003 call can't be stored in cents |
| D7 | `cost_records` uses 45 FOCUS 1.4 columns plus `x_` columns; `BilledCost` = 0 on estimated rows | §3.1; focus.md §3, §7 |
| D8 | Corrections are FOCUS ledger style; `ChargeClass = Correction` only for corrections to a locked month, booked in the open month | §3.2 |
| D9 | A day is a UTC day; AI calls are bucketed by their UTC timestamp, never Landflow's `day` | §4; FOCUS date/times are UTC (`attributes/datetime_format.md:9`) |
| D10 | AI is priced per call (input, cache read, cache write, output; long-context tier), then summed per day × provider × model × workflow × agent × actor × price line | §4: a tier applies per request |
| D11 | Ask Landflow to add `cacheRead` and `cacheWrite` to the `ai.call` event's attributes; until then, a per-day, per-model `Adjustment` row from `/api/insights/ai-usage` corrects cache pricing | §4 |
| D12 | Network is ingested as a quantity and priced only where the rollup marks bytes as egress; storage is priced from claim capacity once Clickland collects the kubelet `volume` group | §2.6, §4 |
| D13 | Ingest is idempotent by `x_SourceKey`; a re-ingest that changes a figure in an open period appends a reversal and a re-entry; one that changes nothing writes nothing | §3.2; architecture: append only |
| D14 | Allocation (cost center, team, product, P&L class, capitalisable) is a separate table, rebuilt for open periods only, each row naming its rule and rule version | architecture; FOCUS's split is resource-level, not organizational |
| D15 | The current UTC day is **provisional**: ingested hourly into a replaceable `provisional_usage` table the console and alerts read; a day is appended to `cost_records` once it has settled (the next day, after the sources' watermark); later changes are corrections | Hourly ledger rows would mean a reversal and re-entry per key every hour; the ledger keeps only complete days |

## 6. Changes to the plan and architecture

- **Clickland's rollup** (plan, *Changes in the siblings*) needs requested and allocated figures and node capacity, not
  only usage totals (D2); workload owners and pod labels (the collector's Kubernetes attributes processor, or a lookup
  at rollup time); and, for storage, the kubelet `volume` metric group. This goes to Clickland's session as the
  contract in `specs/002-ingest/plan.md`.
- **Landflow** gets a one-line request: cache tokens on `ai.call` (D11). Nothing else in Landledger's ingest needs a
  Landflow change.
- **`cost_records`** columns: `x_IngestRun` → `x_IngestRunId`, plus `x_RecordId`, `x_SourceKey`, `x_SourceCost`,
  `x_CorrectionOfId`, `x_WorkflowId`, `x_AgentId`, `x_ActorId` and the five `Allocated*` columns (focus.md §7).
- **Money** is integer micro-units, not cents (D6); the architecture's "integer minor units" holds at posting.
- **Corrections**: the architecture's "a correction is a new row with `ChargeClass = Correction` in the open period"
  becomes D8 (FOCUS sets `Correction` only for closed periods).

## 7. Still open

- **Network pricing.** Neither kubelet nor Docker says which bytes left the machine. Price all bytes sent at the egress
  rate (an upper bound) or leave network unpriced? Spec 002 defaults to unpriced quantity until finance decides.
- **Docker containers** have no requests and no host capacity in the rollup: priced on usage alone, with no idle. Should
  the Docker host count as a second cluster with its own capacity?
- **Workload names and labels**: until Clickland adds owners and labels, spec 002 derives a Deployment's name from its
  pod name (dropping the ReplicaSet and pod hashes), which is a guess for other owners, and label rules match nothing.
- **Storage** stays empty until Clickland enables the kubelet `volume` group (or reports claim capacity another way).
- **Weighted idle split** per resource (OpenCost's) or by total cost? Spec 003 takes OpenCost's per-resource split.
- The Clickland rollup contract is being built now by Clickland's session. Its draft (uncommitted on 14 November,
  `clickland/libs/contracts/src/usage.ts`) has used CPU and memory, filesystem storage and network per hour or day,
  grouped by attributes including `k8s.deployment.name`, as JSON numbers, with coverage: no requests, no allocated
  maximum, no node capacity, no labels. Spec 002 designs to the draft plus the additions D2 asks for, and tests against
  a fake until the real route exists.
