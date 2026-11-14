# Spend: Overview, Explore, Budgets

What wave 1 shows: the month's spend with its owner, against budget, as screens, files, MCP tools and metrics in
Clickland. Code: `apps/api/src/spend.ts` (reads), `budgets.ts`, `export.ts`, `mcp.ts`, `metrics.ts`;
`apps/console/src/routes/overview.tsx`, `explore.tsx`, `budgets.tsx`, `components/spend/`. Screens follow
[ui.md](ui.md) and `ui/prototype.html`, phone first.

## Figures

- **Month to date**: ledger records of the month (the newest allocation generation) plus today's provisional rows.
  Every figure is labelled *estimated* (usage × the rate card) or *invoiced*; wave 1 has estimates only.
- **Forecast**: month to date plus a run rate for the days left. The run rate is the mean of the last 7 days' cost per
  day; a Clickland day that was only partly observed counts as cost per observed hour × 24 (observed hours from the
  ingest runs). The range is the lowest and highest of those days (±15% with a single day).
- **States** per cost center: *over* when month to date is above budget, *at risk* when the forecast is, *on track*
  otherwise, *no budget* without one.
- **Left after reservations**: budget less month to date less reservations (none until wave 2).

## Overview (`GET /api/overview?month=`)

Four figures (month to date, forecast with its range, budget, left), the daily burn against the budget line, where the
figures come from (attribution: direct, shared pool, unallocated; the rate card and its approver; the last runs), the
cost centers with a budget bar and state, and the split by category and by P&L class. *Copy* puts a table on the
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
controller or the CFO (`admin`).

The screen: budget, actual, reserved, available, forecast, variance and state per cost center (a table on desktop,
cards on a phone); a row opens to its owner, source and months.

**The dev seed** (`apps/api/seed/budgets-2026-11.dev.csv`, origin `dev-seed`, labelled *DEVELOPMENT SEED DATA, not a
real budget*): November 2026 figures picked against this machine's real spend so every state shows: shared pool 200,
AI Agents 60, Platform 40, Product Engineering 10, Data & ML 8, Internal IT 5, Customer Support 0.005.

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

- Invoiced figures (wave 3), reservations (wave 2), teams and products in the dev data.
- A cost column on Clickland's Services page from these metrics is Clickland's to build.
