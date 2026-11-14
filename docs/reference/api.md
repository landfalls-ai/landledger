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
| `GET /api/audit/verify` | `read` | Walks the hash chain: `{ ok, checked, head, brokenAt, reason }` |
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

Webhook events: `ping`, `period.closing` (sent when a month starts closing), and, from later waves,
`request.step_pending`, `request.decided`, `budget.at_risk`, `cost.anomaly`.
