# Tasks 002: Ingest and pricing

Ordered; each task ends with its tests passing. Depends on spec 001's T001–T011.

- [x] T001 Ask Clickland's session for the rollup additions in [plan.md](plan.md) (*The rollup Landledger asks for*),
      and Landflow's for cache-read and cache-write tokens on `ai.call` attributes; record the answers in
      `docs/research.md` §7.
      *Done:* Clickland built the rollup with allocated, capacity and claims; Landflow added `cacheRead` and `cacheWrite` to `ai.call` (b1a6883c, branch `backbone/ledger-cache`). Ingest takes events from before and after it: see *Cache tokens* in [plan.md](plan.md).
- [ ] T002 Record fixtures on this machine: a day of Landflow `ai.call` events, the grouped report and insights for it,
      the price table; a day of Clickland's draft rollup. Scrub ids that aren't needed; commit under
      `apps/api/test/fixtures/`.
      *Open:* the tests build their fixtures in code (`apps/api/test/ingest.test.ts`, `wave1.integration.test.ts`) rather than from recordings.
- [x] T003 `libs/contracts` source schemas (Landflow events, grouped report, insights, prices; Clickland rollup with the
      asked-for fields optional) that parse quantities into `Decimal` from text; tests against the fixtures.
- [x] T004 Migrations: `rate_cards`, `rate_card_versions` (effective from, proposed by, approved by, hours per month),
      `rate_lines`; database tests (a version is immutable once approved; effective ranges don't overlap).
- [x] T005 `libs/pricing` rate lookup by date, provider and model (exact, then longest prefix); tests including dated
      model ids and a local provider at zero.
- [x] T006 `priceAiCall`: plain input, cache read, cache write, output, long-context tier over the threshold; tests
      against Landflow's `estimateCost` cases, exact to the micro-unit.
- [x] T007 `priceCluster`: per resource, allocated rows + idle row by `split`; negative idle kept with a warning; Docker
      rows on usage with no idle; tests that rows sum exactly to capacity × rate.
- [x] T008 Rate card v1 script: cluster lines from decision 3, AI lines from `GET /api/settings/ai-prices`, as a
      proposal; `POST /api/rate-cards/versions/:id/approve` by a person only; route tests.
- [x] T009 Migrations `ingest_runs` and `provisional_usage`; the per-source advisory lock; database tests that two runs
      can't overlap.
- [x] T010 Landflow client: hourly windows with `to = end − 1 ms`, the split at 5,000, dedupe by id, the per-model
      check; tests with `fake-landflow`, including a window of exactly 5,000 events and a mismatch that fails the run.
- [x] T011 AI ingest for a day: price, sum, source keys, compare with existing, append; tests for a first run, a
      repeat with no change (no rows), a changed figure (reversal + re-entry) and a locked month (correction in the
      open month).
- [x] T012 Cache adjustment from insights per model and day, for events without `cacheRead`/`cacheWrite` only (a missing key is unknown, not 0; events with the keys are priced in three input buckets); tests that input + adjustment equals Landflow's
      `ai_usage` pricing for the fixture day.
      *Done, for older events only:* the adjustment is written only for models with events that lack the cache keys that day, as insights − tokens known from events.
- [x] T013 Clickland client and cluster ingest for a day with `fake-clickland`: allocated rows, idle rows in the
      split-cost columns, the fallback on the draft shape (used only, a warning); tests.
- [x] T014 Completeness and the jobs: hourly provisional runs for today, the daily run for complete days, the nightly
      7-day re-ingest; tests with a fake clock.
- [ ] T015 Backfill CLI: events for the last 90 days, insights before that, the rollup as far as it goes; tests that a
      backfilled day later re-ingested from events is corrected, not doubled.
      *Partly:* `ingest backfill --source --from` runs every day from events (with the reconcile, so a re-run corrects rather than doubles); the insights-only backfill before Landflow's 90 days is open.
- [x] T016 `GET /api/ingest/runs` and `GET /api/rate-cards`; route tests.
- [x] T017 Live check on this machine against the running Landflow and Clickland: yesterday's AI and cluster records,
      a rerun that writes nothing, the console status; screenshots.
      *Done 2026-11-14:* Landflow backfilled from 2026-10-31, a rerun unchanged; Clickland today provisional (175 records); screenshots in `study/wave1-screens/`.
- [x] T018 Docs: `docs/ingest.md` (sources, keys, completeness, late data, backfill limits), `docs/rate-cards.md`,
      `docs/reference/` (routes, `LANDLEDGER_LANDFLOW_*` and `LANDLEDGER_CLICKLAND_*` variables), limitations
      (network unpriced, storage, cache adjustment), history.

## Review of wave 1 (14 Nov 2026)

- [x] R001 Docker on the shared node comes out of idle (idle method v2); a day totals capacity × rate; tests.
- [x] R002 Node-disk claims not priced at the node's size (quantity only until Clickland reports requested size); tests.
- [x] R003 An empty source answer never reverses a day unless forced with an audited reason; tests.
- [x] R004 Four eyes on rate cards: proposers are users, lines record `added_by`, authors don't approve (0005); AI
      lines by a signed-in person only; tests.
- [x] R005 An approved rate card reprices every open-month day from `effective_from`; refused in a locked month; tests.
- [x] R006 The forecast on Σcost ÷ Σobserved hours per source, "Not enough data yet" under 3 full days, data since;
      tests with partial days and the 00–02 UTC window.
- [x] R007 Live re-ingest and screenshots at 390 and 1440 px (`study/wave1-screens/`).
