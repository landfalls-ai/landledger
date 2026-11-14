# Feature 004: Approvals (wave 2, "Control the spend")

**Status**: specified and built 2026-11-14 ([docs/approvals.md](../../docs/approvals.md), [docs/identity.md](../../docs/identity.md)) · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · **Contract**:
`libs/contracts/src/requests.ts`, [reference/api.md](../../docs/reference/api.md#wave-2-requests-policies-decisions-reservations-spec-004)

## Why

Wave 1 showed the spend. Finance's next promise is control: spend above a threshold carries a named approver and the
evidence they saw, and spend that skipped one is listed weekly. Approvals happen where people are (Slack, email,
Landflow, a phone) but Landledger owns the request, the policy and the decision, so the rules hold wherever the button
is pressed. Agents raise requests too, and must never be able to approve one.

## User stories

1. **As an engineer** (or a Landflow flow, or an agent with its sponsor), I raise a request: *add 3 replicas to
   landflow-host, +USD 1,840 a month on ENG-PLATFORM*, with my note, the evidence and where it came from (a Landflow
   run, a pull request, a Landbright access request).
2. **As a budget owner**, I see what waits on me, open it on my phone, read the evidence (cost change, budget before
   and after, forecast, similar past requests) and approve with one tap, or reject with a comment.
3. **As Finance**, I decide the steps policy gives me (above USD 5,000, or a cost center at risk or over, or one this
   request takes over budget) and every rate card, rule set and policy change, with the CFO after me.
4. **As the requester**, I can't approve my own request, and neither can the agent's sponsor; nobody decides two steps
   of one request.
5. **As a Landflow flow**, I get `request.step_pending` naming the approvers (emails, Landbright subs), post a card,
   and relay the button press with a `decisions:relay` key; Landledger checks the person itself.
6. **As the controller**, approved spend reserves budget until the real cost arrives, so *budget left* already counts
   what has been promised.
7. **As an auditor**, I read Explore, Budgets, requests and decisions, the rate card and rule history and the audit
   log, and can't change anything.
8. **As the controller**, every week I get the spend above the automatic threshold per cost center and month that no
   approved request covers, and copy it to Excel.
9. **As Landbright**, I push people and groups over SCIM; deactivating someone ends their Landledger sessions at once,
   and their groups decide their roles on the next request.

## Acceptance

- **Requests**: kinds `infra_change`, `ai_budget`, `tool_or_seat`, `rate_card_change`, `rule_set_change`,
  `policy_change`, `other`; amount as Money (string, ≤ 6 decimals), `monthly` or `once`, start and end; cost center,
  title, note, evidence JSON, origin (`landflow_run` with workflow and execution ids, `pull_request` url,
  `landbright_request` id, `console`, `mcp`); a requester that is a person, or an agent and its sponsor (a person).
  Status only forward: draft → pending → approved | rejected | cancelled | expired → applied (the database refuses
  anything else).
- **Rate card and rule set approvals are requests** of those kinds. Their four-eyes rules stay: the proposer and line
  authors never decide; the approver is a person; the database checks it again on the version.
- **Policies**: thresholds and ordered steps per kind and cost center; approvers by Landbright group or by the cost
  center's owner. Seeded: automatic under USD 500, budget owner to 5,000, Finance (`Finance Controllers` or
  `Finance CFO`) to 25,000, CFO above; one-off amounts on the same lines. A policy change is itself a request.
- **Decisions**: append-only; step, person, approve or reject, comment (required to reject), the sha256 of the evidence
  snapshot shown (a snapshot Landledger served for this request). The requester and the sponsor can't decide; an agent
  never decides; a person decides one step of a request at most. A pending step escalates after its deadline (24
  business hours, configurable) and the request expires if the escalated step passes its deadline too.
- **Relays**: `POST /api/requests/:id/decisions` from a key with `decisions:relay` names the person (sub or email);
  Landledger checks that the person exists, is active, is a person, and is among the step's approvers.
- **Reservations**: approval reserves the request's months; a reservation is consumed by real cost matched by cost
  center (and the request's `match` selector) or released when its month ends. Budget left = budget − actuals −
  reservations' remaining. Overview and Budgets show them.
- **Webhooks** (Standard Webhooks, the outbox): `request.created`, `request.step_pending` (the approvers by name, email
  and sub), `request.decided`, `request.applied`, `budget.at_risk`, `period.closing`, `audit.anchor`.
- **Auditors** (`Landledger Auditors`) read everything above and write nothing (a test tries every write).
- **Exceptions report**: per cost center and month, actual − covered by approved requests, above the threshold; a
  route and a console section with *Copy for Excel*; a weekly job records it in the audit log.
- **SCIM 2.0** at `/scim/v2` after Clickland's (its conformance suite passes here too); a token in
  `~/.config/land-family/landledger-scim.env` (mode 600), never printed.
- **Console**: Approvals (waiting on me, I raised, decided), Request (what and why, evidence, the path, Decide after
  the evidence, one tap on a phone), Rates and rules (propose a rate card or rule set with its preview), Audit log
  (Verify chain); phone first, as `ui/prototype.html`.
- **MCP**: `list_requests`, `get_request`, `create_request`, `reserve`; no decide tool.

## Out of scope

Slack and email cards (Landflow's flows), writing approved AI budgets to Landflow's caps (Landflow's plugin, on
`request.decided`), contracts and seat counts (wave 3), period locking from the console (wave 4).
