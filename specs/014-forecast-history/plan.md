# Plan: Forecast history (spec 014)

- `apps/api/src/forecast-history.ts` (`ForecastHistory.record`, `day10`, `view`); a loop in `startBackgroundJobs`;
  route in `wave4-routes.ts`.

The contract is `libs/contracts/src/wave4.ts` (pushed first, then changed only additively); the routes are in
[docs/reference/api.md](../../docs/reference/api.md#wave-4-month-end-specs-012019).
