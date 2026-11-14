# Plan 006: Forecasts

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-15

## Technical context

| Project | What it gains |
|---|---|
| `libs/money` | `Decimal.sqrt(scale)`: an exact integer square root, rounded down |
| `libs/contracts` | `Overview.forecast`: `p10`, `p50`, `p90`, `committed`, `commitments`, `drivers`, `band`; `ForecastView` (the year ahead) |
| `apps/api` | `forecast.ts` (the band, committed spend, the year ahead), `spend.ts` (Overview uses them), `requests.ts` (no budget → Finance) |
| `apps/console` | Overview's forecast tile and a "Year ahead" card |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| 1. Agents request; people decide | PASS | Nothing decides; a request without a budget goes to a person in Finance. |
| 2. Estimated or invoiced | PASS | A forecast is labelled a forecast; commitments are approved amounts, labelled. |
| 3. Money is exact | PASS | Variance and its square root in `Decimal`; the band's property is tested. |
| 4. Nothing is edited | N/A | Nothing is stored. |
| 5–7 | PASS | No outbound call; local; this spec. |

## Design

- `bandOf(sources, hoursLeft, mtd)`: each source's full days' daily cost (its per-hour rate that day × 24); sample
  variance per source (n − 1), summed; σ = √Σ; days left = hours left ÷ 24; half-width = 1.2816 × σ × √days.
- Committed spend for month M: approved or applied monthly requests with `start ≤ end of M` and `end ≥ start of M` (or
  open-ended) and no reservation row for M; `addsInMonth(r, M)`, × the share of the month still ahead for the current
  month.
- The year ahead reads reservations (remaining) and commitments per month, and budgets per month.
- `pathFor`: `noBudget` (`stateNow` or the first full month's state is `none`) blocks automatic approval and makes
  `costCenterAtRisk` hold, with its own reason.
