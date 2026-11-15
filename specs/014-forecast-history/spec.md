# Feature 014: Forecast history (wave 4, "Month-end")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · **Page**:
[docs/spend.md](../../docs/spend.md)

## Why

The measure is a calendar-day-10 forecast within ±10%. That needs the forecast as it stood on day 10, kept, not
recomputed at close; and variance notes must cite one forecast, not whatever the run rate says on the day the note is
written.

## User stories

1. **As FP&A**, I see each day's P10/P50/P90 per cost center for the month, and at close day 10's P50 against the
   actual.
2. **As the variance agent**, I cite the day-10 forecast from the snapshot, the same figure everyone else sees.

## Acceptance

- Once a day (the hourly job, first run of a UTC day), `forecast_history` stores per cost center and `TOTAL` the
  P10/P50/P90 to month-end (Overview's forecast, commitments netted against the run rate) and the actual to date, or
  `insufficient`; append only, one row per day and cost center.
- Per cost center P10/P90 apportion the total band by the cost center's projected remainder; P10 ≤ P50 ≤ P90.
- `GET /api/forecast/history?month=&costCenter=`: the days, day 10 (or the last stored before it) and its accuracy
  against the snapshot's actual.

## Out of scope

Backfilling forecasts for days before this wave (they would be recomputed, not kept).
