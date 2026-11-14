# Tasks 004: Approvals

Ordered; each task ends with its tests passing.

- [x] T001 The contract in `libs/contracts/src/requests.ts` and the routes in `docs/reference/api.md`, pushed first.
- [x] T002 Migrations 0009 (identity) and 0010: requests, steps, evidence snapshots, decisions, policies, reservations, budget alerts; the
      forward-only and append-only triggers; the decision guard; grants to `landledger_app`; database tests.
- [x] T003 Policies: the seeded defaults, resolution by kind and cost center, the path for an amount and state; tests
      of every path.
- [x] T004 Requests: raise (person, key with a person, agent with a sponsor), drafts, submit, cancel, idempotency,
      automatic approval; audit and `request.created`.
- [x] T005 Evidence and its snapshot hash; decisions from a session and by relay; every refusal; the next step or the
      end; `request.step_pending` naming the approvers, `request.decided`.
- [x] T006 Rate card and rule set approvals folded into requests (proposals with a preview, applied at approval, the
      old approve routes answer 409 with the request); policy changes as requests.
- [x] T007 Reservations: at approval, `POST /api/reservations`, release, consumption by matched cost, release at
      month end; Overview and Budgets subtract them.
- [x] T008 Deadlines in business hours, escalation and expiry (the `expire` job); `budget.at_risk` (the `evaluate`
      job); `request.applied`.
- [x] T009 Auditor read-only: a test that tries every write as an auditor.
- [x] T010 The weekly exceptions report: route, job, tests.
- [x] T011 Identity: SCIM 2.0 after Clickland's, tokens and `pnpm scim:token`, deactivation ends sessions, groups decide
      roles per request; Clickland's conformance suite.
- [x] T012 MCP: `list_requests`, `get_request`, `create_request`, `reserve`; no decide tool (a test lists the tools).
- [x] T013 Console: Approvals, Request, Rates and rules (proposals with preview, policies), Audit log, reservations on
      Overview and Budgets; component tests.
- [x] T014 Live: an infra change for +USD 1,840 a month on ENG-PLATFORM approved by the budget owner and Finance,
      signed in through Landbright in a visible Chrome; the requester refused; screenshots at 390 and 1440 px.
- [x] T015 Docs: `docs/approvals.md`, `docs/identity.md`, the references, limitations and roadmap, history.

*Done 2026-11-14.* Deviations: migrations are 0009 (identity) and 0010 (requests); the console has no form to raise an
infra, AI budget or seat request (they come from Landflow, MCP or the API: the live request was raised from Tal's
signed-in session through the API); the rate card proposal in the live screenshots is previewed, not raised.
