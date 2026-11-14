# Feature 006: Forecasts (wave 3, "Plan and reconcile")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · **Contract**:
`libs/contracts/src/spend.ts` (`Overview.forecast`), `libs/contracts/src/wave3.ts` (`ForecastView`)

## Why

Finance's promise for wave 3 is a forecast on calendar day 10 that holds within ±10%. Wave 1's forecast is a run rate
with a min–max range and refuses to guess early. It needs a range that means something (how spread the days are),
the spend people already approved for later months, and a year's view.

## User stories

1. **As the CFO**, Overview's forecast carries P10, P50 and P90, from how much the days vary, once there are enough
   days; before then it still says *Not enough data yet*.
2. **As a controller**, spend approved for months beyond what a request reserved (an open-ended request's fourth
   month on) counts in the forecast and in *at risk*.
3. **As FP&A**, I see the year ahead: each month's run rate with its range, what is committed, the budget, and the
   annualised figures.
4. **As a budget owner**, a month with no budget says *no budget*, never *on track*, and a request landing in a month
   with no budget for its cost center goes to Finance, and the Request page says why.

## Acceptance

- **Driver-based**: per source (Landflow AI calls, Clickland resource usage), the run rate is cost per observed hour
  over the last seven days; the forecast lists each source's driver (its consumed quantity per day and unit) and cost
  per day.
- **The band**: with at least three full observed days of every source, P50 = month to date + the run rate × the
  hours left; the half-width is z₀.₉ × σ × √(days left), with σ² the sum of each source's sample variance of its full
  days' cost and z₀.₉ = 1.2816; P10 = max(month to date, P50 − half-width), P90 = P50 + half-width. Exact decimals
  (an integer square root, no floats). Property: P10 ≤ P50 ≤ P90, and P10 ≥ month to date.
- **Committed**: an approved or applied monthly request active in a month for which it holds no reservation adds its
  amount for the month's remaining days (the whole month for a later month) to that cost center's forecast and to the
  total, and its state is judged with it. The forecast says how much is committed and by which requests.
- **The year ahead** (`GET /api/forecast?months=12`): per month from this one, the run rate (P10/P50/P90 for its
  days), committed (reservations still held, plus commitments beyond them), the budget (or *no budget*), the state;
  totals; the run rate annualised (× 365 days) and the commitments annualised.
- **No budget** (a decision, to confirm): the state is `none` (*No budget*). A request whose month (or first full
  month) has no budget for its cost center is never automatic and takes the policy's Finance step
  (`costCenterAtRisk` holds), with the reason in its path and on the Request page.
- **Console**: Overview's forecast tile shows P10–P90 and what is committed; the burn chart's band; a card with the
  year ahead.

## Out of scope

Seasonality and a stored daily forecast history (to measure the day-10 accuracy; wave 4 when months close); drivers
from Datarails.
