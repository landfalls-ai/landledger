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
| `POST /api/periods/:month/lock` | `admin`, a person (controller or CFO) | `closing → locked`, final; earlier months must be locked first; an API key gets 403 |
| `GET /api/records` | `read` | Cost records under FOCUS names, amounts as decimal strings. `?month=YYYY-MM&basis=&source=&sourceKey=&limit=1..1000&after=<next>`; `{ records, next }` |
| `GET /api/audit?limit=&before=` | `read` | The audit log, newest first, with each entry's hash and the one before |
| `GET /api/audit/verify` | `read` | Walks the hash chain: `{ ok, checked, head, brokenAt, reason }` |
| `GET /api/keys`, `POST /api/keys`, `DELETE /api/keys/:id` | `admin` | API keys `ll_…`: shown once at creation, stored as sha256, scopes `read`, `requests:write`, `reservations:write`, `decisions:relay`, `ingest`, `admin` |
| `GET /api/webhooks`, `POST /api/webhooks`, `DELETE /api/webhooks/:id` | `admin` | Webhook subscriptions (Standard Webhooks signatures) |
| `GET /api/webhooks/:id/deliveries`, `POST /api/webhooks/:id/ping` | `admin` | The outbox for one webhook; queue a `ping` |

Webhook events: `ping`, `period.closing` (sent when a month starts closing), and, from later waves,
`request.step_pending`, `request.decided`, `budget.at_risk`, `cost.anomaly`.
