# The console: screens

The finance team's web app. Phone first (one column, a bottom bar), with a sidebar from `md` up, in the land family's
look: `@land/tokens` (a monochrome palette, brick red for danger, forest green for good, amber for caution), Geist
and Geist Mono, light and dark. It sits beside Clickland's console, so its shell is the same: sidebar groups, a time
range at the top right, cards with hairline borders, mono figures.

The clickable prototype is `ui/prototype.html` (static, sample data, no network). Every screen below is one of its
`#routes`.

## Rules every screen follows

- **Every figure says what it is.** A cost is *estimated* (usage × rate card) or *invoiced* (matched to a bill). It
  shows as a small badge, and totals that mix both say so ("$48,210 · 71% invoiced").
- **Money is set in mono with tabular figures**, in the reporting currency with its code once per screen.
- **State is a shape as well as a number.** Cost centers carry a pill: *on track*, *at risk* (forecast over budget),
  *over* (actual over budget). Requests carry their step: *step 2 of 3 · Finance*.
- **Every table copies cleanly into Excel** (a *Copy for Excel* button puts tab-separated rows on the clipboard).
- **Approving is one tap on a phone,** after the evidence, never before it.
- **Agents never approve.** Any screen that decides shows who the person is; an agent's request shows the agent and
  its accountable sponsor.

## Navigation

| Group | Screen | Route | Bottom bar on a phone |
|---|---|---|---|
| Money | Overview | `#overview` | yes |
| | Explore | `#explore` | yes |
| | Budgets | `#budgets` | |
| Control | Approvals | `#approvals` (inbox), `#request` (one request) | yes, with a count |
| | Contracts | `#contracts` | |
| Value | Agents | `#agents` | |
| Close | Month-end | `#close` | |
| Setup | Rates and rules | `#rules` | |
| | Audit log | `#audit` | |

On a phone the rest sit under **More**.

## Overview (`#overview`)

The CFO's screen: is technology spend on plan this month, and what needs a decision.

- **Four figures:** month to date, forecast to month-end, budget, and budget left after reservations. The forecast
  carries its range.
- **The month's burn:** cumulative actual (a solid line to today), forecast (dashed to month-end, with a band), budget
  (a flat line). Annotated where something happened ("Nov 9 · agent loop, $1,240").
- **Cost centers:** one row each, with month to date, budget, forecast, a bar of actual + reserved against budget, and
  the pill.
- **Needs you:** approvals waiting on the signed-in person, cost anomalies, the close checklist's state.
- **The split:** by category (AI models, cluster compute, storage, SaaS), and by P&L class (cost of revenue, R&D,
  S&M, G&A).

## Explore (`#explore`)

Where spend comes from. Group by cost center, team, product, service, namespace, agent, model, provider or P&L
class; filter by any of them; a stacked daily bar over the period; a table with each group's estimated and invoiced
parts, change against last month, and share. A row drills down a level (cost center → service → resource), and a
service opens its Clickland page (latency and errors next to the money). Shared and idle cost is its own row,
*Shared pool*, never folded into teams.

## Budgets (`#budgets`)

Per cost center and month: budget, actual, reserved, available, forecast, and the variance with its percentage. The
budget's version and source (Datarails, a spreadsheet, entered here). A cost center opens its months, its owner and
the reservations against it.

## Approvals (`#approvals`, `#request`)

The inbox: requests waiting on me, then ones I raised, then decided ones. A row shows the title, the amount per month
(or once), the cost center, the budget left after it, who asked (person, or agent and sponsor), its age and its step.

One request:

- **What and why:** the requester's note, the kind (infra change, AI budget, tool or seat, rate-card change, policy
  change), the source (a Landflow run, a pull request, a Landbright access request).
- **The evidence:** the cost change with its basis (the rate card's version, last 30 days of real usage), the budget
  before and after, the forecast with it, similar past requests.
- **The path:** the policy's steps (automatic below USD 500 a month, budget owner, Finance, CFO), who decided each and
  when; the current step names its approvers.
- **Decide:** approve or reject with a comment; the requester can't approve their own request. A decision records a
  snapshot of the evidence shown.

## Contracts (`#contracts`)

Vendor contracts and subscriptions: vendor, product, cost center, annual value, seats used of seats paid, term,
renewal date, notice date. Renewals inside their notice window come first, and each shows in Overview's Needs you.
The controller and the CFO import a CSV here. A seat request's page shows the contract's seats (paid, used, reserved,
left now and after); a contract request's shows its total value and term ([contracts.md](contracts.md)).

## Agents (`#agents`)

Each AI agent's month: cost (models and compute), runs and outcomes, cost per outcome, capacity freed (hours saved ×
a blended role rate, labelled as capacity, not cash), its owner and cost center, and a suggestion: keep, scale,
review or retire. The data comes from Landflow's usage ledger and Clickland's Agent Value.

## Month-end (`#close`)

The close of a period as a checklist, in order: usage ingested to the last day; AI usage reconciled to the providers'
invoices (within ±2%); unallocated spend under its limit; the accrual proposal for usage not yet invoiced; variance
notes drafted by an agent and accepted by an analyst; the upload to Datarails; the period locked. Each step shows
who did it and when; a locked period can't change, and corrections post to the open one.

## Rates and rules (`#rules`)

- **Rate card:** the current version and its effective date, the rates (per vCPU-hour, GiB-hour of memory, GB-month
  of storage, per million input and output tokens per model), the versions before it. A change is a request.
- **Allocation rules:** in order; each maps a selector (namespace, label, agent, workflow) to a cost center, team,
  product, P&L class and the capitalisable flag; shared-cost splits and their basis.
- **Policies:** the thresholds and steps per request kind and cost center.

## Audit log (`#audit`)

Every decision, rule, rate and period change, newest first: who, what, when, the record's hash and its chain
position, with a *Verify chain* control. Auditors see this screen, Explore and Budgets, read-only.
