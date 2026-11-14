# Plan 002: Ingest and pricing

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-14

## Technical context

| Project | What it gains |
|---|---|
| `libs/contracts` | `ingest.ts`: an ingest run, a provisional row, a rate card version and line; `sources.ts`: the shapes Landledger reads from Landflow (`UsageEvent`, `UsageReport`, `AiUsageReport`, the price table) and from Clickland (`UsageRollupRequest`/`Response` plus the fields asked for below), each a zod schema that parses numbers into `Decimal` |
| `libs/pricing` (new, `@landledger/pricing`) | Rate card lookup by date and SKU; `priceAiCall` (input, cache read, cache write, output, long-context tier); `priceCluster` (allocated rows + idle per resource, by `split`); all on `libs/money` |
| `libs/schema` | `rate_cards`, `rate_card_versions`, `rate_lines`, `ingest_runs`, `provisional_usage` |
| `apps/api` | The `ingest` job (hourly and nightly), `landledger ingest run|backfill` CLI, the Landflow and Clickland clients, `GET /api/ingest/runs`, `GET /api/rate-cards`, `POST /api/rate-cards/:id/versions` (a proposal), `POST /api/rate-cards/versions/:id/approve` (a person) |
| `deploy/fakes` | `fake-landflow` (usage events, grouped report, insights, prices) and `fake-clickland` (the rollup), seeded from fixtures recorded on this machine |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| 1. Agents request; people decide | PASS | A rate card version is a proposal until a person approves it; the ingest key (`ingest` scope) can't approve. |
| 2. Estimated or invoiced | PASS | Every ingested record is `estimated`; `BilledCost` 0; provisional rows live in their own table and are never summed with records. |
| 3. Money is exact | PASS | Quantities parse into `Decimal` from the sources' JSON text (never `number` arithmetic); prices are decimals; amounts are `libs/money` products rounded half-even. |
| 4. Nothing is edited | PASS | Re-ingest appends reversal + re-entry; locked months get corrections in the open month (spec 001). `provisional_usage` is replaceable by design and is not a ledger. |
| 5. Nobody depends on it | PASS | Landledger pulls; Landflow and Clickland don't know it exists. If a source is down the run fails, records a warning, and the next run catches up. |
| 6. Local only | PASS | Fakes in tests; the live siblings on this machine for the check; a Landflow owner key from the local instance. |
| 7. Spec-driven | PASS | This spec; contract tests against recorded fixtures; idempotency and late-data tests. |

## Claims checked against the sources

Checked on 2026-11-14. Landflow at `landflow-clickland` `c054aa8a`; Clickland's rollup contract is **uncommitted work in
progress** in Clickland's main checkout (`clickland/libs/contracts/src/usage.ts`, read 2026-11-14), so its line numbers
will move.

| Claim | Source | Holds |
|---|---|---|
| Each AI call is an `ai.call` usage event with provider, model, operation, input and output tokens, the workflow, agent, execution and actor, and Landflow's cost estimate | `landflow-clickland/apps/web/src/lib/server/ai-usage/index.ts:174`-`:183` | yes |
| Cache-read and cache-write tokens are **not** on the event, but are parts of `inputTokens` in `ai_usage` and the insights report | `index.ts:182`; `apps/web/src/lib/shared/ai-usage.ts:9`-`:15` | yes |
| A long-context tier prices the whole request above a threshold; cache parts at cache prices; local providers (Ollama) cost nothing | `apps/web/src/lib/server/ai-usage/prices.ts:144`-`:152`, `:16`-`:29`, `:94` | yes |
| The price table is readable: defaults and the instance's overrides | `docs/reference/api.md:119` (`GET /api/settings/ai-prices`) | yes [docs] |
| Event ids are stable: `ue_<nanoid>` when written, `bf:<ai_usage id>` when backfilled | `apps/web/src/lib/server/usage/ledger.ts:150`; `usage/backfill.ts:49` | yes |
| `/api/usage/events`: same filters as `/api/usage`, newest first, `limit` at most 5,000 | `apps/web/src/app/api/usage/events/route.ts:1`, `:13`; `usage/query.ts:143`-`:147` | yes |
| `from`/`to` are both inclusive (`at >= from AND at <= to`); a date-only `to` becomes `23:59:59.999Z` | `usage/query.ts:48`-`:51`, `:100`-`:108` | yes |
| `/api/usage?groupBy=model&kinds=ai.call` gives count, tokens and cost per model | `apps/web/src/app/api/usage/route.ts:3`, `:24`-`:32`; `lib/shared/brain.ts:164`-`:183` | yes |
| An event's `day` is the instance time zone, so Landledger uses `at` | `lib/shared/brain.ts:89`-`:90` | yes |
| Raw events kept 90 days; `ai_usage` 400 days; daily rollups have no model | `landflow-clickland/docs/second-brain.md:62`-`:64` | yes [docs] |
| Members see only what they can open, so ingest needs an owner or admin key | `docs/reference/api.md:104`-`:105` | yes [docs] |
| `/api/insights/ai-usage` takes `from`/`to` and returns totals, per model and per day (not model × day) | `docs/reference/api.md:104`; `lib/shared/ai-usage.ts:54`-`:65` | yes |
| The draft rollup: `from`/`to` ISO, `granularity` `day`/`hour` (366/31 days), `groupBy` attribute keys including `k8s.deployment.name`, `source`; rows carry `cpuCoreHours`, `memoryGiBHours`, `storageGiBHours` (filesystem), `networkRxGB`/`TxGB` as JSON numbers, plus coverage | `clickland/libs/contracts/src/usage.ts:12`, `:26`-`:48`, `:54`-`:69`, `:72`-`:101` | yes (draft) |
| The draft rollup has **no request, no allocated maximum and no node capacity** | same file, `UsageRow` | yes (draft) |
| Clickland's metrics carry no workload owner and no labels; no pod network and no volume metrics yet | `study/clickland-live/probe.md` §2, §4; `clickland/deploy/k8s/cluster-metrics/cluster-metrics.yaml:74` | yes |
| Requests, usage and node allocatable are stored every ~30 s | probe §1, §3; `cluster-metrics.yaml:83` | yes |
| Σ per-sample max(request, usage) ≠ max of the sums (+40% for `landflow-dev`) | probe §5; OpenCost `pkg/costmodel/costmodel.go:773`, `metrics.go:676` | yes |
| Clickland keeps metrics 90 days by default | `clickland/libs/schema/src/index.ts:39` (`CLICKLAND_METRICS_TTL_DAYS`) | yes |
| 730 hours per month | OpenCost `core/pkg/util/timeutil/timeutil.go:33` | yes |

## The rollup Landledger asks for

Designed to `docs/architecture.md` (*Clickland: the eyes*) and the draft contract above. Landledger calls it with
`granularity: "day"`, one UTC day per call, `groupBy: ["k8s.namespace.name", "k8s.deployment.name",
"k8s.container.name", "compose.project", "compose.service"]`. To price a cluster as OpenCost does it needs, beyond the
draft (to go to Clickland's session as one request):

1. **Per row, requested and allocated beside used**: `cpuRequestedCoreHours`, `cpuAllocatedCoreHours` (Σ over samples
   of max(request, usage) × step), `memoryRequestedGiBHours`, `memoryAllocatedGiBHours`. `cpuCoreHours` and
   `memoryGiBHours` stay as *used*. Docker rows have no request: allocated = used.
2. **Capacity per cluster and node**: `capacity: [{ start, end, cluster, node, cpuAllocatableCoreHours,
   memoryAllocatableGiBHours }]` from `k8s.node.allocatable_*`.
3. **Cluster in the group** (`k8s.cluster.name`) and a **workload owner** that works for every kind
   (`k8s.workload.kind` and `k8s.workload.name`, from the collector's Kubernetes attributes processor), and the pod's
   **labels** (`groupBy: ["k8s.pod.label.team"]` or a `labels` map per row), so allocation rules can select on them.
4. **Exact quantities**: decimal strings (`"1.492300"`), or JSON numbers with at most 6 decimals, which Landledger
   parses from their text, never as floats.
5. **Storage capacity** per claim (`k8s.volume.*` once the kubelet receiver collects the `volume` group), beside the
   filesystem usage it reports now.
6. **Egress**: `networkTxGB` stays a quantity; if Clickland can tell bytes that left the machine, a separate
   `networkEgressGB`.

Until the route exists, `fake-clickland` serves this shape from fixtures, and the live check uses what the draft has
(used only, priced on usage, no idle) with a warning on every run.

## How a day is ingested

1. **Lock and record.** A run takes a Postgres advisory lock per source and inserts an `ingest_runs` row (source,
   kind `hourly`/`daily`/`backfill`, UTC day, started, the rate card version, the request parameters).
2. **Read Landflow.** For each hour `h` of the day: `GET /api/usage/events?kinds=ai.call&from=h&to=h+1h−1ms&limit=5000`.
   If 5,000 come back, split the window in two and repeat (down to one second). Deduplicate by event id across
   windows. Check the counts and tokens per model against `GET /api/usage?groupBy=model&kinds=ai.call` for the day;
   a mismatch fails the run.
3. **Price each call** with the rate card version effective on the call's UTC day: look up the line by provider and
   model (exact, then the longest prefix, as Landflow does), choose the long-context tier when input exceeds it, and
   price input (and, when the event carries them, cache read and cache write) and output separately. A model with no
   line: Landflow's own `cost`, labelled `:landflow-estimate`.
4. **Sum** per day × provider × model × workflow × agent × actor × meter × price line, keeping each call's exact
   product and rounding the sum half-even to micro-units once.
5. **Cache adjustment** (until Landflow carries cache tokens per call): for each model, `GET /api/insights/ai-usage?
   from=day&to=day` gives the day's cache-read and cache-write tokens; an `Adjustment` record per model moves those
   tokens from input price to cache prices. It has no workflow (the report has none per model and day).
6. **Read Clickland**: one rollup call for the day; rows → per workload container and resource, allocated quantity ×
   rate; capacity → per cluster and resource, allocatable × rate; idle = capacity cost − Σ allocated cost. If idle
   would be negative, record it as is with a warning (OpenCost clamps to zero, `costmodel.go:2142`-`:2156`; Landledger
   doesn't hide it).
7. **Compare with what is there.** For each `x_SourceKey`, the net of existing records for that key and basis. Equal:
   nothing. Different: reversal of the live entry and a re-entry (spec 001's `correct`). New: an entry.
8. **Append** in one transaction; mark the run finished with counts (read, new, corrected, unchanged) and warnings.

`x_SourceKey`s: `landflow:<day>:<provider>:<model>:<workflow|->:<agent|->:<actor|->:<meter>:<priceLine>`;
`landflow:insights:<day>:<model>:<meter>` (backfill and cache adjustment);
`clickland:<day>:<cluster>:<namespace>/<kind>/<workload>/<container>:<resource>`;
`clickland:<day>:<cluster>:idle:<resource>`.

## Decisions

- **A day is the unit of the ledger** (`research.md` D15). The current day goes to `provisional_usage` every hour (the
  same pipeline, written to a table that is replaced per run and day), so the console and alerts have a figure within
  the hour; it reaches `cost_records` once it is complete.
- **Complete** means: the UTC day ended at least 2 hours ago, Clickland's coverage for the day has no missing buckets
  (or the gaps are recorded as warnings) and its last sample is after the day's end; Landflow events are final when
  written, so its day is complete once it has ended plus 15 minutes.
- **Late data**: the nightly run re-ingests the last 7 days; any day can be re-ingested by hand. An open month is
  corrected in place; a locked month in the open month with `ChargeClass = Correction` (spec 001).
- **Backfill sources and limits.** AI: events for the last 90 days; before that, insights per day and model (from the
  `ai_usage` table, 400 days), with no workflow, agent or actor, keys under `landflow:insights:`. Cluster: the rollup
  as far back as Clickland keeps metrics (90 days by default; on this machine, since Clickland began collecting
  Kubernetes metrics). A backfilled day that later gets finer data is corrected by reversal + re-entry like any other.
- **Rate card v1** is a proposal created by a script: the cluster lines from `docs/plan.md` decision 3 (0.034 per
  core-hour; 0.0045 per GiB-hour; 0.10 per GB-month, stated with 730 hours; 0.02 per GB of egress, not applied while
  network is unpriced) and an AI line per Landflow price entry (input, cache read, cache write, output; the long-context
  tier as `SkuPriceDetails`), read from `GET /api/settings/ai-prices`. A person approves it.
- **The Landflow key**: an owner or admin `lf_…` key stored in `.env` (development credentials only), scoped read-only
  if Landflow allows; documented in `docs/reference/env.md`.
- **Sources' figures stay**: `x_SourceCost` keeps Landflow's per-call estimate summed, so Explore can show the
  difference between Landledger's price and Landflow's.

## Risks

- The rollup contract may land without requests or capacity. Then cluster rows are priced on usage, the idle row is
  absent, and every run warns; the spec's idle acceptance waits for Clickland.
- Landflow's grouped report and the events can disagree while events are being written for the current hour; the
  check runs only on complete days.
- A Landflow price override changes Landflow's `cost` but not Landledger's price until a new rate card version is
  approved; the difference shows in `x_SourceCost`, by design.
