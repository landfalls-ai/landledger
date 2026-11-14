# API reference

The API listens on `http://127.0.0.1:4810`; the console proxies `/api` to it. Errors are
`{ "error": { "code", "message", "details"? } }` with codes `bad_request` 400, `unauthorized` 401, `forbidden` 403,
`not_found` 404, `conflict` 409, `unprocessable` 422, `unavailable` 503, `internal` 500.

**Who is calling**: an API key (`Authorization: Bearer ll_…`), else the console's session cookie (`ll_session`), else,
with `LANDLEDGER_DEV_AUTH=on` on loopback only, the local developer (a controller). A person's scopes come from their
roles: cfo and controller `read`, `requests:write`, `admin`; fpa, budget_owner and engineer `read`, `requests:write`;
auditor `read`. `admin` includes every scope. Key scopes: `read`, `requests:write`, `reservations:write`,
`decisions:relay`, `webhooks:write`, `ingest`, `admin`; a `decisions:relay` key holds neither `requests:write` nor
`admin`.

| Route | Needs | Does |
|---|---|---|
| `GET /api/health` | nothing | `{ status, postgres, migrations, version }`; 503 when Postgres is down |
| `GET /api/auth/login?returnTo=/path` | nothing | Starts sign-in with Landbright (PKCE S256, nonce, state); redirects |
| `GET /api/auth/oidc/callback` | the login cookie | Finishes sign-in: a session cookie and back to `returnTo`, or `/?signin_error=…` (`no_role` when no group maps to a role) |
| `POST /api/auth/logout` | a session | Ends the session; `{ redirect }` to Landbright's end-session |
| `POST /api/auth/backchannel-logout` (form `logout_token`) | a logout token signed by Landbright | OIDC Back-Channel Logout 1.0: verifies the token (signature from Landbright's JWKS, `iss`, `aud`, `iat`, `jti` once, the back-channel event, no `nonce`) and ends every session of its `sub`; `200` with no body (also for a retry of a verified token whose `jti` was already processed: nothing more ends, audited `auth.backchannel_logout_replay`), `400` `{ error: "invalid_request" }` otherwise. Register `http://localhost:4811/api/auth/backchannel-logout` (through the console) or `http://127.0.0.1:4810/api/auth/backchannel-logout` |
| `GET /api/auth/me` | nothing | Who you are and your scopes; 401 with `details.signIn` (`available` or `unavailable`) |
| `GET /api/cost-centers`, `/api/teams`, `/api/products` | `read` | The dimensions in effect `?on=YYYY-MM-DD` (today by default) |
| `GET /api/rate-cards`, `/api/rate-cards/:id` | `read` | Rate cards with their versions (`proposed` or `approved`) and lines; `current` is the approved version in effect `?on=` |
| `GET /api/periods` | `read` | Every month known to the ledger, newest first: `{ month, status, openedAt, closingBy, closingAt, lockedBy, lockedAt }` |
| `POST /api/periods/:month/close` | `admin`, a person (controller or CFO) | `open → closing`; 409 from any other state; an API key gets 403 |
| `POST /api/periods/:month/lock` `{ override?: { reason } }` | `admin`, a person (controller or CFO; the override: a controller) | `closing → locked`, final; earlier months must be locked first; an API key gets 403. 409 with `details.problems` unless the month is whole: ended, a complete run for every source-day since the source's first data, no provisional rows, every record allocated. A controller's override with a reason locks anyway, audited (`period.locked` with `checks: overridden`, the problems and the reason) |
| `GET /api/records` | `read` | Cost records under FOCUS names, amounts as decimal strings. `?month=YYYY-MM&basis=&source=&sourceKey=&limit=1..1000&after=<next>`; `{ records, next }` |
| `GET /api/audit?limit=&before=` | `read` | The audit log, newest first, with each entry's hash and the one before |
| `GET /api/audit/verify` | `read` | Walks the hash chain and compares it with the last anchor: `{ ok, checked, head, brokenAt, reason, anchor: { seq, hash, at } \| null, truncated }`; `truncated` when the log ends before the anchored entry |
| `GET /api/keys`, `POST /api/keys` `{ name, scopes, boundWorkflowIds? }`, `DELETE /api/keys/:id` | `admin`; minting: a signed-in person with `admin` | API keys `ll_…`: shown once at creation, stored as sha256. Only a signed-in admin person mints one (never a key or the local developer; the bootstrap key only until the first admin person has signed in: the first admin is a Landbright account in `Finance Controllers` or `Finance CFO`). A `decisions:relay` key may not also hold `requests:write` or `admin` (400). `boundWorkflowIds`: the Landflow workflows whose `landflow_run` origins it vouches for. Minting, revoking and their scopes are audited (`api_key.created`, `api_key.revoked`) |
| `GET /api/ingest/runs?source=&limit=` | `read` | Ingest runs, newest first: source, kind, day, provisional, counts (read, new, corrected, unchanged), warnings, error, the window observed ([ingest.md](../ingest.md)) |
| `POST /api/ingest/run` `{ source?: landflow\|clickland\|all, day?, force?, reason? }` | `ingest` (`force`: a person) | Runs a day now (today goes to the provisional table); 201 with the runs; 503 when no source is configured. A run whose source answers with nothing for a day the ledger has entries for fails unless `force` with a `reason` (audited `ingest.forced`) |
| `POST /api/rate-cards/versions/:id/ai-lines` | `admin`, a signed-in person | Adds the AI lines from Landflow's price table to a proposed version, as their author (who then can't approve it); 409 on an approved one, or once a request exists for the version (its lines are frozen); an API key or the local developer gets 403; `{ added }` |
| `POST /api/rate-cards/versions/:id/approve` | `admin`, a person (controller or CFO) who neither proposed it nor added a line | Approves and ends the version before it, then re-reads every day from its effective date (`repriced: { runs, failed, corrected, added }`); refused with no lines or in a closing or locked month; an API key gets 403 ([rate-cards.md](../rate-cards.md)) |
| `GET /api/allocation/rule-sets` | `read` | Rule set versions with their rules, share rules, status, proposer and approver |
| `POST /api/allocation/rule-sets/versions/:id/approve` | `admin`, a person (controller or CFO) who did not propose it | Approves and rebuilds every open month into a new generation ([allocation.md](../allocation.md)) |
| `POST /api/allocation/rebuild/:month` | `admin`, a person | A new allocation generation for an open month; 409 for a closing or locked one |
| `GET /api/budgets?month=` | `read` | Budget, actual, reserved, available, forecast, variance and state per cost center, with totals and the import in effect ([spend.md](../spend.md)) |
| `POST /api/budgets/import` `{ csv, fileName?, note? }` | `admin`, a person (controller or CFO) | Imports a budget CSV as a new version; 400 with every problem and nothing imported when the file is bad |
| `GET /api/overview?month=` | `read` | Month to date, forecast with its P10–P90 band (`p10`, `p50`, `p90`, `band`) and what is `committed` beyond reservations (wave 3), budget, left after reservations, the daily burn, cost centers with states, split by category and P&L class, attribution, the rate card and last runs |
| `GET /api/spend?by=&month=\|from=&to=&filter=&layer=direct\|spread&provisional=` | `read` | Groups by a dimension with estimated, invoiced, total, share, the window before, the provisional part, the drill target and a Clickland link; the daily series |
| `GET /api/spend/export?format=csv\|xlsx&…` | `read` | The same query as a file: CSV (groups) or XLSX (groups and daily) |
| `POST /api/mcp` | `read` | MCP over stateless Streamable HTTP: `spend_by`, `budget_status`; `GET` and `DELETE` answer 405 |
| `GET /api/webhooks`, `POST /api/webhooks`, `DELETE /api/webhooks/:id` | `webhooks:write` (its own) or an admin person (all) | Webhook subscriptions (Standard Webhooks signatures). A `webhooks:write` key lists and deletes only the subscriptions it created (`createdByKey`); the signing secret is returned once, to its creator, and never listed |
| `GET /api/webhooks/:id/deliveries`, `POST /api/webhooks/:id/ping` | `webhooks:write` (its own) or an admin person | The outbox for one webhook; queue a `ping` |

## Wave 2: requests, policies, decisions, reservations (spec 004)

The schemas are in `libs/contracts/src/requests.ts`; the feature page is [approvals.md](../approvals.md). Money in a
request is `{ "amount": "1840.00", "currency": "USD" }` (a string, at most six decimals); read views carry six-decimal
strings in USD. **Agents request; people decide**: a key or an agent can raise a request (an agent always with a
sponsor, a person), but a decision is a person's, from their session or a relay channel press Landledger verifies
itself (below). A key never names who decided.

| Route | Needs | Does |
|---|---|---|
| `GET /api/requests?box=waiting\|mine\|decided\|open\|all\|confirm&status=&kind=&costCenter=&limit=` | `read` | `{ requests: RequestSummary[], counts: { waiting, mine, decided, open, confirm } }`, newest first. `waiting`: a step pending on the caller; `mine`: raised or sponsored by the caller (or created by the calling key); `confirm`: waiting on the caller's confirmation |
| `POST /api/requests` `CreateRequestInput` | `requests:write` | Raises a request: kinds `infra_change`, `ai_budget`, `tool_or_seat`, `contract`, `other`. A `contract` request carries `contract` (vendor, product, `tcv`, `termMonths`, `start`, seats…): its amount is the TCV, `once`; it reserves no money, and approval records the contract. A `tool_or_seat` request may carry `seat` (`contractId`, `seats`, `seatPrice`): its amount is seats × seat price, `monthly`; approval reserves the seats on the contract (400 when the terms don't add up) ([contracts.md](../contracts.md)). A person's session is the requester; a key or MCP must send `requester` (`{ kind: "person", person: { sub \| email } }` or `{ kind: "agent", agent: { id, name, system }, sponsor: { sub \| email } }`, each a known, active person) and `origin`. **A key naming a person** (requester, or the agent's sponsor) puts it in `awaiting_confirmation`: webhook `request.needs_confirmation`, and it enters the policy only when that person confirms it from their own session (a person's own session skips this). Every request carries `createdBy` (`{ kind: "key" \| "person", id, name }`, stamped by Landledger) and `origin.verified` (true for `console`, `mcp`, or a `landflow_run` whose workflow the key is bound to; false for anything else a key says). `submit: false` keeps a draft. Below the policy's `automaticBelow`, counting what was approved by policy on the cost center this month (and for an AI budget, for the agent), and never while the cost center is at risk or over, it is approved at once (`automatic: true`) and reserved. Only USD: another currency is `422` "Only USD until FX is set up". `201 { request }`; a repeated `idempotencyKey` from the same caller with the same body returns the first (`200`), with a different body `409`. Audited `request.created`; webhook `request.created`, then `request.step_pending` |
| `GET /api/requests/:id` | `read` | `{ request, evidence, evidenceSha256, servedAt }`: the request with its steps (approvers named), decisions and reservations; Landledger's evidence (budget, actual, reserved, left now and after, forecast now and with, the first full month, the commitment per year, `budgetMissing` (why a month with no budget sends it to Finance, decision 8), `committed`, for an AI budget request `agentEconomics` (its agent's cost per outcome and what the raise buys), and for a seat request `seat` (the contract's seats paid, used, reserved, left now and after, and a note when none is left) (wave 3), what policy approved this month, the rate card and a rate card change's frozen lines hash, similar requests, why this path); and the sha256 of that snapshot, which is kept (`GET …/evidence/:sha256`), with who it was served to and when, so a decision can name what was shown |
| `GET /api/requests/:id/evidence-pack?format=json\|html` | `read` | `EvidencePack`: the request, every snapshot served (to whom, when), the decisions, the request's audit entries and the chain checked from them to the head and the last anchor; `html` is a printable page |
| `POST /api/requests/:id/confirm` `{ comment? }`, `POST /api/requests/:id/decline` `{ reason }` | the named person, in their own session | `awaiting_confirmation → pending` (or approved by policy), or `→ cancelled` with the reason. A key, another person or the local developer gets 403 |
| `GET /api/requests/:id/evidence/:sha256` | `read` | The stored snapshot a decision names, as it was shown |
| `POST /api/requests/:id/submit` | the requester (or sponsor) | `draft → pending` (or approved at once below the threshold) |
| `POST /api/requests/:id/cancel` `{ reason? }` | the requester, the sponsor, the creating key, or an admin person | `draft \| awaiting_confirmation \| pending → cancelled`; webhook `request.decided` (`cancelled`) |
| `POST /api/requests/:id/decisions` `DecisionInput` | a signed-in person | Records a decision on the pending step: `outcome` `approve` or `reject` (a `comment` is required to reject), `evidenceSha256` of a snapshot Landledger served **to this person within the last 30 minutes** at this step (else `409` "The request changed or the evidence is stale; reopen it"), optional `step` (409 if the request moved on). Refused after the step's deadline (409; the escalation job may lag). Refused (403) for: the requester, the agent's sponsor, anyone who decided an earlier step, a rate card's or rule set's proposer and line authors, someone not among the step's approvers (the cost center's owner and deputies, or members of its Landbright groups), a service-like account, an inactive or unknown person, a system actor, **any API key** (relays go through `POST /api/relays/slack`), the local developer. `201 { request, decision }`. Approving the last step approves the request, reserves its months, and applies a rate card, rule set or policy change at once; webhooks `request.step_pending` (next step) or `request.decided` |
| `POST /api/relays/slack` `SlackRelayInput` `{ channelId?, body, signature, timestamp }` | a key with `decisions:relay` | The raw Slack interaction as Slack sent it, with `X-Slack-Signature` and `X-Slack-Request-Timestamp`. Landledger verifies the signature with the channel's signing secret, the timestamp (5 minutes), the team and the app; reads the press (button `landledger.approve` / `landledger.reject` with value `ll1\|<requestId>\|<step>\|<evidenceSha256>`, or the reject modal's `view_submission`, `callback_id` `landledger.reject`, the value in `private_metadata`, the comment in `state.values.comment.comment`); maps the Slack user to the person who linked it; and decides as them. Refused: a bad or old signature, another team or app (401); an unlinked user, a person who is neither SCIM-managed nor signed in within 7 days, a step other than the budget owner's of an infra change, AI budget, tool or seat, or other request (Finance, the CFO, rate card, rule set and policy changes never), plus every refusal of a decision (403); a card hash not served within 30 minutes (409). `201 { request, decision }`; webhook `decision.relayed` naming the person; audited and shown as relayed |
| `GET /api/relay-channels`, `POST /api/relay-channels` `RelayChannelInput`, `DELETE /api/relay-channels/:id` | an admin person | Relay channels. Slack: `{ kind: "slack", name, signingSecret, teamId, appId }`; the secret is sealed at rest (`LANDLEDGER_SECRET_KEY`) and never shown again. Teams and email are reserved kinds, not implemented |
| `GET /api/me/links`, `POST /api/me/links` `{ kind: "slack", externalId }`, `DELETE /api/me/links/:id` | a person, in their own session | The caller's links to relay channel accounts (the console's profile page, Link Slack). One Slack id per person, and one person per Slack id; a key or another person never makes a link |
| `GET /api/cost-centers/:code/owners`, `PUT /api/cost-centers/:code/owners` `{ owner, deputies?, note? }` | `read`; `PUT`: an admin person | The cost center's owner (a person) and deputies, who decide its budget owner step. Without an owner the step falls back to `Budget Owners` and says so. When the owner is the requester or the sponsor (and no deputy can), the step goes straight to escalation: the next step's approvers, else Finance |
| `GET /api/requests/:id/decisions` | `read` | `{ decisions }`, oldest first, each with its evidence hash |
| `POST /api/requests/:id/applied` `{ note?, links? }` | `requests:write`: the creating key, the requester, or an admin person | `approved → applied`, for the kinds Landflow applies (infra, AI budget, tool or seat, other); a seat request's seats move from reserved to used; webhook `request.applied` |
| `GET /api/reservations?month=&costCenter=&status=` | `read` | `{ reservations }`: reserved, consumed or released, with amount, consumed and remaining |
| `POST /api/reservations` `{ requestId, month?, amount? }` | `reservations:write` | Reserves another month of an approved request's window (at most its monthly or one-off amount); idempotent per month. `201` (or `200` when it exists) |
| `POST /api/reservations/:id/release` `{ reason? }` | `reservations:write`: the key that created the request, the requester, or an admin person | `reserved → released` |
| `GET /api/policies` | `read` | `{ policies }`: every version, `current` marking those in effect, with their thresholds and steps |
| `POST /api/policies` `{ policy, title?, note? }` | `requests:write`, a person | Proposes a policy version and raises its `policy_change` request (Finance, then the CFO); approval puts it in effect. `201 { request, versionId }` |
| `POST /api/rate-cards/proposals/preview` `{ effectiveFrom, changes: [{ skuPriceId, unitPrice }] }` | `read` | `ProposalPreview`: the open month as booked now against the same usage at the proposed prices, per cost center and per changed line |
| `POST /api/rate-cards/proposals` `{ effectiveFrom, changes, title?, note? }` | `requests:write`, a person | A new rate card version (the version in effect with the changed prices; every line authored by the proposer) and its `rate_card_change` request. `201 { request, versionId, preview }` |
| `POST /api/allocation/rule-sets/proposals/preview` `{ effectiveFrom, rules, shares? }` | `read` | `ProposalPreview`: the open month allocated by the rules in effect against the proposed ones, per cost center and per rule |
| `POST /api/allocation/rule-sets/proposals` `{ effectiveFrom, rules, shares?, title?, note? }` | `requests:write`, a person | A new rule set version and its `rule_set_change` request. `201 { request, versionId, preview }` |
| `POST /api/rate-cards/versions/:id/approve`, `POST /api/allocation/rule-sets/versions/:id/approve` | `requests:write`, a signed-in person | Folded into requests: `409` with `details.requestId`, the version's request (raised now if it had none, audited as the caller); decide it with `POST /api/requests/:id/decisions`. `read` or an auditor gets 403 |
| `GET /api/exceptions?month=\|from=&to=` | `read` | The exceptions report: per cost center and month, uncovered = actual (direct layer) − budget − covered, where an approved or applied request covers only the cost its `match` selects (without a match, its cost center up to its amount); listed when above the automatic threshold; the shared pool and Unallocated apart (`unowned`) |
| `GET /api/exceptions/reports?limit=`, `GET /api/exceptions/reports/:id` | `read` | The stored weekly reports, each with its figures and sha256 (also in the audit log and webhook `report.exceptions`) |
| `GET /api/scim/tokens`, `POST /api/scim/tokens` `{ name }`, `DELETE /api/scim/tokens/:id` | `admin`, a person | SCIM bearer tokens `lls_…`, shown once, stored as sha256 (`pnpm scim:token` writes one to `~/.config/land-family/landledger-scim.env`) |

Once a request is approved, its evidence's "now" figures leave out its own reservation (so they read as they did when
it was decided). `request.step_pending`'s `url` is the console's `/requests/:id`, the same page as `/approvals/:id`.

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
`LANDLEDGER_BUSINESS_DAYS` in `LANDLEDGER_TZ`, less the holidays in `LANDLEDGER_HOLIDAYS_FILE`), then escalates to its
`escalateTo` groups (the CFO by default) with a new deadline and a new `request.step_pending`; when that passes too the
request is `expired`. A step nobody can decide when it starts (the owner raised it; the only approver decided an
earlier step) escalates at once: to the next step's groups, else the admin groups (`Finance Controllers`,
`Finance CFO`). A request awaiting confirmation expires after the same deadline.

### MCP

`POST /api/mcp` adds `list_requests`, `get_request`, `create_request` (an agent with a sponsor, or the signed-in
person; needs `requests:write`; its origin is always `mcp`, stamped with the key, never what the caller says) and
`reserve` (needs `reservations:write`). There is no tool that decides.

### SCIM 2.0 (`/scim/v2`, for Landbright's push)

Bearer `lls_…` only (never a cookie or the dev bypass). `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`;
`/Users` and `/Groups` with `eq` filters, `POST`, `GET`, `PUT`, `PATCH` (the forms Landbright sends, including a user's
`groups` replace) and `DELETE`; RFC 7644 errors. Deactivating a person (`active: false`, or `DELETE`) ends their
sessions at once; group membership decides their roles on the next request. Details in [identity.md](../identity.md).

## Wave 3: plan and reconcile (specs 005–011)

The schemas are in `libs/contracts/src/wave3.ts`. Amounts are six-decimal strings in USD.

| Route | Needs | Does |
|---|---|---|
| `POST /api/invoices/import` `{ csv, fileName?, note?, origin?: entered\|dev-fixture }` | `admin`, a person (controller or CFO) | Posts or corrects each invoice in the CSV ([invoices.md](../invoices.md)); 201 `{ invoices, reconciliation }`; 400 with `details.problems` (nothing imported); 422 for a non-USD line; a key gets 403 |
| `GET /api/invoices?month=`, `GET /api/invoices/:id` | `read` | Invoices at their newest version: lines, what the last import posted, `correction`, origin |
| `POST /api/invoices/:id/void` `{ reason }` | `admin`, a person (controller or CFO) | Reverses every live record of the invoice; a `voided` version; 409 if voided already |
| `GET /api/reconciliation?month=` | `read` | Per provider × model: estimated, invoiced, variance, variance %, status (`matched`, `outside`, `not_invoiced`, `no_estimate`), the invoices; totals with the share invoiced; the tolerance |
| `GET /api/requests/:id/lifecycle` | `read` | An approved request's stages (approved, reserved, consumed, invoiced), approved and actual to date, the variance; `null` before approval |
| `GET /api/anomalies?status=open\|all&kind=cost\|approval&limit=` | `read` | Anomalies, newest first; `open` (default) is the last 14 days' not acknowledged ([anomalies.md](../anomalies.md)) |
| `GET /api/anomalies/:id` | `read` | One anomaly: the rule, dimension and key, the figures (observed, median, MAD, score), the requests behind a pattern, who acknowledged it, `dev` |
| `POST /api/anomalies/:id/acknowledge` `{ note }` | `requests:write`, a person (not only an auditor) | Acknowledged once, audited; 409 after; a key gets 403 |
| `POST /api/anomalies/scan` | `admin` | What the hourly job does now: `{ cost, approval, checked }` |
| `GET /api/agents?month=` | `read` | Each AI agent's month ([agents.md](../agents.md)): cost (models, compute when attributable, invoiced), runs, outcomes and value from Clickland's Agent Value, cost and value per outcome, hours and capacity freed, cost center and owner, the suggestion (`keep`, `scale`, `review`, `retire`) and its rule; totals; `clickland.status` (`ok`, `unconfigured`, `unavailable`) |
| `GET /api/contracts` | `read` | Contracts at their newest version ([contracts.md](../contracts.md)): value, term, seats paid, used, reserved and left, seat price, renewal and notice dates, `inNoticeWindow` and `daysToNotice`; inside the notice window first (by notice date), then by renewal; totals; `windowDays` |
| `GET /api/contracts/:id` | `read` | One contract (`ContractView`) |
| `GET /api/contracts/seats?landbrightApp=` | `read` | The contract that grants a Landbright app, its seat price and seats left (`ContractSeats`), for Landflow's tool-or-seat flow; 404 when no contract names the app |
| `POST /api/contracts/import` `{ csv, fileName?, note?, origin?: entered\|dev-fixture }` | `admin`, a person (controller or CFO) | Imports contracts; the same vendor and product again is a new version; 201 `ContractsView`; 400 with `details.problems` (nothing imported); 422 for a non-USD line; a key gets 403 |
| `GET /api/forecast?months=12` (1–24) | `read` | The year ahead ([spend.md](../spend.md#the-year-ahead)): per month the run rate over its days with P10/P50/P90 (`null` without enough data), actual, reserved, committed (approved monthly requests beyond their reserved months), total, budget and state (`none` without a budget); annualised (run rate × 365 with its band, commitments × 12, Σ months, Σ budgets); the commitments. `status: insufficient` keeps _Not enough data yet_ |

## Webhook events

Standard Webhooks, from the outbox; subscriptions are managed by an admin (`/api/webhooks`). Each body is
`{ type, timestamp, data }`.

| Event | When | `data` |
|---|---|---|
| `ping` | `POST /api/webhooks/:id/ping` | `{ webhookId }` |
| `request.created` | a request is submitted (or raised and submitted at once) | `{ request: RequestSummary }` |
| `request.step_pending` | a step starts waiting on its approvers, or escalates | `StepPendingData`: the request, the step (groups, deadline, `escalated`), `approvers` (each person's name, email and Landbright `sub`), the console `url`, the `evidenceSha256` to put on the card (a relay cites it within 30 minutes) and `relayable` |
| `request.needs_confirmation` | a key raised a request naming a person (requester or sponsor) | `NeedsConfirmationData`: the request, the person, the key that raised it (`createdBy`), the console `url` |
| `decision.relayed` | a decision came through a relay channel | `DecisionRelayedData`: the request, the decision, the person (so they hear of it), the channel, the `url` |
| `report.exceptions` | the weekly exceptions report is stored | `ExceptionsReportData`: its id, sha256, months, row count and `url` |
| `request.decided` | a request ends: approved, rejected, cancelled or expired | `RequestDecidedData`: the request, the outcome, the decision that ended it, its reservations; a seat request's `request.seat` (contract, seats, price, `status`) |
| `request.applied` | the change is in place (Landledger's own kinds at approval; the others when Landflow says so) | `{ request: RequestSummary, note, links }` |
| `budget.at_risk` | a cost center crosses into at risk or over in a month (once per month and state) | `BudgetAtRiskData` |
| `period.closing` | a month starts closing | `{ month }` |
| `audit.anchor` | every `LANDLEDGER_AUDIT_ANCHOR_MINUTES` | `{ seq, hash, at }`: keep them to prove later that no entry was cut off |
| `cost.anomaly` | a cost per cost center, service, agent or model jumps against its 14-day baseline (once per key and day) | `{ anomaly: AnomalyView, url }` ([anomalies.md](../anomalies.md)) |
| `contract.renewal_due` | a contract enters its notice window (once per contract and renewal date; checked hourly) | `{ contract: ContractView, url }` ([contracts.md](../contracts.md#renewals)) |
| `approval.anomaly` | an approval pattern: a split, automatic approvals again and again, a decision relayed seconds after its card, one approver for one requester | `{ anomaly: AnomalyView, url }` |
