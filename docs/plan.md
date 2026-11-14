# Landledger: the plan

Approved direction (14 Nov 2026): a dedicated project, not a part of Clickland. This page is the plan to build it;
[architecture.md](architecture.md) is the design, [ui.md](ui.md) the screens, `ui/prototype.html` the clickable
prototype. The proposal that led here: <https://claude.ai/artifact/DFM4g6ppMp3YHmAwBAY4Z9>.

## What it is for

The CFO team gets technology and AI spend as a daily number with an owner and a reason, spend above an approval
threshold carries a named approver and the evidence they saw, and month-end gets the technology lines already
explained. Landledger is management reporting (showback); the accounting system stays the book of record.

## Principles

1. **Agents request; people decide.** No key, token or tool lets an agent approve.
2. **Every figure says whether it is estimated or invoiced.** Notional cluster cost never goes to the books as actuals.
3. **Money is exact.** Amounts in integer micro-units (10⁻⁶) with a currency, rounded to the minor unit only when
   posted or shown; decimal rates; FX by date ([money.md](money.md), refined by spec 001).
4. **Nothing is edited.** Records, decisions and the audit log are appended; closed months lock.
5. **Landledger reads the family; nobody depends on it.** If it is down, flows wait and nothing else breaks.
6. **Local only, fakes first.** OrbStack, development credentials, a fake Datarails; real outside services wait for
   your decision.
7. **Spec-driven, docs move with the code** (the Landbright method): each feature starts as `specs/NNN-name/`.

## Waves

Each wave ends with something finance can use, checked live, with screenshots at 390 and 1440 px.

### Wave 0 · Study and scaffold

- Craft Anything study of **OpenCost** (Apache-2.0): its allocation model (idle and shared cost, custom CSV pricing
  for on-premises clusters) and its API, cited by file and line as Clickland's research is.
- The **FOCUS 1.4** columns Landledger keeps, and its `x_` extensions, in `libs/focus`.
- The repo: pnpm + Nx monorepo as Clickland, `@land/tokens`, compose project `landledger-infra`, telemetry to
  Clickland, the GitHub repo (your call: public in landfalls-ai, like the others).
- Specs `001-money-and-records`, `002-ingest`, `003-allocation`.

### Wave 1 · See the spend

- `libs/money`, the schema, cost records, rate card v1, allocation rules with P&L class and capitalisable flag.
- Ingest: Landflow AI usage (exists) and Clickland usage totals (needs `POST /api/usage/rollup` in Clickland, a small
  route over the metrics it already has).
- Budgets from a CSV; the shared pool reported on its own.
- Console: Overview, Explore, Budgets (read), Copy for Excel, CSV and XLSX export.
- Sign-in through Landbright; roles from groups.
- MCP: `spend_by`, `budget_status`; cost metrics to Clickland (its cost lens).
- **Finance gets:** last month's AI and cluster cost per team against budget, a daily figure since, a file for Excel.
- **Built 14 Nov 2026** ([ingest.md](ingest.md), [rate-cards.md](rate-cards.md), [allocation.md](allocation.md),
  [spend.md](spend.md)). Not yet: rule set proposals with a preview, the insights-only backfill, recorded fixtures,
  Approve buttons in the console (approvals are made from a person's signed-in session), invoiced figures.

### Wave 2 · Control the spend

- Requests, policies, decisions, reservations; requester ≠ approver; the hash-chained audit log and the auditor role;
  the weekly exceptions report.
- Webhooks out; the `landledger` Landflow plugin; approvals in Slack and email through Landflow; approved AI budgets
  written to Landflow's caps.
- Flows: approve an infrastructure change; raise or hold an AI budget.
- Console: Approvals (phone first), Request, Rates and rules (changes as requests), Audit log.
- **Finance gets:** spend above the threshold carries a named approver; spend that skipped one is listed weekly.

### Wave 3 · Plan and reconcile

- Invoice import (CSV first) and reconciliation of AI usage to the providers' invoices.
- Driver-based forecasts with a range; cost anomalies as Clickland alerts.
- Agents: cost, outcomes and capacity freed, from Landflow and Clickland's Agent Value.
- Contracts and renewals; the *tool or seat* flow with Landbright access requests.
- **Finance gets:** AI cost tied to invoices, a forecast on calendar day 10, an alert the hour a cost jumps.

### Wave 4 · Month-end

- Periods and locking; the month-end checklist; the accrual proposal; variance notes drafted by an agent and accepted
  by an analyst; incident cost into Landfall postmortems through Landflow.
- The Datarails connector against `fake-datarails`: budgets in over MCP, actuals and notes out through the upload API.
- **Finance gets:** technology lines ready on business day 1 after month-end, for the controller to review and book.

### Wave 5 · Real systems (your decision, one at a time)

A real Datarails tenant; SaaS invoices from an inbox; cloud bills as FOCUS exports if the company runs in a cloud.
Each sends data outside this machine.

## Changes in the siblings

| Repo | Change | Wave |
|---|---|---|
| Clickland | `POST /api/usage/rollup`; a cost column on Services from the `landledger.cost.*` metrics | 1 |
| Landflow | the `landledger` plugin; three templates (infra change, AI budget, tool or seat) | 2 |
| Landflow | a generic Approval step that waits on an outside decision, if the Wait node's webhook resume isn't enough | 2 |
| Landbright | register the client; the finance groups (no code) | 1 |
| Landbright | access bundles with seat cost call Landflow before granting | 3 |
| Landlens | cost per workload from Landledger's API | 3 |

Each is asked of that repo's session first; none is needed for Landledger itself to run.

## How we check it

- `pnpm verify` (format, typecheck, lint, test, build), integration tests against Postgres
  (`LANDLEDGER_INTEGRATION=db`), the fakes for Landflow, Clickland and Datarails.
- Money tests by property: sums never drift, allocation splits always total the record.
- A live check per wave on this machine with screenshots, and a Fable review of each wave's design and code.

## Measures

At least 80% of technology spend attributed directly to a cost center (shared pool reported separately); AI cost
jumps alerted within an hour; median approval under 4 business hours; calendar-day-10 forecast within ±10%; AI usage
within ±2% of invoices; technology lines ready on business day 1.

## Decisions (14 Nov 2026)

The user said "start everything, don't wait for me", so the proposed defaults stand until changed:

1. **Name:** Landledger.
2. **Approval thresholds:** automatic under USD 500 a month; budget owner to USD 5,000; Finance to USD 25,000; CFO
   above. One-off amounts use the same lines.
3. **Rate card v1:** a blended internal rate, owned by finance and editable through a request: USD 0.034 per
   vCPU-hour, 0.0045 per GiB-hour of memory, 0.10 per GB-month of storage, 0.02 per GB of network egress. AI tokens are
   priced from the providers' list prices, as Landflow's price table carries them.
4. **Datarails:** no tenant yet. Budgets are kept in Landledger (CSV import). The Datarails connector is built
   against `fake-datarails` in wave 4.
5. **Repository:** public in landfalls-ai, like the other land projects, scanned for secrets before every push.
6. **Currency:** one reporting currency, USD.
