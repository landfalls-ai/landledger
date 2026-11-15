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
- **Reviewed 14 Nov 2026:** every blocker, should-fix and nit fixed (history has a row each): billing-period reads,
  Docker out of the shared node's idle, a forecast on observed hours, four eyes on line authors, whole-month locks,
  repricing from the effective date, empty answers that never reverse a day, original currency and invoice links,
  the audit anchor, sealed secrets and the `landledger_app` role. Node-disk claims stay unpriced until Clickland
  reports a claim's requested size.

### Wave 2 · Control the spend

- Requests, policies, decisions, reservations; requester ≠ approver; the hash-chained audit log and the auditor role;
  the weekly exceptions report.
- Webhooks out; the `landledger` Landflow plugin; approvals in Slack and email through Landflow; approved AI budgets
  written to Landflow's caps.
- Flows: approve an infrastructure change; raise or hold an AI budget.
- Console: Approvals (phone first), Request, Rates and rules (changes as requests), Audit log.
- **Finance gets:** spend above the threshold carries a named approver; spend that skipped one is listed weekly.
- **Built 14 Nov 2026** ([approvals.md](approvals.md), [identity.md](identity.md)): requests, policies, decisions by
  people only (session or relay) with evidence snapshots, deadlines and escalation in business hours, reservations
  in budget left, rate card and rule set proposals with a preview, the exceptions report, webhooks, the auditor role,
  SCIM 2.0, MCP `list_requests`, `get_request`, `create_request`, `reserve`, and the console's Approvals, Request,
  Rates and rules and Audit log. Live: R-1, +$1,840 a month on ENG-PLATFORM, approved by the budget owner and then
  Finance in a visible Chrome; the requester refused. Not yet: the Landflow plugin's flows (built in Landflow,
  `clickland-integration`), Slack and email approvals through it, AI budgets written to Landflow's caps, a console
  form to raise a request.
- **Review of wave 2, fixed 15 Nov 2026:** relays are verified by Landledger (Slack channels with sealed signing
  secrets, people link their own Slack id, budget owner steps only, `decision.relayed`); keys minted only by a signed-in
  admin person, a relay key holds no write, `webhooks:write` for a key's own subscriptions; requests a key raises in a
  person's name wait for that person's confirmation; `createdBy` and `origin.verified`; automatic approvals counted per
  month per cost center and agent, never while at risk; cost center owners and deputies; evidence served and fresh
  within 30 minutes; consumption by increment; the first full month; exceptions against budget and what each match
  selects, stored weekly with a hash; the evidence pack; back-channel logout; business days in a time zone with
  holidays.

### Wave 3 · Plan and reconcile

- Invoice import (CSV first) and reconciliation of AI usage to the providers' invoices.
- Driver-based forecasts with a range; cost anomalies as Clickland alerts.
- Agents: cost, outcomes and capacity freed, from Landflow and Clickland's Agent Value.
- Contracts and renewals; the *tool or seat* flow with Landbright access requests.
- A periodic access review: who holds which key (and its scopes and bound workflows), which Landbright group, which
  relay link and which cost center ownership, confirmed by an admin person each quarter (review of wave 2).
- FX rates, so requests and budgets in other currencies stop being refused (`422` until then).
- **Finance gets:** AI cost tied to invoices, a forecast on calendar day 10, an alert the hour a cost jumps.
- **Built 15 Nov 2026** (specs 005–011; [invoices.md](invoices.md), [spend.md](spend.md#the-year-ahead),
  [anomalies.md](anomalies.md), [agents.md](agents.md), [contracts.md](contracts.md),
  [access-review.md](access-review.md), [integrations.md](integrations.md)): invoice import and reconciliation per
  provider and model within ±2%; the forecast band (P10–P90) and the year ahead with commitments, and decision 8 (no
  budget → Finance); cost anomalies (median and MAD) and approval patterns, as webhooks and a Clickland alert rule;
  agents' cost per outcome and a keep, scale, review or retire suggestion; contracts with renewals in their notice
  window, contract requests for their TCV and term, seat requests on a contract; the quarterly access review. Live:
  the November fixture invoices posted (Anthropic $23.50 with no Landflow estimate to replace, since the live agents
  run on Ollama; Ollama $0 replacing 12 estimates, within tolerance); the forecast says _Not enough data yet_ (Clickland
  has under 3 full days); a $25 `dev-anomaly` spike was flagged, fired Clickland's alert and was reversed (0 rows left,
  never in the ledger); Agents shows six Landflow agents at $0, _Triage the alert_ 27 runs and no outcome
  (_Retire_); Linear (notice in 17 days) and Notion imported; the 2026-Q4 access review opened by the admin, 6 of 11
  items kept, the 5 about the admin left for another controller or the CFO. Not yet: FX rates (still `422`);
  Landbright's seat cost and external policy step, and Landflow's tool-or-seat flow (integrations.md); Landlens's
  cost per workload (moved to wave 4).
- **Review of wave 3, fixed 15 Nov 2026** (Fable's review: B1–B4, should-fix 1–17 and the nits): lock-safe invoices
  (invoices only once their month is over, late estimates flagged, true-ups linked, one read rule as of the
  estimate's month, voids re-planning), property-tested against Postgres; dev fixtures in no total; forecasts netted
  against the run rate with a contracted line, one formula; seats priced, released and expiring, seats used as of a
  date; contract imports above $25,000 held for a second person; access-review revokes done at once or tracked until
  gone, with webhooks, sessions, added items, reminders and missed quarters; anomalies followed, re-alerted, assigned
  and closed, never aged out; agents "not measured" rather than Retire. Live: the two dev-fixture invoices voided as admin@landbright.test through Reconciliation, month to date for
  November $30.77 → $7.27 (−$23.50), the Ollama invoice's 12 estimates back.

### Wave 4 · Month-end

- Periods and locking; the month-end checklist; the accrual proposal; variance notes drafted by an agent and accepted
  by an analyst; incident cost into Landfall postmortems through Landflow.
- Landlens: cost per workload from Landledger's API (moved from wave 3).
- The Datarails connector against `fake-datarails`: budgets in over MCP, actuals and notes out through the upload API.
- **Finance gets:** technology lines ready on business day 1 after month-end, for the controller to review and book.
- **Built 15 Nov 2026** (specs 012–020; [close.md](close.md), [accruals.md](accruals.md),
  [variance-notes.md](variance-notes.md), [datarails.md](datarails.md), [spend.md](spend.md#an-incidents-cost)):
  - **The close.** A ten-step checklist whose gates Landledger computes, never ticked by hand. A step is explained
    with an audited note, never step 4 or 10. The lock takes two signatures, a controller and the CFO, and anchors
    the audit chain at once. The wave 1 override is gone. A month is reopened only by a `period_reopen` request the
    CFO approves, and it locks again in a new round.
  - **Accruals.** Usage estimates not yet invoiced, plus contracts' monthly value. A controller accepts them as shown.
    They reverse through the invoice links, and come out as a journal-entry CSV, never posted to a GL.
  - **Forecast history.** Stored daily. The day-10 forecast is measured at close.
  - **Variance notes.** Drafted by an agent's `notes:draft` key, with every cited figure checked against the snapshot.
    An analyst who isn't the sponsor accepts them. Every version is kept, with a template fallback.
  - **The snapshot.** Frozen at step 7 with a sha256, which the notes, the upload, the package and the audit log
    cite.
  - **`fake-datarails`.** Runs on :4819. Budgets come in over MCP as a pending pull. Actuals and notes go out through
    the FileBox upload. Hosts that aren't loopback are refused.
  - **The month-end package.** One page and a zip.
  - **`GET /api/cost/window`.** An incident's estimated cost.
  - **Seats.** A seat within its contract reserves no money (spec 020).
  - **Not yet:** Landlens's cost per workload (still open; Explore's `GET /api/spend` already groups by namespace and
    workload), Landflow's notes and incident-cost flows (Landflow's to build, integrations.md), a real Datarails
    tenant (wave 5).

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
| Landlens | cost per workload from Landledger's API | 4 |

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
7. **Business days (15 Nov 2026, a default to confirm):** approval deadlines count Sunday to Thursday in
   `Asia/Jerusalem` on this machine (`LANDLEDGER_BUSINESS_DAYS=sun-thu`, `LANDLEDGER_TZ=Asia/Jerusalem`); the code's
   default stays Monday to Friday in UTC. The holiday list (`deploy/holidays.txt`) is empty until Finance gives one.
8. **No budget (15 Nov 2026, a default to confirm):** a month with no budget is never _on track_; it shows _no budget_.
   A request landing in a month (or a first full month) with no budget for its cost center is never automatic and
   gets the Finance step, and the Request page says why. The alternative, treating a missing budget as unlimited, would
   let the automatic threshold spend into months nobody has planned.
9. **Contract policy (15 Nov 2026, a default to confirm):** a `contract` request is approved for its total contract
   value and term, never automatically: the budget owner and Finance always, the CFO above USD 25,000 of TCV (policy
   `pol_contract_1`). Seats are its reservation unit.
