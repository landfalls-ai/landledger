# Feature 002: Ingest and pricing (wave 1)

**Status**: specified 2026-11-14 (wave 0) · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md)

## Why

Finance's first question, "what did AI and the cluster cost yesterday, and whose was it", needs the usage of two
siblings turned into priced cost records every day: Landflow's AI calls (which exist today) and Clickland's cluster
usage (whose rollup route Clickland's session is building now: its draft contract is designed against here, and
the figures Landledger needs beyond it are asked for in the plan). Ingest has to be safe to repeat, honest about late data, and never
change a locked month.

Research: [docs/research.md](../../docs/research.md) D1, D2, D5, D9–D13, D15; [OpenCost](../../docs/research/opencost.md)
§2–§4, §6, §10; [FOCUS](../../docs/research/focus.md) §3, §5, §6.

## User stories

1. **As a finance analyst**, I open Landledger in the morning and see yesterday's AI cost per provider, model,
   workflow, agent and person, priced from the rate card, and the cluster's cost per namespace and workload with the
   idle capacity on its own line.
2. **As a budget owner**, I see today's figure so far, marked *provisional*, updated within the hour.
3. **As the finance lead**, I know which rate card version priced each figure, and a price change I approve today
   does not move last month.
4. **As an operator**, I rerun yesterday's ingest after a fix and nothing doubles; if a figure changed, the record shows
   a reversal and a re-entry, not an edit.
5. **As the controller**, late data for a locked month appears in the open month as a correction dated to the day it
   belongs to.
6. **As an operator**, I backfill the months before Landledger existed from what the sources still keep, and the page
   says where the detail is coarser.
7. **As a finance analyst**, I see Landledger's AI estimate beside Landflow's own, and the difference.

## Acceptance

- **Landflow AI.** An ingest run for a UTC day reads every `ai.call` event of that day from Landflow's
  `GET /api/usage/events` (an owner or admin key), prices each call with the rate card version effective that day
  (input, cache read, cache write, output; the long-context tier when the prompt exceeds it), and appends one
  `estimated` record per day × provider × model × workflow × agent × actor × meter × price line. Records carry Landflow's
  own estimate for the same calls in `x_SourceCost`.
- A check against `GET /api/usage?groupBy=model&kinds=ai.call` (tokens and calls per model for the day) fails the run
  when the events read don't add up, so a truncated read can't pass silently.
- Until Landflow puts cache tokens on `ai.call` events, a per-model `Adjustment` record from
  `GET /api/insights/ai-usage?from=<day>&to=<day>` corrects the day's cache pricing, labelled as such.
- **Clickland.** An ingest run for a UTC day calls `POST /api/usage/rollup` and appends, per cluster and resource
  (CPU, memory), one record per workload container for its allocated quantity and one **idle** record for capacity −
  Σ allocated, in FOCUS's split-cost columns; they add up exactly to the node's allocatable × rate. Docker containers
  are priced on usage with no idle. Network bytes are recorded as quantity with no price; storage when the rollup has
  claim capacity.
- **Prices.** Rate card versions are effective-dated, exact decimals, created as a proposal and active once a person
  approves them; rate card v1 holds `docs/plan.md` decision 3's cluster rates and AI list prices imported from
  Landflow's `GET /api/settings/ai-prices`. Every record names its version. A model with no price line is priced at
  Landflow's own estimate for those calls, labelled so (`SkuPriceId` ending `:landflow-estimate`, `PricingCategory`
  `Other`), with a warning asking for a rate line; never a zero that looks like a price.
- **Idempotent.** Every record has an `x_SourceKey`; rerunning a day writes nothing when no figure changed, and a
  reversal plus a re-entry for each key whose figure changed. Two runs for the same source never overlap.
- **Provisional today.** The current UTC day is ingested hourly into `provisional_usage`, replaced on each run and
  never summed with cost records; a day is appended to `cost_records` once both sources report it complete.
- **Late data.** Re-ingesting a day of an open month corrects it in place (reversal + re-entry, `ChargeClass` null); of
  a locked month, in the open month with `ChargeClass = Correction`. A nightly job re-ingests the last 7 days.
- **Backfill.** `landledger ingest backfill --from --to` fills past days: AI from events for the last 90 days, and
  per day × model from `/api/insights/ai-usage` before that (no workflow, agent or actor), marked
  `x_SourceKey` `landflow:insights:…`; the cluster from the rollup as far back as Clickland keeps metrics.
- **Runs are visible.** `ingest_runs` records each run's source, window, counts, warnings and outcome; the console's
  status shows the last run per source and its warnings.
- All of it runs against fakes of Landflow and Clickland in tests, and against the live siblings on this machine.

## Out of scope

Invoices and reconciliation (wave 3); allocation to cost centers (spec 003); pricing network egress (until finance
decides what counts as egress); storage until Clickland reports claim capacity; GPUs; a cloud provider's bill
(wave 5); pushing cost metrics to Clickland (wave 1, a separate task once records exist).
