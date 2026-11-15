# API reference

The API listens on `http://127.0.0.1:4810`; the console proxies `/api` to it. Errors are
`{ "error": { "code", "message", "details"? } }` with codes `bad_request` 400, `unauthorized` 401, `forbidden` 403,
`not_found` 404, `conflict` 409, `unprocessable` 422, `unavailable` 503, `internal` 500.

**Who is calling**: an API key (`Authorization: Bearer ll_…`), else the console's session cookie (`ll_session`), else,
with `LANDLEDGER_DEV_AUTH=on` on loopback only, the local developer (a controller). A person's scopes come from their
roles: cfo and controller `read`, `requests:write`, `admin`; fpa, budget_owner and engineer `read`, `requests:write`;
auditor `read`. `admin` includes every scope. Key scopes: `read`, `requests:write`, `reservations:write`,
`decisions:relay`, `webhooks:write`, `ingest`, `admin`, and (wave 4) `notes:draft`; a `decisions:relay` key holds
neither `requests:write` nor `admin`. `notes:draft` submits variance note drafts and nothing else: no person's role
carries it, and nothing it holds accepts a note.

| Route | Needs | Does |
|---|---|---|
| `GET /api/health` | nothing | `{ status, postgres, migrations, version }`; 503 when Postgres is down |
| `GET /api/auth/login?returnTo=/path` | nothing | Starts sign-in with Landbright (PKCE S256, nonce, state); redirects |
| `GET /api/auth/oidc/callback` | the login cookie | Finishes sign-in: a session cookie and back to `returnTo`, or `/?signin_error=…` (`no_role` when no group maps to a role) |
| `POST /api/auth/logout` | a session | Ends the session; `{ redirect }` to Landbright's end-session |
| `POST /api/auth/backchannel-logout` (form `logout_token`) | a logout token signed by Landbright | OIDC Back-Channel Logout 1.0: verifies the token (signature from Landbright's JWKS, `iss`, `aud`, `iat`, the back-channel event, a `sub`, no `nonce`) and ends every session of its `sub` created before its `iat`; keeps the token's SHA-256 and `iat`; `200` with no body (a `jti` already processed also answers `200`, applies the same idempotent rule, and is audited `auth.backchannel_logout_replay`), `400` `{ error: "invalid_request" }` for a token that fails verification. Register `http://localhost:4811/api/auth/backchannel-logout` (through the console) or `http://127.0.0.1:4810/api/auth/backchannel-logout` |
| `GET /api/auth/me` | nothing | Who you are and your scopes; 401 with `details.signIn` (`available` or `unavailable`) |
| `GET /api/cost-centers`, `/api/teams`, `/api/products` | `read` | The dimensions in effect `?on=YYYY-MM-DD` (today by default) |
| `GET /api/rate-cards`, `/api/rate-cards/:id` | `read` | Rate cards with their versions (`proposed` or `approved`) and lines; `current` is the approved version in effect `?on=` |
| `GET /api/periods` | `read` | Every month known to the ledger, newest first: `{ month, status, openedAt, closingBy, closingAt, lockedBy, lockedAt }` |
| `POST /api/periods/:month/close` | `admin`, a person (controller or CFO) | `open → closing`; 409 from any other state; an API key gets 403 |
| `POST /api/periods/:month/lock` `LockSignInput` | `admin`, a person (controller or CFO) | Wave 4: the same as `POST /api/close/:month/lock`, a signature on a four-eyes lock (below). The wave 1 override is gone: a step that can't go green is explained on the close (audited), never overridden at the lock |
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
| `POST /api/invoices/import` `{ csv, fileName?, note?, origin?: entered\|dev-fixture }` | `admin`, a person (controller or CFO) | Posts or corrects each invoice in the CSV ([invoices.md](../invoices.md)); 201 `{ invoices, reconciliation }`; 400 with `details.problems` (nothing imported; a period not over in `LANDLEDGER_TZ` is one); 409 for an invoice already posted for another month (void it first); 422 for a non-USD line; a key gets 403; `dev-fixture` only on a development API (403 otherwise), counted in no total |
| `GET /api/invoices?month=`, `GET /api/invoices/:id` | `read` | Invoices at their newest version: lines, what the last import posted, `correction`, origin |
| `POST /api/invoices/:id/void` `{ reason }` | `admin`, a person (controller or CFO) | Reverses every live record of the invoice (in a locked month, its estimates come back in the open month); re-plans the provider's other live invoices for the month; a `voided` version; 409 if voided already; a `dev-fixture` invoice is voided on any API, not only a development one |
| `GET /api/reconciliation?month=` | `read` | Per provider × model: estimated, invoiced, variance, variance %, status (`matched`, `outside`, `not_invoiced`, `no_estimate`), the invoices, `lateEstimates` and `note` (estimates after invoice: re-reconcile), `devFixture`; totals (dev fixtures left out) with the share invoiced; the tolerance and its floor (`toleranceUsd`) |
| `GET /api/requests/:id/lifecycle` | `read` | An approved request's stages (approved, reserved, consumed above its baseline, the invoiced share of it), approved and actual to date, the variance; `null` before approval |
| `POST /api/requests/:id/seats/release` `{ reason: access_denied\|grant_revoked\|not_needed, note? }` | `requests:write`: the creating key, the requester (or sponsor), or an admin person | Gives a seat request's seats back to the contract and releases its reservations; an applied seat only with `grant_revoked`; audited and webhook `seat.released`; 409 when nothing is held ([contracts.md](../contracts.md#a-seat-tool-or-seat)) |
| `GET /api/anomalies?status=open\|all&kind=cost\|approval&limit=` | `read` | Anomalies, newest first; `open` (default) is every one not closed, however old ([anomalies.md](../anomalies.md)) |
| `GET /api/anomalies/:id` | `read` | One anomaly: the rule, dimension and key, the figures (observed, current and when, alerts, median, MAD, score), the requests behind a pattern, `status` (`open`, `acknowledged`, `closed`), who acknowledged it, the assignee, how it closed, the people it names (`named`), `dev` |
| `POST /api/anomalies/:id/acknowledge` `{ note }` | `requests:write`, a person (not only an auditor) | Acknowledged once, audited; 409 after; a key gets 403; 403 for a person the pattern names |
| `POST /api/anomalies/:id/assign` `{ assignee: { email } \| { id }, note }` | `requests:write`, a person (not only an auditor) | Assigns it to an active person (never one it names: 400), audited `anomaly.assigned`; 409 once closed |
| `POST /api/anomalies/:id/close` `{ outcome: expected\|fixed\|false_positive, note }` | `requests:write`, a person (not only an auditor) | Closes it once with the outcome, audited `anomaly.closed`; 409 after; 403 for a person the pattern names |
| `POST /api/anomalies/scan` | `admin` | What the hourly job does now: `{ cost, approval, checked }` |
| `GET /api/agents?month=` | `read` | Each AI agent's month ([agents.md](../agents.md)): cost (models, compute when attributable, invoiced), runs, outcomes and value from Clickland's Agent Value, cost and value per outcome, hours and capacity freed, cost center and owner, `measured`, outcomes labelled `self-reported`, the suggestion (`keep`, `scale`, `review`, `retire`, `not_measured`) and its rule; totals (measured outcomes only); `clickland.status` (`ok`, `unconfigured`, `unavailable`) |
| `GET /api/contracts` | `read` | Contracts at their newest version ([contracts.md](../contracts.md)): value, term, seats paid, used (`seatsUsedAsOf`), reserved and left, seat price, renewal, the notice date (last business day) and its calendar date, `inNoticeWindow` and `daysToNotice`, `covered`; inside the notice window first (by notice date), then by renewal; `held` (imports above $25,000 waiting as contract requests); totals (dev fixtures left out); `windowDays` |
| `GET /api/contracts/:id` | `read` | One contract (`ContractView`) |
| `GET /api/contracts/seats?landbrightApp=` | `read` | The contract that grants a Landbright app, its seat price and seats left (`ContractSeats`), for Landflow's tool-or-seat flow; 404 when no contract names the app |
| `POST /api/contracts/import` `{ csv, fileName?, note?, origin?: entered\|dev-fixture }` | `admin`, a person (controller or CFO) | Imports contracts (optional `seats_used_as_of`); the same vendor and product again is a new version; a new contract or a TCV raise above $25,000 is held as a pending contract request instead (`held`, audited `contract.import_held`); 201 `ContractsView`; 400 with `details.problems` (nothing imported); 422 for a non-USD line; a key gets 403; `dev-fixture` only on a development API |
| `GET /api/access-reviews` | `read` | Every access review, newest quarter first, with counts; the current `quarter`, whether its review is `due`, and the quarters `missed` ([access-review.md](../access-review.md)) |
| `GET /api/access-reviews/:id` | `read` | One review (anything granted since it opened joins first): each item (`person`, `key`, `link`, `session`, `relay_channel`, `webhook`, `owner`) with its snapshot, who it is `about`, `addedAt`, `cfoOnly`, its attestation, the `revocation` Landledger did, and whether a revoke is `outstanding`; counts with `outstanding` and `added` |
| `POST /api/access-reviews` | `admin`, a person (controller or CFO) | Opens this quarter's review with a snapshot of every item; 201; 409 when the quarter has one; a key gets 403 |
| `POST /api/access-reviews/:id/items/:itemId/attest` `{ decision: keep\|revoke, comment, confirm? }` | `admin`, a person (controller or CFO) | Keeps or revokes one item (a comment is required to revoke); never an item about yourself (403), a `cfoOnly` item only by the CFO; once (409). A key, link or session revoke needs `confirm: true` and is done at once; any other is tracked until gone. Completes when every item is attested and no revoke is outstanding; audited |
| `GET /api/forecast?months=12` (1–24) | `read` | The year ahead ([spend.md](../spend.md#the-year-ahead)): per month the run rate over its days with P10/P50/P90 (`null` without enough data), actual, reserved, committed (approved monthly requests beyond their reserved months), total, budget and state (`none` without a budget); contracted; reserved and committed net of what the run rate already projects; annualised over the next 12 months (run rate × 365 with its band, commitments bounded by their end dates, contracted, Σ months, Σ budgets); the commitments. The current month's total is Overview's forecast. `status: insufficient` keeps _Not enough data yet_ |

## Wave 4: month-end (specs 012–019)

The schemas are in `libs/contracts/src/wave4.ts`. Amounts are six-decimal strings in USD. **People close; agents
draft.** Every write below is a person's, signed in with Landbright (an API key or the local developer gets 403),
except a note draft, which is an agent's key with `notes:draft`.

| Route | Needs | Does |
|---|---|---|
| `GET /api/close?month=` | `read` | `CloseView`: the ten steps in order (`usage_ingested`, `reconciled`, `unallocated`, `no_dev_rows`, `no_open_anomalies`, `no_outstanding_revokes`, `accrual_accepted`, `notes_accepted`, `datarails_uploaded`, `locked`), each `done`, `explained`, `red` (with its problems) or `waiting`, who did it and when; the snapshot, the signatures, each lock with its anchored audit entry, reopens. A month still open is a dry run (`dryRun: true`): the gates as they stand, nothing to act on. A locked month shows its steps as recorded at the lock ([close.md](../close.md)) |
| `POST /api/close/:month/start` `{ note? }` | `admin`, a person (controller or CFO) | `open → closing` (as `POST /api/periods/:month/close`): the month must have ended; rules and rate cards freeze for it; webhook `period.closing` |
| `POST /api/close/:month/explain` `CloseExplainInput` `{ step, rowKey?, note }` | `requests:write`, a person (controller, CFO or FP&A) | Marks a red step explained, with a note of 3 characters or more (audited `close.explained`); step 2 explains one reconciliation row (`rowKey` `provider\|model`). Never step 4 (`no_dev_rows`) or 10 (`locked`): 400. 409 for a locked month (unless reopened) or a month still open |
| `POST /api/close/:month/lock` `LockSignInput` `{ as?, note? }` | `admin`, a person (controller or CFO) | A signature on the lock (`LockResult`). Steps 1–9 must be done or explained and the live figures must still hash to the snapshot (409 otherwise, `details.problems`). The first signature waits (`waitingFor`); the lock happens when a second, different person signs and the two are a controller and the CFO (409 for the same person or two of one role). Locking writes `period.locked` to the audit log with both signatures and the snapshot's sha256, anchors the chain's head at once (an `audit_anchors` row, a log record to Clickland, webhook `audit.anchor`), and sends `period.locked`. Months lock in order |
| `POST /api/close/:month/reopen` `{ reason }` | `admin`, a person (controller) | Raises a `period_reopen` request for a locked month (201 `{ request, close }`); only the CFO decides it, never the person who asked. Approved, the month is reopened: its ledger stays closed to inserts (corrections post to the open month), notes and the upload can be done again, and it locks again with two signatures. 409 for a month not locked, or with a reopen pending |
| `GET /api/accruals?month=` | `read` | `AccrualsView`: the month's newest accrual proposal (lines, total, status, sha256, the snapshot accepting it froze), its earlier versions, and the earlier accrual lines reversed in this month |
| `POST /api/accruals/:month/propose` `{ note? }` | `requests:write`, a person (controller, CFO or FP&A) | A new proposal for an ended month (201 `AccrualView`): per AI provider, model and cost center, the estimates not yet invoiced; per contract, its value per month of term not invoiced. Supersedes an unaccepted proposal; 409 once accepted (unless the snapshot is out of date) or for a locked month |
| `POST /api/accruals/:id/accept` `{ sha256, note? }` | `admin`, a person (controller) | Accepts the proposal as shown (`sha256` of its lines; 409 if it changed) once steps 1–6 are done or explained; freezes the snapshot (spec 016) in the same transaction; audited `accrual.accepted`, webhook `accrual.accepted`, then `notes.draft_requested` |
| `GET /api/accruals/journal.csv?month=` | `read` | The journal entry for the controller to book (Landledger never posts to a GL): the month's accepted accrual (debit technology expense by P&L class and cost center, credit accrued liabilities) and the reversals booked in the month of earlier accruals whose invoices posted (the opposite entries). Balanced; one row per line and side |
| `GET /api/forecast/history?month=&costCenter=` | `read` | `ForecastHistoryView`: the forecast stored each day (P10, P50, P90 to month-end per cost center, and `TOTAL`), the day-10 forecast, and its accuracy against the snapshot's actual at close (within ±10%?) |
| `GET /api/notes?month=` | `read` | `NotesView`: the notes the month's snapshot needs (the month as a whole, `TOTAL`, and each cost center with an actual or a budget), each with the figures it may cite, and every version of every note |
| `GET /api/notes/:month/figures` | `read` (a `notes:draft` key may call it) | `{ snapshotSha256, needed: NoteFigures[] }`: what an agent may cite |
| `POST /api/notes/:month/drafts` `NoteDraftInput` | `notes:draft` (or `admin`) | An agent's draft for one note (201 `NoteView`): text, the figures it cites (each checked against the snapshot it names: 422 `details.mismatches` on any difference, 409 if that snapshot is not the month's current one), the agent and its sponsor (a known person; the key's minter by default). A new version of the note; every version is kept |
| `POST /api/notes/:month/template` `{ costCenter? }` | `requests:write`, a person | The fallback when no agent answers: a deterministic draft from the figures for each needed note with no draft (or the one named), written by Landledger (`kind: template`) |
| `POST /api/notes/:id/accept` `{ version, text?, comment? }` | `requests:write`, a person (FP&A or controller) | Accepts the version shown, or an edited text as a new version by the analyst; never the agent's sponsor or the person who wrote the version (403); audited `note.accepted`, webhook `note.accepted` |
| `POST /api/notes/:id/reject` `{ version, reason }` | `requests:write`, a person (FP&A or controller) | Rejects a version with a reason (the same people as accept); a new draft can follow |
| `GET /api/close/:month/snapshot` | `read` | `CloseSnapshotView`: the frozen figures (by cost center, P&L class, provider, the reconciliation, the requests' lifecycle, the accrual, the notes' figures, the gates) and their sha256; `current` while the live figures still hash to it; 404 before step 7 |
| `GET /api/datarails` | `read` | `DatarailsStatus`: the MCP and upload URLs, the filebox, loopback or not, `real` (false), the budget pulls and the uploads |
| `POST /api/datarails/budgets/pull` `{ dataModel?, scenario?, note? }` | `admin`, a person (controller or CFO) | Reads the budget from Datarails over MCP (`list_data_models`, `list_aliased_fields`, `query_data_model`) into a **pending** pull (201 `DatarailsPullView`), with its sha256 and a preview against the budget in effect. Refused (503) for a host that isn't loopback unless `LANDLEDGER_DATARAILS_REAL=true` (wave 5, the user's decision) |
| `POST /api/datarails/budgets/pulls/:id/accept` `{ sha256, note? }`, `…/reject` `{ reason }` | `admin`, a person (controller or CFO) | The same approval as a CSV budget import: accepted, it becomes the next budget version with source `datarails` (a locked month's budget is refused, 409) |
| `POST /api/datarails/uploads` `{ month }` | `admin`, a person (controller or CFO) | Step 9: uploads three files from the frozen snapshot to the filebox (`POST /api/v1/fileboxes/upload_file`, multipart, Basic auth): `landledger-actuals-<month>.csv` (per cost center: `estimated`, `invoiced`, `notional` cluster cost, `total`, the accepted `accrual`, `budget`, with the snapshot's sha256 on every row), `landledger-notes-<month>.csv` (the accepted notes) and `landledger-snapshot-<month>.json` (the snapshot's canonical JSON). Records each file's sha256 and the response, also when the upload fails; audited `datarails.uploaded`, webhook `datarails.uploaded`. 409 before the notes are accepted |
| `GET /api/close/:month/package?format=json\|html`, `GET /api/close/:month/package.zip` | `read` | The month-end package (`MonthEndPackage`): the snapshot, reconciliation, accruals, notes, exceptions, anomalies closed in the month, decisions in the month, the uploads and the chain proof; `html` a printable page; the zip holds one CSV each and a `manifest.csv` with every file's sha256 |
| `GET /api/cost/window?services=a,b&from=&to=` | `read` | `CostWindowView`: the estimated cost of named services (as Explore names them) over a window (ISO date-times), each day's cost taken by the share of it inside the window, today's provisional figures included; labelled `estimated`. For Landflow's incident-cost flow into Landfall postmortems |

`GET /api/periods` rows carry, additively, `reopened` and `round`. `RequestSummary.withinContract` (wave 4): a
`tool_or_seat` request on a contract reserves seats only, not money, and shows its amount as _within contract_.

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
| `cost.anomaly` | a cost per cost center, service, agent or model jumps against its 14-day baseline (once per key and day), and again when its figure doubles since the last alert | `{ anomaly: AnomalyView, url, escalation }` ([anomalies.md](../anomalies.md)) |
| `contract.renewal_due` | a contract enters its notice window (once per contract and renewal date; checked hourly) | `{ contract: ContractView, url }` ([contracts.md](../contracts.md#renewals)) |
| `contract.notice_reminder` | 7 days and 1 day before a contract's notice date | `{ contract: ContractView, url }` |
| `contract.notice_missed` | the day after the notice date, with no contracts file since | `{ contract: ContractView, url }` |
| `seat.released` | a seat request's seats go back to the contract (released, or expired unapplied after 30 days) | `SeatReleasedData`: `{ requestId, number, contractId, seats, reason, from, url }` |
| `access_review.due` | a quarter's access review is due (from its first day), and each week after while not complete (`reminder: true`) | `AccessReviewDueData`: `{ quarter, reviewId, url, reminder? }` ([access-review.md](../access-review.md)) |
| `access_review.missed` | a quarter ended without a completed review (once) | `AccessReviewDueData` with `missed: true` |
| `notes.draft_requested` | the close reaches step 8 (the accrual accepted and the snapshot frozen), once per snapshot | `NotesDraftRequestedData`: `{ month, snapshotSha256, needed: NoteFigures[], draftUrl, url }` |
| `note.accepted` | an analyst accepts a variance note | `NoteAcceptedData`: `{ month, costCenter, noteId, version, url }` |
| `accrual.accepted` | a controller accepts the month's accrual proposal | `AccrualAcceptedData`: `{ month, accrualId, total, snapshotSha256, url }` |
| `period.locked` | the second signature locks a month (also after a reopen) | `PeriodLockedData`: `{ month, round, signoffs, auditSeq, auditHash, snapshotSha256, url }` |
| `period.reopened` | the CFO approves a `period_reopen` request | `PeriodReopenedData`: `{ month, round, requestId, reason, url }` |
| `datarails.uploaded` | the month's snapshot and notes were uploaded (or the upload failed) | `DatarailsUploadedData`: `{ month, uploadId, snapshotSha256, ok, files }` |
| `approval.anomaly` | an approval pattern: a split, automatic approvals again and again, a decision relayed seconds after its card, one approver for one requester | `{ anomaly: AnomalyView, url, escalation: false }` |
