# Spend: Overview, Explore, Budgets

What wave 1 shows: the month's spend with its owner, against budget, as screens, files, MCP tools and metrics in
Clickland. Code: `apps/api/src/spend.ts` (reads), `budgets.ts`, `export.ts`, `mcp.ts`, `metrics.ts`;
`apps/console/src/routes/overview.tsx`, `explore.tsx`, `budgets.tsx`, `components/spend/`. Screens follow
[ui.md](ui.md) and `ui/prototype.html`, phone first.

## Figures

- **A month is what is booked in it.** Month views (Overview, Explore with `month=`, Budgets, the exports, MCP, the
  metrics' month) select records by `BillingPeriodStart`, so a locked month's figures never move. A late change to a
  locked month is booked in the open month as `ChargeClass = Correction` and shown there on its own line,
  **Corrections to locked months** (`CORRECTIONS`), never inside a cost center; opening it (filter
  `costCenter:CORRECTIONS`) shows whose it is. A `from`/`to` range instead selects by charge day (`basis: charge`):
  the usage of those days as corrected, wherever it was booked. Results say which (`basis: billing | charge`).
- **Month to date**: ledger records booked in the month (the newest allocation generation) plus provisional rows.
  Every figure is labelled _estimated_ (usage × the rate card) or _invoiced_, and a total that mixes them says how
  much is invoiced ("71% invoiced"); an estimate an invoice line replaces is never added to it
  ([money.md](money.md#estimated-and-invoiced), [invoices.md](invoices.md)).
- **Forecast**: month to date plus a run rate for the hours left. The run rate is per source: Σ cost ÷ Σ observed hours
  over the last 7 days (today included; observed hours come from each day's newest run: the window Clickland's samples
  covered, Landflow's whole day), summed across sources, so a partial day weighs by its hours. With fewer than **3 full
  observed days** (23 hours or more) of any source in those 7, there is no forecast: the tile says _Not enough data
  yet_, with _data since_ the newest source's first sample, and no range or state is claimed.
- **The band** (spec 006): P50 is that run rate. P10 and P90 sit z₀.₉ × σ × √days either side of it (z₀.₉ = 1.2816),
  σ² the sum of each source's sample variance of its full days' cost in the window (sources vary independently), and
  _days_ the days left. Square roots are exact integer square roots on the decimals, never floats. P10 never falls below
  month to date. Overview shows the band in its forecast tile (`P10–P90`) and on the burn chart, and says how it was
  taken under the chart. Each source's driver (consumed units a day: core-hours, GiB-hours, tokens) comes with it.
- **Committed** (spec 006): an approved or applied open-ended monthly request reserves only its first months. Beyond
  them it still commits its amount, so each month it is active without a reservation adds its amount (pro rata from
  tomorrow in the current month) to the forecast, to its cost center's forecast and to _at risk_. Reservations are
  never counted twice: a month with the request's reservation counts the reservation instead.
- **No budget** (decision 8, a default to confirm): a month with no budget is never _on track_; it says _no budget_.
  A request whose month, or first full month, has no budget for its cost center is never automatic and takes the
  Finance step; the Request page says why (`evidence.budgetMissing`).
- **States** per cost center: _over_ when month to date is above budget; with a forecast, _at risk_ when it is over
  budget (with what is committed) and _on track_ otherwise; without one, _early_ (no claim yet); _no budget_ without a budget. The month's line
  says how much of the budget is used and how much of the month has been observed, not how much has passed.
- **P&L classes**: the shared pool (idle capacity, before it is spread) is its own class, _Shared pool_; _Not
  classified_ is only what the rules sent nowhere.
- **Left after reservations**: budget less month to date less what approved requests still hold (reservations'
  remaining, [approvals.md](approvals.md#reservations)). **Needs you** lists the requests waiting on the signed-in person.

## Overview (`GET /api/overview?month=`)

Four figures (month to date, forecast with its range, budget, left), the daily burn against the budget line, where the
figures come from (attribution: direct, shared pool, unallocated; the rate card and its approver; the last runs), the
cost centers with a budget bar and state, and the split by category and by P&L class. _Copy_ puts a table on the
clipboard as tab-separated text for Excel.

## Explore (`GET /api/spend`)

Group by any dimension (cost center, team, product, service, namespace, agent, model, provider, P&L class, category,
resource, workflow), filter by `dimension:value`, choose the layer (`direct`, or `spread` with the shared pool shared
out, [allocation.md](allocation.md)), a month or `from`/`to`. Each group has estimated, invoiced, total, share, the
window before and the provisional part, and drills one level (cost center → service → resource; agent → model …). A
service links to its page in Clickland (`LANDLEDGER_CLICKLAND_CONSOLE_URL`, http://localhost:4711). A daily stacked
chart shows the top groups. The state lives in the URL, so a view can be shared.

**Exports**: `GET /api/spend/export?format=csv|xlsx` with the same query. CSV: the groups, UTF-8 with a BOM, formulas
defused with a leading apostrophe. XLSX: the groups and a daily sheet, numbers as numbers (`#,##0.00####`), written
without a library.

## Budgets (`GET /api/budgets?month=`, `POST /api/budgets/import`)

A CSV with the header `cost_center,month,amount,currency` (USD, YYYY-MM, non-negative, at most 6 decimals, a cost
center or `SHARED-POOL`, no duplicates). Every problem is reported and a bad file imports nothing. Each import is a
version, audited `budget.imported`; the newest import per cost center is the month's budget. Importing is for a
controller or the CFO (`admin`). A file that names a **locked** month is refused whole (its budget is final; the
database refuses it too), and every code must be in `cost_center_codes` (the cost centers, `SHARED-POOL` and
`UNALLOCATED`; allocations name a code from there as well, migration 0006).

The screen: budget, actual, reserved, available, forecast, variance and state per cost center (a table on desktop,
cards on a phone); a row opens to its owner, source and months.

The Overview's budget tile names the versions it is drawn from (each cost center's newest import that names it) and
carries a _dev seed_ badge when any of them is development seed data.

**The dev seed** (`apps/api/seed/budgets-2026-11.dev.csv`, origin `dev-seed`, labelled _DEVELOPMENT SEED DATA, not a
real budget_): November 2026, picked against this machine's real spend once Docker stopped being counted twice (about
USD 0.68 an hour, four fifths of it idle capacity in the shared pool), each cost center's month projected from its
first observed hours: shared pool 240, AI Agents 20, Platform 18, Data & ML 9, Product Engineering 5, Internal IT 5,
Customer Support 1. Platform and Data & ML sit a little under their projection, so they show _at risk_ once the
forecast has three full days. `pnpm db:seed` imports the file again, as a new version, whenever it changes (the first
dev seed, with Customer Support at USD 0.005, is budget v1 in the live history).

## MCP (`POST /api/mcp`)

Stateless Streamable HTTP (Clickland's pattern; GET and DELETE answer 405), scope `read`, read-only tools:

- `spend_by { by, month?, from?, to?, filter?, layer? }`: the groups as text and structured content.
- `budget_status { month?, costCenter? }`: budget, actual, forecast and state per cost center.

## Cost metrics in Clickland

Every 5 minutes (`LANDLEDGER_COST_METRICS=off` stops it) the API sends today's and yesterday's cost per service to
Clickland's collector as OTLP metrics: gauges `landledger.cost.estimated` and `landledger.cost.invoiced` in USD, one
resource per `service.name` with `k8s.namespace.name` (or `docker.compose.project`), points labelled
`landledger.day`, `landledger.cost_center` and `agent`. The newest point per day is the figure. Only what was spent:
never rates, budgets or contracts. Compose services are named `<project>/<service>`.

## Open

- Invoiced figures (wave 3), teams and products in the dev data.
- A cost column on Clickland's Services page from these metrics is Clickland's to build.

## The year ahead

`GET /api/forecast?months=12` and the _Year ahead_ card on Overview: for each month from this one, the run rate over
its days (the days left of this one) with its P10–P90 band, what approved requests reserve and what they commit beyond
their reservations, the total against its budget, and the state: _no budget_ where there is none. _Annualised_ is
today's run rate × 365 with its band, and every approved monthly commitment × 12; the commitments are listed with the
month their reservations reach. Without enough data for a run rate it says _Not enough data yet_, shows only what is
reserved and committed, and claims no total.
