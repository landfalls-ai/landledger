# Ingest

How usage becomes cost records (spec 002): Landflow's AI calls and Clickland's cluster and Docker usage, priced by
the approved rate card, one UTC day at a time. Code: `apps/api/src/ingest/` (`sources.ts` the clients, `build.ts` the
pure builders, `runner.ts` the runs), `libs/pricing` (rate lookup, `priceAiCall`, `priceCluster`).

## Sources

| Source | Read with | What it gives |
|---|---|---|
| Landflow | `GET /api/usage/events?kinds=ai.call` one hour at a time (`to` = the hour's end − 1 ms), a window that comes back full (5,000) split in two down to one second, deduplicated by id; `GET /api/usage?groupBy=model` to check the count; `GET /api/insights/ai-usage` for the cache adjustment; the workflow and agent lists for names | each AI call: provider, model, input, output, cache read and cache write tokens (from Landflow's ledger-cache change), Landflow's own cost, workflow, agent, actor |
| Clickland | `POST /api/usage/rollup` for the day | per container: allocated CPU and memory (per-sample max of request and usage), node capacity per cluster, Docker usage, network bytes, volume claims |

Keys: `LANDLEDGER_LANDFLOW_URL`/`_KEY` and `LANDLEDGER_CLICKLAND_URL`/`_KEY`, read from the untracked
`apps/api/.env.local` ([reference/env.md](reference/env.md)). A source with no URL is skipped.

## A day, step by step

1. A run inserts an `ingest_runs` row (source, kind `hourly`, `daily`, `backfill` or `manual`, day, rate card version)
   and opens an OpenTelemetry span `ingest <source>`. Runs of one source are queued, never parallel.
2. The builder turns the day's usage into FOCUS records priced with the rate card version in effect that day.
3. **Today** (or any day not yet complete) replaces that day's rows in `provisional_usage`. **A complete day** is
   reconciled with the ledger under an advisory lock per source and day: each record's `x_SourceKey` is compared by
   fingerprint with the live entry; new keys are appended, equal ones skipped, changed ones corrected (reversal and
   re-entry, [money.md](money.md)), and keys that vanished are reversed. An entry for a locked month is booked in the
   open month as `ChargeClass = Correction`. The day's provisional rows are then deleted.

   **An empty answer is not a day with no usage.** When the source returns nothing for a complete day the ledger has
   live entries for, the run fails (`… answered with nothing for <day>, but the ledger has N live entries`) and the
   day stands: an outage, an expired key or a wiped source look the same as a quiet day. A person who knows the day
   really is empty re-runs it with `force` and a reason (`POST /api/ingest/run { force: true, reason }`, or
   `ingest run --force --reason "…"`); the reversal is audited as `ingest.forced` and the run's params keep the reason.
4. The run is finished with counts (read, new, corrected, unchanged), warnings, the error if any, and the window the
   source covered; an `ingest` log line goes to Clickland with the trace id. Records entered are allocated at once
   ([allocation.md](allocation.md)).

**Complete** means the UTC day ended at least 15 minutes ago for Landflow (events are final when written) and 2 hours
ago for Clickland. Running a day twice writes nothing the second time.

## Jobs and the CLI

The API runs `tick` every hour (the first 20 s after start; `LANDLEDGER_INGEST=off` stops it): today's provisional
figures for each source, and each of the last 7 days that no run entered into the ledger in the last 20 hours (late
data and corrections are picked up about once a day). Approving a rate card version re-reads **every** day from its
effective date to today for each source with data then (`Ingest.reprice`, kind `backfill`, the reason in the run's
params), so a retroactive price reaches days older than the hourly job's seven; the approval answers with
`repriced: { runs, failed, corrected, added }`. An effective date in a closing or locked month is refused, so every day
repriced is in an open month. By hand:

```bash
pnpm --filter @landledger/api ingest run [--source landflow|clickland] [--day YYYY-MM-DD] [--force --reason "…"]
pnpm --filter @landledger/api ingest backfill --source landflow --from 2026-10-31
pnpm --filter @landledger/api ingest tick
pnpm --filter @landledger/api ingest allocate [--month 2026-11]
pnpm --filter @landledger/api ingest metrics                               # cost metrics to Clickland once
```

`POST /api/ingest/run` does a run over HTTP (scope `ingest`); `GET /api/ingest/runs` lists them.

## AI calls

Each call is priced on its own (the long-context tier prices a whole request), then summed per day × provider × model
× workflow × agent × actor × meter × price line and rounded half-even once per row. Key:
`landflow:<day>:<provider>:<model>:<workflow|->:<agent|->:<actor|->:<meter>:<priceLine>`. Landflow's own estimate
for the calls is kept in `x_SourceCost` on the group's first row, so the two prices can be compared.

**Cache tokens.** Since Landflow's ledger-cache change (branch `backbone/ledger-cache`, b1a6883c), each `ai.call`
event's attributes carry integer `cacheRead` and `cacheWrite`, which are **parts of** `input`. A call is priced in
three input buckets: uncached input = `input − cacheRead − cacheWrite` at the input price, `cacheRead` at the
cache-read price, `cacheWrite` at the cache-write price; output at the output price. (Landflow's `cost` on the event
already prices cache at the cache prices.) **Older events have no such keys**: a missing key means *unknown*, not 0.
For a model with any such event that day, all its input is priced at the input price and one `Adjustment` record per
model and meter moves the cache tokens Landflow's insights report for the day, less the tokens already known from
events that carried them, from the input price to the cache price (key `landflow:insights:<day>:<provider>:<model>:<meter>`,
no workflow, a warning on the run). A day whose events all carry the keys gets no adjustment.

**Unpriced calls.** A model with no rate line, or a day before any approved rate card, is priced at Landflow's
estimate, labelled `:landflow-estimate` (PricingCategory Other) with a warning; never a zero that looks like a price.
Local models (Ollama) cost 0 on their own line: their hardware is in the cluster's figures.

## Cluster and Docker

- **Kubernetes**, per workload container: CPU core-hours and memory GiB-hours *allocated* (the max of request and
  usage per sample), at the rate card's prices. Per cluster and resource, **idle** = capacity × rate − Σ allocated
  cost, as its own record (`clickland:<day>:<cluster>:idle:<resource>`, tag `idle=true`, service *Cluster idle*,
  unit price empty because the quantity is a remainder). A negative idle is kept as is, with a warning.
- **Docker** containers have no requests: priced on usage. Their namespace is `compose:<project>`. On this machine the
  Docker engine and OrbStack's Kubernetes node are one VM, so the node's capacity already includes what Docker uses:
  with `LANDLEDGER_DOCKER_SHARES_CLUSTER` (default `orbstack`) Docker's usage is taken out of that node's idle, Docker
  keeping its own rows, and the day adds up to capacity × rate once (idle method version 2). `none` for a Docker host
  of its own: then Docker is priced on top, with no idle.
- **Storage**: GB-months for volume claims of their own size. A claim on the node's own filesystem (local-path)
  reports the node disk's size, not its own: Clickland flags it, and a claim of the same cluster within 1% of a flagged
  claim's size is taken as the node disk too. Such a claim is priced at its requested size when the rollup gives it
  (`requestedGiBHours`); otherwise it is kept as a quantity only (zero cost, `PricingCategory` *Other*,
  `SkuPriceDetails.Applied = false`, method `LandledgerClaimOnNodeDisk`) with a coverage warning, so the disk is never
  priced once per claim.
- **Network**: bytes as zero-cost rows (quantity only) until finance decides how egress is priced
  ([research.md](research.md) §7).

Keys: `clickland:<day>:<cluster>:<namespace>/<kind>/<workload>/<container>:<resource>`.

## Telemetry

Runs, logs and spans reach Clickland as service `landledger-api` (pino is loaded through `require` so the
instrumentation patches it). The cost figures go back as metrics: [spend.md](spend.md#cost-metrics-in-clickland).

## Where this differs from spec 002

- `x_SourceCost` sits on the first row of each call group, not spread over its meters.
- Before the rate card's effective date the calls are priced at Landflow's estimate (labelled), not refused.
- Network rows carry quantity only; `agent.session` events are not ingested (they hold no cost).
- Backfill reads events day by day; the insights-only backfill for days older than Landflow's 90 days of events is not
  built (this machine has no such days).
- Fixtures are built in the tests rather than recorded from this machine (T002).

## Open

- Clickland adds workload owners and pod labels: until then a Deployment's name is derived from its pod name and label
  rules match nothing.
- The insights-only backfill, network pricing, a Docker host's own capacity (when it is not the cluster's node).
- Clickland does not report a claim's requested size yet, so claims on the node disk are quantity-only.
