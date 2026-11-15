# Tasks 006: Forecasts

- [x] T001 `Decimal.sqrt`; the band (pure) with property tests (P10 ≤ P50 ≤ P90, P10 ≥ month to date).
- [x] T002 Drivers per source; Overview's forecast with P10/P50/P90; *Not enough data yet* kept.
- [x] T003 Committed spend beyond reservations in the forecast and the state; tests.
- [x] T004 `GET /api/forecast` (the year ahead, annualised); tests.
- [x] T005 No budget → Finance step, never automatic, with the reason; tests; Decision 8 in `docs/plan.md`.
- [x] T006 Console: the forecast tile, the band, the year ahead.
- [x] T007 Docs: `docs/spend.md`, references, plan and history.

## Review of wave 3

- [x] R001 Should-fix 1: reservations and commitments net of what the run rate already projects; one formula for
  Overview and the year ahead.
- [x] R002 Should-fix 2: a contracted line (annual value ÷ 12 over the term, pro rata by day).
- [x] R003 Should-fix 3: a cost center's state reads reservations when there is no run rate.
- [x] R004 Nit: annualised over the next 12 months, commitments bounded by their end dates.
- [x] R005 Tests: netting, contracted, the cost center state, Overview = the year ahead's current month.
