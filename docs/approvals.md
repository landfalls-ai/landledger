# Approvals: requests, policies, decisions, reservations

Wave 2, "Control the spend" (spec [004](../specs/004-approvals/spec.md)). Spend above a threshold carries a named
approver; spend that skipped one is listed weekly. **Agents request; people decide.**

Routes and payloads: [reference/api.md](reference/api.md#wave-2-requests-policies-decisions-reservations-spec-004).
Identity (SCIM, deactivation, roles from groups): [identity.md](identity.md).

## A request

A request asks for spend: an infra change, an AI budget, a tool or seat, a rate card, rule set or policy change, or
other. It carries an amount (a string, at most six decimals) that is **monthly** (from `start`, to `end` or
open-ended) or **once**, a cost center, a title, a note, and evidence (any JSON; the console shows `lines`, `basis`,
`links` and `match`).

- **Where it came from:** `landflow_run` (workflow and execution), `pull_request`, `landbright_request`, `console` or
  `mcp`, plus up to ten related sources.
- **Who asks:** a person (their signed-in session, or a key naming them), or an **agent with a sponsor**, the person who
  answers for it. A key or MCP call must say which; a person's session is always the requester.
- **Status only moves forward:** `draft → pending → approved | rejected | cancelled | expired`, `approved → applied`.
  The database refuses anything else (`requests_guard`).
- Idempotent per caller: the same `idempotencyKey` from the same principal returns the first request.

Code: `apps/api/src/requests.ts` (`Requests`), migration `libs/schema/migrations/0010_requests.sql`.

## Policies

A policy is a versioned definition per kind (and optionally per cost center; a cost center's own wins): an
`automaticBelow` threshold and ordered steps, each with approvers (Landbright groups, or the cost center's owner when
the cost center names a person here) and a condition (`always`, `amountAtLeast`, `amountAbove`, `costCenterAtRisk`).
The amount compared is the monthly amount, or the one-off amount.

| Kind | Automatic | Budget owner | Finance | CFO |
|---|---|---|---|---|
| infra change, AI budget, other | under $500 | from $500 | above $5,000, or the cost center is at risk or over, or the request takes it over budget | above $25,000 |
| tool or seat | never | always | as above | above $25,000 |
| rate card, rule set, policy change | never | — | always | always |

Below the threshold a request is approved by policy at once (`automatic: true`, closed by `policy`) and reserved. A
policy change is itself a request (Finance, then the CFO): `POST /api/policies`. Code: `apps/api/src/policies.ts`.

## Decisions

Only a person decides: from their Landbright session, or relayed by a key with `decisions:relay` that names the person
by `sub` or email (Landflow, Slack, email). Landledger checks the person itself; the key alone never decides, nor does
the local developer, a bootstrap key or an agent. MCP has no decide tool.

A decision is refused (403) to:

- the requester and the agent's sponsor;
- anyone who decided an earlier step of the same request;
- a rate card's or rule set's proposer and anyone who added one of its lines (four eyes, kept from wave 1);
- someone not among the step's approvers, an inactive or unknown person, a system actor.

Each decision is append only (`decisions_guard`), needs a comment to reject, and stores the sha256 of the **evidence
snapshot** the person was shown: `GET /api/requests/:id` returns `{ request, evidence, evidenceSha256 }` and keeps the
snapshot (`evidence_snapshots`); a decision must name one Landledger served for this request at the step being decided
(`GET /api/requests/:id/evidence/:sha256` shows it later). The evidence is computed when asked: the cost center's
budget, actual, reserved, left now and after, the forecast now and with the request, the rate card in effect, similar
past requests, and why this path. Once a request is approved, "now" leaves out its own reservation, so the figures read
as they did when it was decided.

Approving the last step approves the request and reserves its months; a rate card, rule set or policy change is
applied at once (status `applied`) and the open month is repriced or reallocated. The others are applied by Landflow
(`POST /api/requests/:id/applied`). Rejecting skips the remaining steps.

## Deadlines, escalation, expiry

A pending step waits `LANDLEDGER_STEP_DEADLINE_HOURS` business hours (24 by default; business days
`LANDLEDGER_BUSINESS_DAYS`, Monday to Friday, whole UTC days). Then it escalates once to its `escalateTo` groups (the
CFO by default) with a new deadline and a new `request.step_pending` marked escalated; when that passes too, the
request expires. The job runs every minute. Code: `apps/api/src/business-hours.ts`, `Requests.expireDue`.

## Reservations

Approval reserves what the request adds: a one-off amount in its start month; a monthly amount prorated by days in its
first and last months, and for an open-ended one the start month and the two after. `POST /api/reservations` reserves
another month of an approved request (at most its monthly amount; idempotent per month).

`reserved → consumed | released`. Real cost on the cost center that matches the request's `match` selector (the same
selector as allocation rules) from its start counts against the reservation (every 10 minutes); a reservation is
consumed when it is used up, and released at month end with what was used. Budget left = budget − actuals −
reservations' remaining, on Overview (Left after reservations) and Budgets (Reserved, Available, and the reservations
under each cost center). Code: `apps/api/src/reservations.ts`.

## Rate card and rule set changes

The old approve routes answer `409` with the version's request. A change is proposed with a **preview of its effect on
the open month** (spec 003 T010), then raised as a request:

- **Rate card:** new unit prices for some lines from a day. The preview reprices the open month's records priced by the
  changed lines from that day: Σ quantity × (new − booked unit price), per cost center and per line.
- **Rule set:** the whole ordered list (and share rules). The preview allocates the open month's direct layer under the
  rules in effect and under the proposal, per cost center and per rule.

Rates and rules in the console has both forms (a person with `requests:write`), the policies in effect, and links to
the change requests still waiting. Code: `apps/api/src/proposals.ts`.

## The weekly exceptions report

Per cost center and month: the actual spend (direct layer) less what approved or applied requests cover in that month,
listed when it is above the cost center's automatic threshold. The shared pool, Unallocated and Corrections are listed
apart (`unowned`): there is no owner to ask. `GET /api/exceptions` (this month and the last by default), the Approvals
screen's last card with Copy for Excel, and an audited `exceptions.weekly_report` once every 7 days. Code:
`apps/api/src/exceptions.ts`.

## Webhooks

Through the outbox, Standard Webhooks: `request.created`, `request.step_pending` (the step, its groups, each approver's
name, email and `sub`, the console URL and the `evidenceSha256` to relay with), `request.decided`, `request.applied`,
`budget.at_risk` (once per cost center, month and state, checked every 15 minutes), `period.closing`, `audit.anchor`.
The console URL is `/requests/:id`, which opens the same Request page as `/approvals/:id`.

## Roles

| Role (Landbright group) | Can |
|---|---|
| CFO (`Finance CFO`), controller (`Finance Controllers`) | read, raise requests and proposals, decide their steps, administer keys, webhooks and SCIM tokens |
| FP&A (`Finance FP&A`), budget owner (`Budget Owners`), engineer (`Engineering`) | read, raise requests; a budget owner decides the owner step |
| auditor (`Landledger Auditors`) | read everything, write nothing (an integration test tries every write) |

## The console

Phone first, after `ui/prototype.html`:

- **Approvals:** Waiting on you, You raised, Decided, each with amount per month or once, cost center, budget left after
  it, who asked (agent badge and sponsor), age and step; Copy for Excel; the tiers; the exceptions report. The count of
  requests waiting on you is on the sidebar and the bottom bar.
- **Request:** what and why, the evidence, the path (tiers, why, steps with who decided, when and their comment, the
  deadline), then Decide: one tap to approve on a phone after the evidence; a comment to reject; the requester and the
  sponsor see who has it instead. Once decided, the snapshot's hash and the reservations.
- **Rates and rules:** the policies in effect, and proposals with a preview.
- **Audit log:** every record newest first with its hash and chain position, Verify chain, Copy for Excel.
- **Overview:** Needs you lists requests waiting on you; Left after reservations counts them.

## On this machine (14 Nov 2026)

R-1 "Two GPU nodes for the inference pool", +$1,840 a month on ENG-PLATFORM from 16 Nov, raised by Tal Levi
(engineer) in his session. The path: budget owner (from $500), then Finance (the request takes ENG-PLATFORM over its
$18 dev-seed budget). Tal's own approval was refused (403, "You raised this request"). Shira Navon (Budget Owners)
approved at 21:22:04 UTC and Yoav Ben-David (Finance Controllers) at 21:23:19 UTC, each signed in through Landbright in
a visible Chrome; reserved $920 in November and $1,840 in December and January. Screenshots in
`study/wave2-screens/`.

## Not yet

- Approvals in Slack and email go through Landflow's `landledger` plugin (a `decisions:relay` key); approved AI
  budgets written to Landflow's caps; the two flows.
- No form in the console to raise an infra, AI budget or seat request: they come from Landflow, MCP or the API.
- Reservation consumption matches the request's `match` selector only; a request without one is released at month end.
- Business days are whole UTC days; no holiday calendar.
