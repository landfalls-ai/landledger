# API reference

The API listens on `http://127.0.0.1:4810`; the console proxies `/api` to it. Errors are
`{ "error": { "code", "message", "details"? } }` with codes `bad_request` 400, `unauthorized` 401, `forbidden` 403,
`not_found` 404, `conflict` 409, `unavailable` 503, `internal` 500.

**Who is calling**: an API key (`Authorization: Bearer ll_…`), else the console's session cookie (`ll_session`), else,
with `LANDLEDGER_DEV_AUTH=on` on loopback only, the local developer (a controller). A person's scopes come from their
roles: cfo and controller `read`, `requests:write`, `admin`; fpa, budget_owner and engineer `read`, `requests:write`;
auditor `read`. `admin` includes every scope.

| Route | Needs | Does |
|---|---|---|
| `GET /api/health` | nothing | `{ status, postgres, migrations, version }`; 503 when Postgres is down |
| `GET /api/auth/login?returnTo=/path` | nothing | Starts sign-in with Landbright (PKCE S256, nonce, state); redirects |
| `GET /api/auth/oidc/callback` | the login cookie | Finishes sign-in: a session cookie and back to `returnTo`, or `/?signin_error=…` (`no_role` when no group maps to a role) |
| `POST /api/auth/logout` | a session | Ends the session; `{ redirect }` to Landbright's end-session |
| `GET /api/auth/me` | nothing | Who you are and your scopes; 401 with `details.signIn` (`available` or `unavailable`) |
| `GET /api/cost-centers`, `/api/teams`, `/api/products` | `read` | The dimensions in effect `?on=YYYY-MM-DD` (today by default) |
| `GET /api/rate-cards`, `/api/rate-cards/:id` | `read` | Rate cards with their versions (`proposed` or `approved`) and lines; `current` is the approved version in effect `?on=` |
| `GET /api/periods` | `read` | Every month known to the ledger, newest first: `{ month, status, openedAt, closingBy, closingAt, lockedBy, lockedAt }` |
| `POST /api/periods/:month/close` | `admin`, a person (controller or CFO) | `open → closing`; 409 from any other state; an API key gets 403 |
| `POST /api/periods/:month/lock` `{ override?: { reason } }` | `admin`, a person (controller or CFO; the override: a controller) | `closing → locked`, final; earlier months must be locked first; an API key gets 403. 409 with `details.problems` unless the month is whole: ended, a complete run for every source-day since the source's first data, no provisional rows, every record allocated. A controller's override with a reason locks anyway, audited (`period.locked` with `checks: overridden`, the problems and the reason) |
| `GET /api/records` | `read` | Cost records under FOCUS names, amounts as decimal strings. `?month=YYYY-MM&basis=&source=&sourceKey=&limit=1..1000&after=<next>`; `{ records, next }` |
| `GET /api/audit?limit=&before=` | `read` | The audit log, newest first, with each entry's hash and the one before |
| `GET /api/audit/verify` | `read` | Walks the hash chain and compares it with the last anchor: `{ ok, checked, head, brokenAt, reason, anchor: { seq, hash, at } \| null, truncated }`; `truncated` when the log ends before the anchored entry |
| `GET /api/keys`, `POST /api/keys`, `DELETE /api/keys/:id` | `admin` | API keys `ll_…`: shown once at creation, stored as sha256, scopes `read`, `requests:write`, `reservations:write`, `decisions:relay`, `ingest`, `admin` |
| `GET /api/ingest/runs?source=&limit=` | `read` | Ingest runs, newest first: source, kind, day, provisional, counts (read, new, corrected, unchanged), warnings, error, the window observed ([ingest.md](../ingest.md)) |
| `POST /api/ingest/run` `{ source?: landflow\|clickland\|all, day?, force?, reason? }` | `ingest` (`force`: a person) | Runs a day now (today goes to the provisional table); 201 with the runs; 503 when no source is configured. A run whose source answers with nothing for a day the ledger has entries for fails unless `force` with a `reason` (audited `ingest.forced`) |
| `POST /api/rate-cards/versions/:id/ai-lines` | `admin`, a signed-in person | Adds the AI lines from Landflow's price table to a proposed version, as their author (who then can't approve it); 409 on an approved one; an API key or the local developer gets 403; `{ added }` |
| `POST /api/rate-cards/versions/:id/approve` | `admin`, a person (controller or CFO) who neither proposed it nor added a line | Approves and ends the version before it, then re-reads every day from its effective date (`repriced: { runs, failed, corrected, added }`); refused with no lines or in a closing or locked month; an API key gets 403 ([rate-cards.md](../rate-cards.md)) |
| `GET /api/allocation/rule-sets` | `read` | Rule set versions with their rules, share rules, status, proposer and approver |
| `POST /api/allocation/rule-sets/versions/:id/approve` | `admin`, a person (controller or CFO) who did not propose it | Approves and rebuilds every open month into a new generation ([allocation.md](../allocation.md)) |
| `POST /api/allocation/rebuild/:month` | `admin`, a person | A new allocation generation for an open month; 409 for a closing or locked one |
| `GET /api/budgets?month=` | `read` | Budget, actual, reserved, available, forecast, variance and state per cost center, with totals and the import in effect ([spend.md](../spend.md)) |
| `POST /api/budgets/import` `{ csv, fileName?, note? }` | `admin`, a person (controller or CFO) | Imports a budget CSV as a new version; 400 with every problem and nothing imported when the file is bad |
| `GET /api/overview?month=` | `read` | Month to date, forecast with its range, budget, left after reservations, the daily burn, cost centers with states, split by category and P&L class, attribution, the rate card and last runs |
| `GET /api/spend?by=&month=\|from=&to=&filter=&layer=direct\|spread&provisional=` | `read` | Groups by a dimension with estimated, invoiced, total, share, the window before, the provisional part, the drill target and a Clickland link; the daily series |
| `GET /api/spend/export?format=csv\|xlsx&…` | `read` | The same query as a file: CSV (groups) or XLSX (groups and daily) |
| `POST /api/mcp` | `read` | MCP over stateless Streamable HTTP: `spend_by`, `budget_status`; `GET` and `DELETE` answer 405 |
| `GET /api/webhooks`, `POST /api/webhooks`, `DELETE /api/webhooks/:id` | `admin` | Webhook subscriptions (Standard Webhooks signatures) |
| `GET /api/webhooks/:id/deliveries`, `POST /api/webhooks/:id/ping` | `admin` | The outbox for one webhook; queue a `ping` |

## Wave 2: requests, policies, decisions, reservations (spec 004)

The schemas are in `libs/contracts/src/requests.ts`; the feature page is [approvals.md](../approvals.md). Money in a
request is `{ "amount": "1840.00", "currency": "USD" }` (a string, at most six decimals); read views carry six-decimal
strings in USD. **Agents request; people decide**: a key or an agent can raise a request (an agent always with a
sponsor, a person), but a decision is a person's, from their session or relayed by a `decisions:relay` key naming them.

| Route | Needs | Does |
|---|---|---|
| `GET /api/requests?box=waiting\|mine\|decided\|open\|all&status=&kind=&costCenter=&limit=` | `read` | `{ requests: RequestSummary[], counts: { waiting, mine, decided, open } }`, newest first. `waiting`: a step pending on the caller; `mine`: raised or sponsored by the caller |
| `POST /api/requests` `CreateRequestInput` | `requests:write` | Raises a request: kinds `infra_change`, `ai_budget`, `tool_or_seat`, `other`. A person's session is the requester; a key or MCP must send `requester` (`{ kind: "person", person: { sub \| email } }` or `{ kind: "agent", agent: { id, name, system }, sponsor: { sub \| email } }`, each a known, active person) and `origin`. `submit: false` keeps a draft. Below the policy's `automaticBelow` it is approved at once (`automatic: true`) and reserved. `201 { request }`; a repeated `idempotencyKey` from the same caller returns the first (`200`). Audited `request.created`; webhook `request.created`, then `request.step_pending` |
| `GET /api/requests/:id` | `read` | `{ request, evidence, evidenceSha256 }`: the request with its steps (approvers named), decisions and reservations; Landledger's evidence (budget, actual, reserved, left now and after, forecast now and with, the rate card, similar requests, why this path); and the sha256 of that snapshot, which is kept (`GET …/evidence/:sha256`) so a decision can name what was shown |
| `GET /api/requests/:id/evidence/:sha256` | `read` | The stored snapshot a decision names, as it was shown |
| `POST /api/requests/:id/submit` | the requester (or sponsor) | `draft → pending` (or approved at once below the threshold) |
| `POST /api/requests/:id/cancel` `{ reason? }` | the requester, the sponsor, or `admin` | `draft \| pending → cancelled`; webhook `request.decided` (`cancelled`) |
| `POST /api/requests/:id/decisions` `DecisionInput` | a signed-in person; or a key with `decisions:relay` and `person: { sub \| email }` | Records a decision on the pending step: `outcome` `approve` or `reject` (a `comment` is required to reject), `evidenceSha256` of the snapshot shown (it must be one Landledger served for this request), optional `step` (409 if the request moved on), `channel` for a relay. Refused (403) for: the requester, the agent's sponsor, anyone who decided an earlier step, a rate card's or rule set's proposer and line authors, someone not among the step's approvers (the cost center's owner, or members of its Landbright groups), an inactive or unknown person, a system actor, an API key without `decisions:relay`, a relay without `person`, the local developer. `201 { request, decision }`. Approving the last step approves the request, reserves its months, and applies a rate card, rule set or policy change at once; webhooks `request.step_pending` (next step) or `request.decided` |
| `GET /api/requests/:id/decisions` | `read` | `{ decisions }`, oldest first, each with its evidence hash |
| `POST /api/requests/:id/applied` `{ note?, links? }` | `requests:write` | `approved → applied`, for the kinds Landflow applies (infra, AI budget, tool or seat, other); webhook `request.applied` |
| `GET /api/reservations?month=&costCenter=&status=` | `read` | `{ reservations }`: reserved, consumed or released, with amount, consumed and remaining |
| `POST /api/reservations` `{ requestId, month?, amount? }` | `reservations:write` | Reserves another month of an approved request's window (at most its monthly or one-off amount); idempotent per month. `201` (or `200` when it exists) |
| `POST /api/reservations/:id/release` `{ reason? }` | `reservations:write` | `reserved → released` |
| `GET /api/policies` | `read` | `{ policies }`: every version, `current` marking those in effect, with their thresholds and steps |
| `POST /api/policies` `{ policy, title?, note? }` | `requests:write`, a person | Proposes a policy version and raises its `policy_change` request (Finance, then the CFO); approval puts it in effect. `201 { request, versionId }` |
| `POST /api/rate-cards/proposals/preview` `{ effectiveFrom, changes: [{ skuPriceId, unitPrice }] }` | `read` | `ProposalPreview`: the open month as booked now against the same usage at the proposed prices, per cost center and per changed line |
| `POST /api/rate-cards/proposals` `{ effectiveFrom, changes, title?, note? }` | `requests:write`, a person | A new rate card version (the version in effect with the changed prices; every line authored by the proposer) and its `rate_card_change` request. `201 { request, versionId, preview }` |
| `POST /api/allocation/rule-sets/proposals/preview` `{ effectiveFrom, rules, shares? }` | `read` | `ProposalPreview`: the open month allocated by the rules in effect against the proposed ones, per cost center and per rule |
| `POST /api/allocation/rule-sets/proposals` `{ effectiveFrom, rules, shares?, title?, note? }` | `requests:write`, a person | A new rule set version and its `rule_set_change` request. `201 { request, versionId, preview }` |
| `POST /api/rate-cards/versions/:id/approve`, `POST /api/allocation/rule-sets/versions/:id/approve` | — | Folded into requests: `409` with `details.requestId`, the version's request (raised now if it had none); decide it with `POST /api/requests/:id/decisions` |
| `GET /api/exceptions?month=\|from=&to=` | `read` | The weekly exceptions report: per cost center and month, actual spend (direct layer) less what approved or applied requests cover, listed when above the automatic threshold; the shared pool and Unallocated apart (`unowned`) |
| `GET /api/scim/tokens`, `POST /api/scim/tokens` `{ name }`, `DELETE /api/scim/tokens/:id` | `admin`, a person | SCIM bearer tokens `lls_…`, shown once, stored as sha256 (`pnpm scim:token` writes one to `~/.config/land-family/landledger-scim.env`) |

`GET /api/overview` and `GET /api/budgets` now count reservations: `reserved` per cost center and in total, and
`leftAfterReservations` = budget − actuals − reservations' remaining.

### Policies (the decided defaults)

The threshold amount is the monthly amount of a recurring request, or the one-off amount.

| Kind | Automatic | Budget owner | Finance (`Finance Controllers` or `Finance CFO`) | CFO (`Finance CFO`) |
|---|---|---|---|---|
| `infra_change`, `ai_budget`, `other` | under USD 500 | 500 and above (the cost center's owner, else `Budget Owners`) | above 5,000, or the cost center is at risk or over, or this request takes it over budget | above 25,000 |
| `tool_or_seat` | never | always | as above | above 25,000 |
| `rate_card_change`, `rule_set_change`, `policy_change` | never | — | always | always |

A step waits on its approvers for `LANDLEDGER_STEP_DEADLINE_HOURS` business hours (24; business days
`LANDLEDGER_BUSINESS_DAYS`, Monday to Friday), then escalates to its `escalateTo` groups (the CFO by default) with a new
deadline and a new `request.step_pending`; when that passes too the request is `expired`.

### MCP

`POST /api/mcp` adds `list_requests`, `get_request`, `create_request` (an agent with a sponsor, or the signed-in
person; needs `requests:write`) and `reserve` (needs `reservations:write`). There is no tool that decides.

### SCIM 2.0 (`/scim/v2`, for Landbright's push)

Bearer `lls_…` only (never a cookie or the dev bypass). `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`;
`/Users` and `/Groups` with `eq` filters, `POST`, `GET`, `PUT`, `PATCH` (the forms Landbright sends, including a user's
`groups` replace) and `DELETE`; RFC 7644 errors. Deactivating a person (`active: false`, or `DELETE`) ends their
sessions at once; group membership decides their roles on the next request. Details in [identity.md](../identity.md).

## Webhook events

Standard Webhooks, from the outbox; subscriptions are managed by an admin (`/api/webhooks`). Each body is
`{ type, timestamp, data }`.

| Event | When | `data` |
|---|---|---|
| `ping` | `POST /api/webhooks/:id/ping` | `{ webhookId }` |
| `request.created` | a request is submitted (or raised and submitted at once) | `{ request: RequestSummary }` |
| `request.step_pending` | a step starts waiting on its approvers, or escalates | `StepPendingData`: the request, the step (groups, deadline, `escalated`), `approvers` (each person's name, email and Landbright `sub`), the console `url` and the `evidenceSha256` to relay with |
| `request.decided` | a request ends: approved, rejected, cancelled or expired | `RequestDecidedData`: the request, the outcome, the decision that ended it, its reservations |
| `request.applied` | the change is in place (Landledger's own kinds at approval; the others when Landflow says so) | `{ request: RequestSummary, note, links }` |
| `budget.at_risk` | a cost center crosses into at risk or over in a month (once per month and state) | `BudgetAtRiskData` |
| `period.closing` | a month starts closing | `{ month }` |
| `audit.anchor` | every `LANDLEDGER_AUDIT_ANCHOR_MINUTES` | `{ seq, hash, at }`: keep them to prove later that no entry was cut off |
| `cost.anomaly` | wave 3 | |
