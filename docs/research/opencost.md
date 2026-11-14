# OpenCost: how a cluster's cost is allocated

How OpenCost turns a Kubernetes cluster's metrics into a cost per container, namespace or label, read from its source,
and what Landledger takes, changes or rejects. OpenCost is the CNCF project behind Kubecost's allocation model.

Source: `upstream/opencost` at **v1.121.3** (`2f1af7f`, released 2026-09-16, Apache-2.0) and `upstream/opencost-ui` at
**v1.121.2** (`5babf86`, Apache-2.0), pinned by `scripts/fetch-upstream.sh`. Evidence: Craft Anything source graphs of
the allocation and pricing packages (`study/opencost-source-graph.md`) and a read-only probe of Clickland's ClickHouse
(`study/clickland-live/probe.md`). Claims cite `upstream/<repo>/<file>:<line>`; a claim from documentation only is
marked [docs].

The difference that shapes everything below: OpenCost reads Prometheus and prices nodes it discovers; Landledger reads
**Clickland's `POST /api/usage/rollup`** (CPU core-hours, memory GiB-hours, storage and network per day × namespace,
workload, pod, container and service) and prices it with **its own rate card**. Landledger never queries Prometheus or
a cloud price API.

## Summary

OpenCost computes, for a time window, one `Allocation` per container: resource-hours (CPU core-hours, RAM byte-hours,
GPU hours, PV byte-hours) multiplied by a per-node price, plus network, load-balancer and shared costs. Every number is a
`float64`. Idle is the node's (asset's) cost minus what containers were allocated, per resource, and can be spread over
the containers in proportion to their cost. Shared namespaces, labels and fixed overhead are spread the same way, after
the idle step. Aggregation by any property (namespace, label, team, …) happens after allocation and sharing. There is no
invoice reconciliation, no effective-dated price, no audit trail and no currency history.

```
Prometheus (or the collector source)      custom pricing (JSON / CSV)
   │ avg_over_time(max(request, usage))      │ CPU, RAM, GPU per hour; storage per GiB-hour; egress per GiB
   ▼                                         ▼
computeAllocation(start, end)  ──►  Allocation per cluster/node/namespace/pod/container
   CPUCoreHours × node CPU price + RAM GiB-hours × node RAM price + GPU hours × GPU price
   + PV GiB-hours × PV price + classified egress GiB × price + LB cost by hours of use
   │
   ├── includeIdle: idle = asset cost − allocated cost, per cluster or node, per resource (CPU, GPU, RAM)
   ▼
AggregateBy(properties, options) ── share idle (weighted), share namespaces/labels/overhead (weighted or even),
                                     filter, then group by the requested properties
```

## 1. The cost model

### CPU, memory and GPU

- `computeAllocation` queries about sixty series in parallel for the window and applies them to a map of pods
  (`upstream/opencost/pkg/costmodel/allocation.go:219`, `:272`-`:357`).
- Resource-hours are an average rate times the container's running time: `CPUCoreHours = cpuCores × hours`
  (`upstream/opencost/pkg/costmodel/allocation_helpers.go:212`); RAM byte-hours and GPU hours the same way
  (`allocation_helpers.go:468`, `:929`).
- Cost is resource-hours times the node's hourly price: `CPUCost = CPUCoreHours × CostPerCPUHr`,
  `RAMCost = RAMByteHours / 1024³ × CostPerRAMGiBHr`, `GPUCost = GPUHours × CostPerGPUHr`
  (`allocation_helpers.go:1927`-`:1929`). A node discount, if configured, scales the CPU and RAM prices
  (`allocation_helpers.go:1913`).
- An allocation's total is the sum of its parts, each with an adjustment: CPU + GPU + RAM + PV + network + load
  balancer + shared + external (`upstream/opencost/core/pkg/opencost/allocation.go:925`).
- Allocations are named `cluster/node/namespace/pod/container` (`pkg/costmodel/allocation.go:550`).

### Persistent volumes

- A PV's cost is its hourly price per GiB times the claim's size times the hours the pod held it:
  `cost = CostPerGiBHour × gib × hrs` (`allocation_helpers.go:2358`). It is the **requested** size, not bytes used.
- A claim shared by several pods is split by the time each pod held it (coefficients from the overlapping windows,
  `allocation_helpers.go:2282`-`:2380`), then evenly across the pod's containers.
- A PV with no claim, or a claim with no pod, goes to a per-cluster or per-namespace `__unmounted__` allocation
  (`allocation_helpers.go:2387`, `pkg/costmodel/allocation.go:518`-`:521`).

### Network

- Only **classified egress** is priced: cross-zone, cross-region, internet and NAT-gateway GiB, each times its own price
  (`pkg/costmodel/allocation.go:449`-`:453`, `allocation_helpers.go:1025`-`:1070`). The classification comes from
  OpenCost's network-costs daemon, `kubecost_pod_network_egress_bytes_total{internet="true", …}`
  (`upstream/opencost/modules/prometheus-source/pkg/prom/metricsquerier.go:1584`).
- Total bytes sent and received (`container_network_transmit_bytes_total`, `metricsquerier.go:1677`) are recorded on the
  allocation but **not priced** (`pkg/costmodel/allocation.go:448`).
- A pod's network GiB is split evenly across its containers (`allocation_helpers.go:1063`).

### Load balancers

- A load balancer's cost is shared among the allocations behind its service in proportion to the hours each overlapped
  it: `LoadBalancerCost += lb.TotalCost × hours / totalHours` (`allocation_helpers.go:1714`). With no matching pods it
  goes to `__unmounted__` (`allocation_helpers.go:1684`-`:1688`).

**Landledger.** *Takes* the shape: cost = resource-hours × a per-unit price, per resource, summed. *Changes* where the
hours come from (Clickland's rollup, already integrated per day) and where the price comes from (the rate card, one
blended internal rate per unit, not per node). *Changes* the arithmetic to exact decimals (§9). *Rejects* GPU, load
balancers and node discounts for now: the OrbStack cluster has neither GPUs nor cloud load balancers, and the rate card
has no lines for them; the rule and the column exist so a later rate card can add them.

## 2. Integrating usage over time

- **Window and batches.** A window longer than `BatchDuration` (the maximum Prometheus query span, a day by default) is
  computed in batches and accumulated (`pkg/costmodel/allocation.go:35`-`:74`;
  `modules/prometheus-source/pkg/env/promenv.go:168`).
- **Resolution.** The data source's resolution (`PROMETHEUS_QUERY_RESOLUTION_SECONDS`, default 300 s,
  `promenv.go:118`) sets the step of the subqueries that find when a pod, PV or load balancer existed, e.g.
  `avg(kube_persistentvolume_capacity_bytes{…}) by (…)[<window>:<res>m]` (`metricsquerier.go:206`). A pod's start and
  end are its first and last sample; a pod seen in a single sample gets one resolution of life
  (`allocation_helpers.go:2525`-`:2557`).
- **Averages, not sums.** Resource series are averaged over the window, then multiplied by running time:
  `avg(avg_over_time(container_cpu_allocation{…}[<window>]))` (`metricsquerier.go:1035`), requests
  `avg(avg_over_time(kube_pod_container_resource_requests{resource="cpu"}…))` (`:1053`), usage
  `avg(rate(container_cpu_usage_seconds_total…[<window>]))` (`:1089`).

**Landledger.** *Rejects* the Prometheus layer entirely. Clickland's rollup does the integration in ClickHouse, per day
and per container, from samples taken every 30 s (`study/clickland-live/probe.md` §3: request, usage and allocatable
series 27–58 s apart; usage occasionally up to 6 minutes). Landledger's day is a UTC calendar day (FOCUS requires UTC,
`docs/research/focus.md`), and it ingests the current day hourly and replaces it with the final figure the next day
(spec 002). *Takes* the rule that a short-lived container counts for the time it existed, which the rollup gets for free
by summing samples.

## 3. Requests against usage: max(request, usage)

- OpenCost's own exporter writes `container_cpu_allocation` and `container_memory_allocation_bytes` every minute
  (`pkg/costmodel/metrics.go:862`) with the value `max(request, usage)` of that moment
  (`pkg/costmodel/costmodel.go:757`, `:773`; recorded at `metrics.go:670`-`:676`). The allocation query averages that
  series over the window (`metricsquerier.go:1035`), so OpenCost charges **the time integral of the pointwise maximum**.
- Then, if the average allocation is below the average request, the request wins
  (`allocation_helpers.go:265`-`:267`; RAM `:522`). So the charge is never below the request.
- Usage averages and maxima are kept beside the allocation for efficiency figures (`CPUEfficiency` = usage / request,
  `core/pkg/opencost/allocation.go:1031`).

**Landledger.** *Takes* max(request, usage) as the basis of a workload's cluster cost: a reserved core costs whether or
not it is busy, and bursting above the request uses capacity too. *Changes* where the maximum is taken: it has to be
taken **per sample, inside Clickland**, because a daily total of requests and a daily total of usage cannot recover it.
The live probe shows how much this matters: for `landflow-dev` over two hours, max(Σ request, Σ usage) = 1.068 core-hours
but Σ max(request, usage) = 1.492 core-hours, **40% more** (`study/clickland-live/probe.md` §5). So Landledger asks the
rollup for three figures per container and day: requested, used, and allocated (Σ of the per-sample maximum), for CPU
and for memory. This is the first change to the rollup contract (spec 002, *The rollup Landledger asks for*).

## 4. Idle cost

- Idle is computed only when asked (`includeIdle`, `pkg/costmodel/aggregation.go:360`) from the **asset** side: the
  cluster's (or node's) total CPU, GPU and RAM cost minus the allocations' cost, resource by resource
  (`pkg/costmodel/costmodel.go:2088`, `:2137`-`:2139`). Negative idle (allocations above the asset cost) is clamped to
  zero with a warning (`costmodel.go:2142`-`:2156`). PV, network and load balancers have no idle.
- Idle is per cluster by default, per node with `idleByNode` (`aggregation.go:381`; the key is chosen in
  `core/pkg/opencost/allocation.go:2624`).
- **Sharing idle.** With `shareIdle=true` the handler sets `ShareIdle = ShareWeighted` (`costmodel.go:1739`-`:1743`).
  `computeIdleCoeffs` gives each allocation a share of its cluster's idle **per resource**, in proportion to its cost of
  that resource: CPU idle by CPU cost, RAM idle by RAM cost, GPU idle by GPU cost
  (`core/pkg/opencost/allocation.go:2304`, `:2342`-`:2348`). Only weighted sharing exists for idle: anything other than
  `ShareWeighted` becomes `ShareNone` (`allocation.go:1623`-`:1625`).
- Undistributable idle (idle CPU where nothing used CPU) stays as an `__idle__` row; with `SplitIdle` off, all idle
  rows merge into one (`core/pkg/opencost/summaryallocation.go:1238`-`:1244`).
- The UI shows idle by default (`upstream/opencost-ui/app/services/allocation.ts`, `includeIdle = true` in the cache
  key) as its own `__idle__` row.

**Landledger.** *Takes* idle as capacity cost minus allocated cost, per resource, and the per-resource weighted split.
*Changes* the defaults: idle is **never** folded into teams in the books; it is reported as the *Shared pool* row
(`docs/ui.md`, Explore), and a weighted split is a view option and an allocation rule, so a cost center's figure never
silently includes other teams' idle. *Changes* the capacity side: OpenCost prices nodes from a cloud or custom price;
Landledger prices the node's **allocatable** cores and GiB per day with the same rate card. That needs the node's
allocatable per day from the rollup: Clickland already stores `k8s.node.allocatable_cpu` and
`k8s.node.allocatable_memory` (probe §1; enabled in Clickland's
`deploy/k8s/cluster-metrics/cluster-metrics.yaml:83`). On this machine the node has 18 allocatable cores and 15.7 GiB,
and the three busiest namespaces allocated under 2 of 36 core-hours in two hours (probe §5): **idle will be most of the
cluster's cost**, which is exactly why it must be its own line. *Rejects* clamping negative idle silently: if allocated
ever exceeds capacity Landledger records the excess as an ingest warning on the day, not a zero.

## 5. Shared namespaces, labels and overhead

- The aggregation options carry `Share` (a filter), `SharedNamespaces`, `SharedLabels`, `SharedHourlyCosts` and
  `ShareSplit` (`core/pkg/opencost/allocation.go:1533`-`:1551`).
- Allocations matching the share filter move to a share set before aggregation (`allocation.go:1739`-`:1744`).
  `SharedHourlyCosts` become synthetic `__shared__` allocations worth `cost × hours` of the window
  (`allocation.go:1843`-`:1863`).
- Share coefficients: **weighted** by each aggregate's cost excluding its own shared cost and unmounted PVs, or **even**
  (each aggregate counts 1) (`allocation.go:2227`, `:2278`-`:2288`). Idle and unmounted allocations don't receive shares
  (`allocation.go:2253`-`:2261`).
- Filters don't distort shares: an allocation that a filter will drop contributes to a `__filtered__` bin, so a filtered
  view shows the same shared cost per aggregate as the unfiltered one (`allocation.go:2270`-`:2276`). Idle gets the same
  treatment through "idle filtration coefficients" (step 7 in the comment at `allocation.go:1563`-`:1611`).
- The open `/allocation/compute` handler exposes **none** of the sharing options: it passes only `ShareIdle`,
  `IdleByNode`, proportional asset costs and aggregated metadata (`pkg/costmodel/costmodel.go:1745`-`:1750`). The
  machinery is used internally, e.g. by the inference-cost collector to share labelled gateway pods
  (`upstream/opencost/pkg/inferencecost/collector.go:192`-`:201`). Kubecost's API exposes `shareNamespaces`,
  `shareLabels` and `shareCost` [docs].

**Landledger.** *Takes* the three kinds of shared cost (namespaces such as `kube-system` and `clickland-dev`, labels,
fixed overhead per hour or month), the two splits (weighted, even) and the `__filtered__` rule (compute coefficients over
everything before filtering). *Changes* where they live: they are **allocation rules**, versioned and effective-dated,
changed only by an approved request (`docs/architecture.md`, `allocation_rules`), and the split's result is stored in
`allocations` with the rule and version that made it, instead of being recomputed per query. *Adds* a fixed-ratio split
(finance's agreed percentages) because a cost center's share of a platform is often a negotiated number.

## 6. Custom pricing for on-premises clusters

- **JSON custom pricing** (`upstream/opencost/configs/default.json`): one price per resource, as strings: `CPU` per
  core-hour, `RAM` per GiB-hour, `GPU` per GPU-hour, spot variants, `storage` per GiB-hour (`0.00005479452`, i.e. $0.04
  per GiB-month ÷ 730 h, `configs/default.json:9`), and per-GiB prices for zone, region, internet and NAT egress.
- It applies when `CustomPricesEnabled == "true"` (`pkg/cloud/provider/provider.go:51`), replacing every node's price
  (`allocation_helpers.go:2002`-`:2004`, `:1936`-`:1974`); otherwise it fills in a node price that is missing or zero
  (`allocation_helpers.go:2013`-`:2026`). PV and network prices come from the same config
  (`pkg/cloud/provider/customprovider.go:294`, `:304`).
- **CSV pricing** (`configs/pricing_schema.csv`): `EndTimestamp, InstanceID, Region, AssetClass, InstanceIDField,
  InstanceType, MarketPriceHourly, Version`; asset classes `node`, `pv`, `gpu`, `gpulabel`; a row matches a node or PV by
  a field such as `metadata.name` or `spec.providerID` (`pkg/cloud/provider/csvprovider.go:155`-`:192`).
  - `EndTimestamp` and `Version` are parsed (`csvprovider.go:48`, `:55`) but **never read**: there is no effective date
    and no history. A new file replaces the old prices for every window, past ones included.
  - The per-class average price has a bug: the running average is written into the count map
    (`nodeclasscount[classKey] = newPrice`, `csvprovider.go:174`).
- Hours per month are fixed at 730 (`upstream/opencost/core/pkg/util/timeutil/timeutil.go:33`).

**Landledger.** *Takes* the unit set (per core-hour, per GiB-hour, per GiB-month of storage, per GB of egress), the idea
that one internal blended rate replaces cloud prices on premises, and 730 hours as the month for converting a GB-month
price to an hourly one (stated on the rate card so finance can check it). *Changes* everything about how prices are
kept: rates are exact decimals, the rate card is versioned and effective-dated, a version is a request that someone
approves, and every cost record carries `x_RateCardVersion`, so repricing a past day is a deliberate rebuild of an open
period, never a side effect of editing a file. *Rejects* matching prices to nodes (one blended rate, `docs/plan.md`
decision 3) and spot prices.

## 7. The allocation API

- `GET /allocation/compute` (`pkg/costmodel/router.go:615`) with `window` (required: `today`, `7d`, `lastmonth`, or
  `start,end` in RFC 3339 or Unix seconds), `aggregate` (comma list, `label:<name>` allowed), `step`, `accumulate` /
  `accumulateBy` (`all`, `hour`, `day`, `week`, `month`, `quarter`, `none`), `includeIdle`, `idleByNode`, `shareIdle`,
  `sharelb`, `filter`, `includeProportionalAssetResourceCosts`, `includeAggregatedMetadata`
  (`pkg/costmodel/aggregation.go:332`-`:411`). `GET /allocation/compute/summary` answers the same with a lighter
  `SummaryAllocation` (`router.go:616`).
- The response is a list of sets, one per step, each a map from the aggregate key to an allocation with its properties,
  window, resource-hours, every cost component and efficiencies (`core/pkg/opencost/allocation_json.go`).

**Landledger.** *Takes* the query shape for `GET /api/costs`: a window, a list of `aggregate` dimensions, a filter, an
idle mode (`separate` or `weighted`) and an accumulation (`day`, `week`, `month`). *Changes* the response: every total is
split into its estimated and invoiced parts, carries the currency once, and names the rate-card version and rule
versions it used; money is a decimal string, never a JSON number.

## 8. Aggregation and properties

- Properties: `cluster`, `node`, `container`, `controller`, `controllerKind`, `namespace`, `pod`, `providerID`,
  `service`, `label`, `annotation`, `namespaceLabel`, `deployment`, `statefulset`, `daemonset`, `job`, and the
  label-mapped `department`, `environment`, `owner`, `product`, `team`
  (`core/pkg/opencost/allocationprops.go:76`-`:97`). The last five come from configurable label names (`LabelConfig`).
- An aggregate key is the values of the requested properties joined with `/`; an allocation without the property lands
  in `__unallocated__` (`allocation.go:2642`).

**Landledger.** *Takes* the aggregation-after-allocation order and the `__unallocated__` bucket (Landledger's
*Unallocated* row, which the close checklist watches). *Changes* where team, product and cost center come from: not
from labels on pods (most land workloads have none) but from Landledger's allocation rules, which can select on a
namespace, a workload, a label, a Landflow workflow or agent, or an AI provider (`specs/003-allocation`). Labels the
rollup returns are kept as `Tags` so a rule can use them.

## 9. Numbers

- Every quantity and cost in `Allocation` is a `float64` (`core/pkg/opencost/allocation.go:55`-`:112`); external custom
  costs are `float32` (`upstream/opencost/pkg/customcost/types.go:70`). NaNs are swept to zero before JSON
  (`pkg/costmodel/allocation.go:208`).
- Currency conversion fetches live rates and caches them for 24 hours (`upstream/opencost/pkg/currency/converter.go:23`);
  there is no rate by date.

**Landledger.** *Rejects* both. Money is exact (integer micro-units with an ISO 4217 code), rates are decimals, and FX
is a dated, append-only table (`specs/001-money-and-records`). A record's amount is computed once from its quantity and
its rate with one stated rounding rule, so the same inputs give the same cents in Landledger, in Excel and in a test.

## 10. AI inference cost

- `pkg/inferencecost` prices **self-hosted** models (vLLM) from the cluster side: the allocation cost of the model's
  pods, aggregated by a model label, divided by vLLM's token counters into cost per million tokens
  (`upstream/opencost/pkg/inferencecost/calculator.go:22`-`:76`).
- It keeps two bases side by side: `usage` (actual usage × price, does not reconcile to the bill) and `allocation`
  (max(request, usage) × price plus idle and shared infrastructure, reconciles) (`pkg/inferencecost/types.go:11`,
  `:15`). Without timing data it splits input and output cost with a fixed 2.5× output multiplier
  (`types.go:154`, `calculator.go:127`).

**Landledger.** Today's AI spend is hosted APIs (Anthropic, OpenAI) priced per token, which OpenCost doesn't cover;
Landledger prices it from Landflow's per-call usage (`docs/research/focus.md` §5). *Takes* the two-bases idea for later:
if the family ever serves a model on its own GPUs, its cost per token should show both the usage basis and the fully
loaded basis, labelled, rather than one number.

## 11. What OpenCost doesn't do

- **No invoice reconciliation.** Allocations carry `*CostAdjustment` fields and a `Reconcile` option
  (`core/pkg/opencost/allocation.go:1540`-`:1541`), but nothing in the open code computes an adjustment from a bill:
  the only writes are resets, sums and decoding (`allocation.go:1146`, `:1451`;
  `core/pkg/opencost/opencost_codecs.go:772`). Cloud bills are ingested separately (`/cloudCost`, `router.go:647`) and
  are not matched to allocations.
- **No history of prices or rules.** Prices are current config; changing them reprices the past (§6).
- **No periods, no locking, no corrections, no audit.** Every query recomputes from metrics; a month's figure can change
  whenever Prometheus data or config changes.
- **No owners, budgets or approvals.** Team and owner are label values.
- **No labels for estimated against invoiced.** All cost is computed.

These are exactly the parts Landledger adds: it is a subledger, and OpenCost is a calculator.

## 12. What Landledger takes, in one table

| OpenCost | Landledger | Why |
|---|---|---|
| Resource-hours × unit price, per resource | Same, from the rollup and the rate card | The model is sound and familiar to engineers |
| max(request, usage), integrated per sample | Same, but integrated in Clickland; the rollup returns requested, used and allocated | A daily max of totals undercounts (40% in the probe) |
| Idle = asset − allocated, per resource | Same, with capacity = allocatable × rate | Totals must reconcile to the cluster's cost |
| Idle shared weighted by default in the UI | Idle is the *Shared pool* row; weighted split is an opt-in rule | A team's number must not hide others' idle |
| Shared namespaces / labels / overhead, weighted or even | Allocation rules, versioned, plus fixed ratios | Finance owns and approves the split |
| `__filtered__` bin | Same | Filtered views keep their shares |
| Custom price JSON/CSV, no history | Rate card versions, effective-dated, approved | Past months must not move |
| Classified egress priced, total transfer unpriced | Network is a quantity; priced only where the rollup marks egress | Clickland can't classify traffic today (§2 of focus.md and spec 002) |
| PV priced by requested size × time | Same, once Clickland reports claim capacity | No volume metrics in Clickland yet (probe §2) |
| `float64` money, live FX | Exact money, dated FX | A ledger has to add up |
| No reconciliation, no periods | Invoices, reconciliation, periods, corrections | That is the product |

## Open questions

- **Storage.** Clickland stores no `k8s.volume.*` metrics (probe §2): its kubelet receiver collects the `node`, `pod`
  and `container` groups only (`clickland/deploy/k8s/cluster-metrics/cluster-metrics.yaml:74`). Turning on the
  `volume` group would report each claim's capacity (`k8s.volume.capacity`) [docs]. Until then storage cost is empty
  for Kubernetes and the rate card's GB-month line prices nothing.
- **Network.** No `k8s.pod.network.io` is stored either (probe §2); Docker's `container.network.io.usage.tx_bytes` is.
  Neither says which bytes left the machine. Whether to price total transmitted bytes at the egress rate (an upper
  bound) or leave network unpriced is finance's call; spec 002 defaults to unpriced quantity.
- **Docker containers outside Kubernetes** have usage but no request and no allocatable, so they have no idle and are
  priced on usage alone. Whether the Docker host's capacity should be priced (as a second "cluster") is open.
- OpenCost's `idleByNode` matters with many nodes; OrbStack has one. Landledger keys idle by cluster and keeps the node
  in the record so a per-node split is possible later.
