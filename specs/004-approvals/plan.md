# Plan 004: Approvals

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-14

## Technical context

| Project | What it gains |
|---|---|
| `libs/contracts` | `requests.ts`: requests, steps, decisions, reservations, policies, proposals, the exceptions report, webhook payloads (pushed first, commit acf95c6) |
| `libs/schema` | `0010_requests.sql`: `requests`, `request_steps`, `evidence_snapshots`, `decisions`, `policies`, `reservations`, `budget_alerts`; forward-only and append-only triggers; the four-eyes checks in the database. `0009_identity.sql`: SCIM's columns on `users`, `scim_groups`, `scim_group_members`, `scim_tokens` |
| `apps/api` | `requests.ts` (raise, path, decide, escalate, apply), `policies.ts`, `reservations.ts`, `evidence.ts`, `exceptions.ts`, `proposals.ts` (rate card and rule set with preview), `scim.ts` (after Clickland's), `identity.ts` (effective groups, roles per request), the `expire` and `evaluate` jobs, MCP tools, `cli.ts scim-token` |
| `apps/console` | `routes/approvals.tsx`, `request.tsx`, `rules.tsx` (proposals with preview, policies), `audit.tsx`; Overview and Budgets show reservations; the bottom bar counts what waits on you |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| 1. Agents request; people decide | PASS | A decision's person is a user of kind person, checked in the API and by a trigger; relays name a person Landledger checks; no MCP decide tool; tests try each way an agent or key could decide. |
| 2. Estimated or invoiced | PASS | Evidence and reservations compare against the month's estimated actuals, labelled; a request's amount is labelled an estimate (usage × rate card or the requester's figure). |
| 3. Money is exact | PASS | Amounts as strings into `Money` (micro-units); thresholds compared exactly; reservations in micros. |
| 4. Nothing is edited | PASS | Decisions, evidence snapshots and policies' definitions append only; requests, steps and reservations move forward only (triggers); every change in the audit log in the same transaction. |
| 5. Nobody depends on it | PASS | Landflow waits on webhooks; if Landledger is down a flow waits and nothing breaks. |
| 6. Local only | PASS | Postgres in `landledger-infra`; the live run against the local Landbright. |
| 7. Spec-driven | PASS | This spec; the contract pushed before the code. |

## Design

- **The path** is fixed when a request is submitted: the policy for (kind, cost center), else (kind, any); its steps
  that apply to the threshold amount and the cost center's state, in order. Below `automaticBelow` (and no step that
  always applies) it is approved by policy at once, with no decision (`automatic: true`, audited as the system).
- **Who may decide a step**: the cost center's owner when the step says so and the owner is a known person, else any
  active person in one of the step's groups (SCIM memberships, or the sign-in claim before SCIM spoke); never the
  requester, the sponsor, someone who decided an earlier step, or a rate card's or rule set's proposer and line
  authors. The API checks it and the database checks the person-shaped parts again (`decisions_guard`).
- **Evidence**: `GET /api/requests/:id` computes Landledger's evidence and hashes `{ request, evidence }` (canonical
  JSON); the snapshot is stored once per hash. A decision must name a stored snapshot of its request.
- **Business hours**: whole days Monday to Friday (UTC) by default, 24 hours each; a deadline counts only those hours.
- **Applying**: rate card, rule set and policy changes apply in the transaction that approves the last step (the
  version's `approved_by` is the last step's person, so 0005's trigger still holds); then repricing or a rebuild runs.
  Other kinds wait for `POST /api/requests/:id/applied` from Landflow.
- **Reservations**: one per month of the window (the start month; open-ended monthly: three months), consumed by the
  direct layer's lines of that cost center and month that match the request's `match` selector from its start day;
  released when the month has ended. Overview and Budgets subtract the remaining.
- **SCIM** follows Clickland's `scim.ts` (it passed Landbright's real pushes): ids `usr_…` are SCIM ids; `subject` is
  `externalId`; groups in `scim_groups` with members; `scim_groups_at` makes memberships decide the roles.
