# Tasks 002: Ingest and pricing

Ordered; each task ends with its tests passing. Depends on spec 001's T001–T011.

- [ ] T001 Ask Clickland's session for the rollup additions in [plan.md](plan.md) (*The rollup Landledger asks for*),
      and Landflow's for cache-read and cache-write tokens on `ai.call` attributes; record the answers in
      `docs/research.md` §7.
- [ ] T002 Record fixtures on this machine: a day of Landflow `ai.call` events, the grouped report and insights for it,
      the price table; a day of Clickland's draft rollup. Scrub ids that aren't needed; commit under
      `apps/api/test/fixtures/`.
- [ ] T003 `libs/contracts` source schemas (Landflow events, grouped report, insights, prices; Clickland rollup with the
      asked-for fields optional) that parse quantities into `Decimal` from text; tests against the fixtures.
- [ ] T004 Migrations: `rate_cards`, `rate_card_versions` (effective from, proposed by, approved by, hours per month),
      `rate_lines`; database tests (a version is immutable once approved; effective ranges don't overlap).
- [ ] T005 `libs/pricing` rate lookup by date, provider and model (exact, then longest prefix); tests including dated
      model ids and a local provider at zero.
- [ ] T006 `priceAiCall`: plain input, cache read, cache write, output, long-context tier over the threshold; tests
      against Landflow's `estimateCost` cases, exact to the micro-unit.
- [ ] T007 `priceCluster`: per resource, allocated rows + idle row by `split`; negative idle kept with a warning; Docker
      rows on usage with no idle; tests that rows sum exactly to capacity × rate.
- [ ] T008 Rate card v1 script: cluster lines from decision 3, AI lines from `GET /api/settings/ai-prices`, as a
      proposal; `POST /api/rate-cards/versions/:id/approve` by a person only; route tests.
- [ ] T009 Migrations `ingest_runs` and `provisional_usage`; the per-source advisory lock; database tests that two runs
      can't overlap.
- [ ] T010 Landflow client: hourly windows with `to = end − 1 ms`, the split at 5,000, dedupe by id, the per-model
      check; tests with `fake-landflow`, including a window of exactly 5,000 events and a mismatch that fails the run.
- [ ] T011 AI ingest for a day: price, sum, source keys, compare with existing, append; tests for a first run, a
      repeat with no change (no rows), a changed figure (reversal + re-entry) and a locked month (correction in the
      open month).
- [ ] T012 Cache adjustment from insights per model and day; tests that input + adjustment equals Landflow's
      `ai_usage` pricing for the fixture day.
- [ ] T013 Clickland client and cluster ingest for a day with `fake-clickland`: allocated rows, idle rows in the
      split-cost columns, the fallback on the draft shape (used only, a warning); tests.
- [ ] T014 Completeness and the jobs: hourly provisional runs for today, the daily run for complete days, the nightly
      7-day re-ingest; tests with a fake clock.
- [ ] T015 Backfill CLI: events for the last 90 days, insights before that, the rollup as far as it goes; tests that a
      backfilled day later re-ingested from events is corrected, not doubled.
- [ ] T016 `GET /api/ingest/runs` and `GET /api/rate-cards`; route tests.
- [ ] T017 Live check on this machine against the running Landflow and Clickland: yesterday's AI and cluster records,
      a rerun that writes nothing, the console status; screenshots.
- [ ] T018 Docs: `docs/ingest.md` (sources, keys, completeness, late data, backfill limits), `docs/rate-cards.md`,
      `docs/reference/` (routes, `LANDLEDGER_LANDFLOW_*` and `LANDLEDGER_CLICKLAND_*` variables), limitations
      (network unpriced, storage, cache adjustment), history.
