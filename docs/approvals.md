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
  `mcp`, plus up to ten related sources. **`origin.verified`** says whether Landledger can vouch for it: `console` and
  `mcp` always (Landledger stamps them; MCP's `create_request` takes no origin), a `landflow_run` only when the key that
  sent it is bound to that workflow (`boundWorkflowIds` on the key); anything else a key says is kept as said, with
  `verified: false`, and the console marks it "as the caller said, not verified".
- **Who created it:** `createdBy` (`{ kind: key | person, id, name }`), stamped by Landledger, never taken from the body.
- **Who asks:** a person (their signed-in session, or a key naming them), or an **agent with a sponsor**, the person who
  answers for it. A key or MCP call must say which; a person's session is always the requester.
- **Confirmation:** when a key names a person (the requester, or the agent's sponsor), the request waits in
  `awaiting_confirmation` until that person **confirms** it from their own session (`POST /api/requests/:id/confirm`;
  the Request page and Needs you show a Confirm / Decline card), and only then enters the policy. **Decline** (with a
  reason) cancels it. Webhook `request.needs_confirmation` names the person. Unconfirmed, it expires after the step
  deadline. A request a person raises in their own session skips this. While it waits, the page's path is a preview
  ("If confirmed now, policy is re-run"): the policy runs again at confirmation, against that day's budget and what
  policy approved this month.
- **Status only moves forward:** `draft → awaiting_confirmation → pending → approved | rejected | cancelled | expired`,
  `draft → pending`, `approved → applied`. The database refuses anything else (`requests_forward_only`), and won't
  move `awaiting_confirmation → pending` without the person's confirmation recorded.
- **Only USD** until FX is set up: another currency is `422`.
- Idempotent per caller: the same `idempotencyKey` from the same principal with the same body returns the first
  request; with a different body it is `409`.

Code: `apps/api/src/requests.ts` (`Requests`), migrations `0010_requests.sql` and `0011_review_wave2.sql`.

## Policies

A policy is a versioned definition per kind (and optionally per cost center; a cost center's own wins): an
`automaticBelow` threshold and ordered steps, each with approvers (Landbright groups, or the cost center's owner and
deputies) and a condition (`always`, `amountAtLeast`, `amountAbove`, `costCenterAtRisk`). The amount compared is the
monthly amount, or the one-off amount. `costCenterAtRisk` holds when the cost center is at risk or over now, when this
request takes it over in its first month, or when it takes it over in its **first full month** (a monthly request that
starts part-way through a month adds only part of it there; the evidence shows both months).

| Kind | Automatic | Budget owner | Finance | CFO |
|---|---|---|---|---|
| infra change, AI budget, other | under $500 | from $500 | above $5,000, or the cost center is at risk or over, or the request takes it over budget | above $25,000 |
| tool or seat | never | always | as above | above $25,000 |
| rate card, rule set, policy change | never | — | always | always |

Below the threshold a request is approved by policy at once (`automatic: true`, closed by `policy`) and reserved, with
two limits so a split or a ratchet reaches a person:

- **Counted per month:** what policy approved on the cost center this month counts toward the threshold (and for an AI
  budget, what it approved for the same agent, on any cost center). $4,900 sent as ten $490 requests gets one automatic
  approval; the other nine go to the budget owner. Requests entering the policy at once take turns (an advisory lock
  per cost center and agent), so a split sent in parallel counts too. The evidence shows `automaticThisMonth`.
- **Never while at risk:** nothing is automatic while the cost center is at risk or over budget, or when this request
  takes it over (in its first month or its first full month).

A policy change is itself a request (Finance, then the CFO): `POST /api/policies`. Code: `apps/api/src/policies.ts`.

### Who decides the budget owner step

A cost center's **owner and deputies** (`PUT /api/cost-centers/:code/owners`, an admin person; append only, the newest
mapping wins; a service-like account is refused) decide its budget owner step, and nobody else in `Budget Owners` can.
Without a mapping, the cost center's own owner from its dimension row counts when that names a person here. Without
either, the step falls back to the `Budget Owners` group and says so on the step ("ENG-X has no owner mapped in
Landledger, so Budget Owners decides this step"). When the owner raised the request or sponsors its agent and no deputy
can decide, the step goes **straight to escalation** at start: the next step's approvers, else the admin groups
(`Finance Controllers`, `Finance CFO`), and its note says why. The same happens to any step whose only approvers
decided an earlier one: a single CFO who approved the Finance step doesn't stall the CFO step, which escalates to the
admin groups. Each decision says whether its person was the `owner`, a `deputy` or `not_owner`; the Request page flags
"not the cost center's owner".

**Service accounts** (a generic `Administrator`, `admin@…`, `root`, bots, no-reply addresses) are never approvers and
never decide; the Request page lists them apart under the step.

## Decisions

Only a person decides: from their Landbright session, or through a **relay channel** whose press Landledger verifies
itself (below). An API key never decides on its own (`POST /api/requests/:id/decisions` with a key is 403), nor does
the local developer, the bootstrap key or an agent. MCP has no decide tool.

A decision is refused (403) to:

- the requester and the agent's sponsor;
- anyone who decided an earlier step of the same request;
- a rate card's or rule set's proposer and anyone who added one of its lines (four eyes, kept from wave 1);
- someone not among the step's approvers, an inactive or unknown person, a system actor.

- a service-like account, or anyone after the step's deadline (409, even before the job escalates it).

Each decision is append only (`decisions_guard`), needs a comment to reject, and stores the sha256 of the **evidence
snapshot** the person was shown: `GET /api/requests/:id` returns `{ request, evidence, evidenceSha256, servedAt }`,
keeps the snapshot (`evidence_snapshots`) and records **who it was served to and when** (`evidence_serves`: a person,
a key, the webhook outbox). A decision must name a snapshot served **to that decider within the last 30 minutes**, at
the step being decided; otherwise `409` "The request changed or the evidence is stale; reopen it". A relay cites the
card's hash, which Landledger served to a key or in `request.step_pending` within 30 minutes and the channel's
signature covers. `GET /api/requests/:id/evidence/:sha256` shows a snapshot later.

The evidence is computed when asked: the cost center's budget, actual, reserved, left now and after, the forecast now
and with the request, the **first full month** (its budget, reserved, left after it and its state), the **commitment**
(monthly and annualised: twelve months for an open-ended one), what policy approved this month on the cost center and
for the agent, a rate card change's frozen lines and their sha256, the rate card in effect, similar past requests, and
why this path. Once a request is approved, "now" means without it: its own reservation is left out, so "Budget left ·
without it" and "with its reservation" differ by what it holds.

### Relays: Slack

An admin person registers a **relay channel** (`POST /api/relay-channels`): kind `slack`, the app's signing secret
(sealed at rest with `LANDLEDGER_SECRET_KEY`, never shown again), the team id and the app id. Teams and email are
reserved kinds for later. Each person **links their own Slack user id** on their profile page (Link Slack,
`POST /api/me/links`), signed in themselves; nobody else, and no key, can make that link, and one Slack id belongs to
one person.

A relay (Landflow's plugin, with a key holding `decisions:relay` and nothing that writes) posts the raw Slack
interaction to `POST /api/relays/slack`: the body exactly as Slack sent it, `X-Slack-Signature` and
`X-Slack-Request-Timestamp`. Landledger checks the signature with the channel's secret, the timestamp (5 minutes), the
team and the app; reads the press (button `landledger.approve` / `landledger.reject` whose value is
`ll1|<requestId>|<step>|<evidenceSha256>`, or the reject modal with its reason); maps the Slack user to the person who
linked it; and decides as that person, with every check a console decision has. It refuses an unlinked user, a person
who is neither SCIM-managed nor signed in within 7 days, and any step but the **budget owner's** step of an infra
change, AI budget, tool or seat, or other request: Finance, the CFO and rate card, rule set and policy changes are
decided in the console only (the database refuses too). Every relayed decision sends `decision.relayed` naming the
person, so they hear of it, and is marked relayed in the audit log and on the Request page. Code:
`apps/api/src/relays.ts`.

Approving the last step approves the request and reserves its months; a rate card, rule set or policy change is
applied at once (status `applied`) and the open month is repriced or reallocated. The others are applied by Landflow
(`POST /api/requests/:id/applied`). Rejecting skips the remaining steps.

## Deadlines, escalation, expiry

A pending step waits `LANDLEDGER_STEP_DEADLINE_HOURS` business hours (24 by default). Business days are
`LANDLEDGER_BUSINESS_DAYS` (Monday to Friday by default; this machine `sun-thu`), each counted whole in
`LANDLEDGER_TZ` (UTC by default; this machine `Asia/Jerusalem`), skipping the dates in `LANDLEDGER_HOLIDAYS_FILE`
(`deploy/holidays.txt`, one `YYYY-MM-DD` per line, empty for now). Then the step escalates once to its `escalateTo`
groups (the CFO by default) with a new deadline and a new `request.step_pending` marked escalated; when that passes too,
the request expires. A request awaiting confirmation expires after one deadline. The job runs every minute. Code:
`apps/api/src/business-hours.ts`, `Requests.expireDue`.

## Reservations

Approval reserves what the request adds: a one-off amount in its start month; a monthly amount prorated by days in its
first and last months, and for an open-ended one the start month and the two after. A **backdated** monthly request
reserves from the later of its start month and the current month. `POST /api/reservations` reserves another month of
an approved request (at most its monthly amount; idempotent per month).

`reserved → consumed | released`. A reservation is consumed by real cost on its cost center that its request's `match`
selector selects (the same selector as allocation rules), from its first day, and only by **the increment**: at
approval Landledger records a **baseline**, the matched cost's daily average over the 30 days before, and each day only
what is above it counts. Where selectors overlap, the **oldest** reservation takes a cost first and the next sees only
what is left, so one cost never consumes two. A reservation without a selector (`consumption: none`) is consumed by
nothing and held in full until its month ends, as before; Budgets says so under it. The job runs every 10 minutes on
the injected clock; at month end what is left is released.

**Releasing** one (`POST /api/reservations/:id/release`) and saying a request is **applied**
(`POST /api/requests/:id/applied`) is for the key that raised the request, its requester or sponsor, or an admin
person. Budget left = budget − actuals − reservations' remaining, on Overview (Left after reservations) and Budgets
(Reserved, Available, and the reservations under each cost center). Code: `apps/api/src/reservations.ts`.

## Rate card and rule set changes

The old approve routes answer `409` with the version's request; they need `requests:write` and a signed-in person (an
auditor, a read key or any key gets 403). For a version proposed before wave 2 they raise its request on first call:
the requester is the proposer, and the audit log names the person who called. A rate card version's lines are
**frozen** once its request exists (`POST …/ai-lines` 409; the database refuses an insert), and the evidence carries
their sha256. A change is proposed with a **preview of its effect on the open month** (spec 003 T010), then raised as a
request:

- **Rate card:** new unit prices for some lines from a day. The preview reprices the open month's records priced by the
  changed lines from that day: Σ quantity × (new − booked unit price), per cost center and per line.
- **Rule set:** the whole ordered list (and share rules). The preview allocates the open month's direct layer under the
  rules in effect and under the proposal, per cost center and per rule.

Rates and rules in the console has both forms (a person with `requests:write`), the policies in effect, and links to
the change requests still waiting. Code: `apps/api/src/proposals.ts`.

## The weekly exceptions report

Per cost center and month: **uncovered = actual (direct layer) − budget − covered**, listed when it is above the cost
center's automatic threshold. An approved or applied request covers only what its `match` selects, up to what it adds
in the month (oldest first, so overlapping selectors never cover one cost twice); a request without a match covers its
cost center up to what it adds. Each row lists the requests and what each covered, and how (`match`, `cost_center`).
The shared pool, Unallocated and Corrections are listed apart (`unowned`): there is no owner to ask.
`GET /api/exceptions` (this month and the last by default), the Approvals screen's last card with Copy for Excel.

Every 7 days the job **stores** the report (`exception_reports`: its figures and the sha256 of their canonical JSON,
append only), audits `exceptions.weekly_report` with the hash, and sends `report.exceptions`.
`GET /api/exceptions/reports` and `GET /api/exceptions/reports/:id` read them back. Code: `apps/api/src/exceptions.ts`.

## The evidence pack

`GET /api/requests/:id/evidence-pack` (JSON) or `?format=html` (a printable page; print it to PDF): the request, every
snapshot served with to whom and when, the decisions, every audit entry about the request and its reservations, and
the chain checked from them to the head against the last anchor. The Request page links it. Code:
`apps/api/src/evidence-pack.ts`.

## Webhooks

Through the outbox, Standard Webhooks: `request.created`, `request.needs_confirmation`, `request.step_pending` (the step,
its groups, each approver's name, email and `sub`, the console URL, the `evidenceSha256` to put on the card and whether
the step is `relayable`), `decision.relayed`, `request.decided`, `request.applied`, `budget.at_risk` (once per cost
center, month and state, checked every 15 minutes), `report.exceptions`, `period.closing`, `audit.anchor`. The console
URL is `/requests/:id`, which opens the same Request page as `/approvals/:id`.

A key with `webhooks:write` (Landflow's) creates, lists and deletes only the subscriptions it created, and sees their
deliveries; it never sees another subscription or a secret after creation. An admin person manages all of them.

## Keys

Only a **signed-in admin person** mints an API key (Settings has no form yet: `POST /api/keys` from the console's
session). The bootstrap key (`LANDLEDGER_BOOTSTRAP_KEY`) mints only until the first admin person exists: the documented
first-setup path is that the first CFO or controller signs in through Landbright, then mints the keys. A key never
mints a key. A `decisions:relay` key holds neither `requests:write` nor `admin` (400; the database checks it, and a
key that somehow holds both is refused at the door). Minting and revoking are audited with the key's name and scopes,
and the Audit log shows them, with role changes at sign-in, beside the decisions ("Decisions and access changes").

## Roles

| Role (Landbright group) | Can |
|---|---|
| CFO (`Finance CFO`), controller (`Finance Controllers`) | read, raise requests and proposals, decide their steps, administer keys, webhooks, relay channels, cost center owners and SCIM tokens (signed in) |
| FP&A (`Finance FP&A`), budget owner (`Budget Owners`), engineer (`Engineering`) | read, raise requests; a budget owner decides the owner step |
| auditor (`Landledger Auditors`) | read everything, write nothing (an integration test tries every write) |

## The console

Phone first, after `ui/prototype.html`:

- **Approvals:** Waiting on you, You raised, Decided, each with amount per month or once, cost center, budget left after
  it, who asked (agent badge and sponsor), age and step; Copy for Excel; the tiers; the exceptions report. The count of
  requests waiting on you is on the sidebar and the bottom bar.
- **Request:** what and why (with who raised it, stamped, the origin marked when not verified, and the annualised
  commitment), the evidence (both months when the first full month differs), the path (tiers, why, steps with who
  decided, when and their comment, relayed and "not the cost center's owner" marks, the step's note, service accounts
  apart, the deadline), then Decide: one tap to approve on a phone after the evidence; a comment to reject; the
  requester and the sponsor see who has it instead. A request awaiting confirmation shows the Confirm / Decline card to
  its person and who it waits on to everyone else. Once decided, the snapshot's hash and the reservations. **This
  request**, away from Approve and Reject: the evidence pack and Cancel, which asks again first. Every time shows its
  time zone.
- **Your profile** (`/profile`, from the person's row): Link Slack.
- **Rates and rules:** the policies in effect, and proposals with a preview.
- **Audit log:** every record newest first with its hash and chain position, Verify chain, Copy for Excel; relayed
  decisions marked, access changes (keys, roles at sign-in, SCIM, relay channels and links, owners) marked, and a
  filter to see decisions and access changes side by side.
- **Overview:** Needs you lists requests raised in your name to confirm, and those waiting on you; Left after
  reservations counts them.

## On this machine (14 Nov 2026)

R-1 "Two GPU nodes for the inference pool", +$1,840 a month on ENG-PLATFORM from 16 Nov, raised by Tal Levi
(engineer) in his session. The path: budget owner (from $500), then Finance (the request takes ENG-PLATFORM over its
$18 dev-seed budget). Tal's own approval was refused (403, "You raised this request"). Shira Navon (Budget Owners)
approved at 21:22:04 UTC and Yoav Ben-David (Finance Controllers) at 21:23:19 UTC, each signed in through Landbright in
a visible Chrome; reserved $920 in November and $1,840 in December and January. Screenshots in
`study/wave2-screens/`.

## Not yet

- Slack is the only relay channel; Teams and email are reserved kinds. Approved AI budgets written to Landflow's caps;
  the two flows (Landflow's side).
- No form in the console to raise an infra, AI budget or seat request (they come from Landflow, MCP or the API), to mint
  a key, or to register a relay channel or map owners (the API routes exist; an admin person calls them signed in).
- Only USD; FX rates are wave 3.
- A periodic access review (who holds which key, group and link) is on the wave 3 list.
