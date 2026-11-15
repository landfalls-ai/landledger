# Environment variables

Every default is in `.env.example`; copy it to `.env` (git-ignored) to change one. The API, the ingest CLI and
`pnpm db:*` read, without overriding what is already set, `.env.local` in the directory they start in, then
`apps/api/.env.local`, `.env.local` and `.env` at the workspace root. Keys for the sources go in `apps/api/.env.local`
(git-ignored). Development credentials only.

| Variable | Default | What |
|---|---|---|
| `LANDLEDGER_PG_PASSWORD` | `landledger-dev` | The dev Postgres owner's password (`deploy/compose.infra.yml`) |
| `LANDLEDGER_OWNER_PG_URL` | `postgres://landledger:landledger-dev@127.0.0.1:25532/landledger` | The owner: migrations, and the integration tests that create databases |
| `LANDLEDGER_APP_PG_PASSWORD` | `landledger-app-dev` | The app role's password, set by `pnpm db:migrate` (and by `deploy/postgres-init/` on a fresh volume) |
| `LANDLEDGER_PG_URL` | `postgres://landledger_app:landledger-app-dev@127.0.0.1:25532/landledger` | The database as the API, the seed and the CLI use it: `landledger_app`, never the owner |
| `LANDLEDGER_API_HOST`, `LANDLEDGER_API_PORT` | `127.0.0.1`, `4810` | Where the API listens |
| `LANDLEDGER_CONSOLE_PORT`, `LANDLEDGER_CONSOLE_URL` | `4811`, `http://localhost:4811` | The console (CORS origin, sign-in redirects) |
| `LANDLEDGER_OIDC_ISSUER` | `http://localhost:4402/oidc` | Landbright |
| `LANDLEDGER_OIDC_CLIENT_ID` | `landledger-local` | Landledger's client at Landbright |
| `LANDLEDGER_OIDC_REDIRECT_URI` | `http://localhost:4811/api/auth/oidc/callback` | Registered at Landbright |
| `LANDLEDGER_OIDC_POST_LOGOUT_REDIRECT_URI` | `http://localhost:4811/` | Registered at Landbright |
| `LANDLEDGER_OIDC_ENV_FILE` | `~/.config/land-family/landledger-local.env` | Where the client secret is read from (`LANDBRIGHT_CLIENT_SECRET`, written by Landbright's session, mode 600). Never copied into this repository |
| `LANDLEDGER_OIDC_CLIENT_SECRET` | unset | Overrides the file (tests) |
| `LANDLEDGER_SESSION_HOURS` | `8` | Session length |
| `LANDLEDGER_DEV_AUTH` | `off` | `on`: calls with no session and no key act as a local developer (controller). Refused unless the API listens on loopback |
| `LANDLEDGER_BOOTSTRAP_KEY` | unset | An admin key for first setup only: it mints keys until the first admin person (CFO or controller) has signed in, never after |
| `LANDLEDGER_SECRET_KEY` | unset | 32 bytes, base64 or hex (`openssl rand -base64 32`), in the git-ignored `apps/api/.env.local`. Seals the ID token a session keeps for sign-out, each webhook's signing secret and each relay channel's signing secret with AES-256-GCM, bound to their row (`enc:v1:…`). Unset: sessions keep no ID token (sign-out skips the hint) and webhooks can't be created. At start, rows from before are sealed (or, with no key, ID tokens dropped) |
| `LANDLEDGER_BACKGROUND_JOBS` | on | `off` stops the webhook dispatcher and the session cleanup |
| `LANDLEDGER_TELEMETRY` | `on` | `off` (or `OTEL_SDK_DISABLED=true`) stops traces, metrics and logs |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://127.0.0.1:24318` | Clickland's collector (OTLP/HTTP) |
| `LANDLEDGER_ENV` | `local` | `deployment.environment.name` on telemetry |
| `LANDLEDGER_LANDFLOW_URL`, `LANDLEDGER_LANDFLOW_KEY` | unset | Landflow's API and an `lf_…` key that reads usage, insights, prices, workflows and agents. Unset: no AI ingest |
| `LANDLEDGER_LANDFLOW_SERVICE`, `LANDLEDGER_LANDFLOW_NAMESPACE` | `landflow-host`, `landflow-dev` | The service and namespace AI records are tagged with (where Landflow runs) |
| `LANDLEDGER_CLICKLAND_URL`, `LANDLEDGER_CLICKLAND_KEY` | unset | Clickland's API and a key for `POST /api/usage/rollup`. Unset: no cluster ingest |
| `LANDLEDGER_CLICKLAND_LABELS` | unset | Pod labels to ask the rollup for, comma-separated |
| `LANDLEDGER_DOCKER_SHARES_CLUSTER` | `orbstack` | The Kubernetes cluster whose node the Docker engine shares (OrbStack runs both on one machine): Docker's usage comes out of that node's idle, so a day adds up to capacity × rate once. `none` when Docker runs on a host of its own |
| `LANDLEDGER_CLICKLAND_CONSOLE_URL` | `http://localhost:4711` | Where Explore's *Open in Clickland* links go |
| `LANDLEDGER_INGEST` | on | `off` stops the hourly ingest tick |
| `LANDLEDGER_AUDIT_ANCHOR_MINUTES` | `60` | How often the audit chain's head is anchored outside the database (a log record and span to Clickland, webhook `audit.anchor`, a row in `audit_anchors`); `0` turns it off. Runs with the background jobs |
| `LANDLEDGER_COST_METRICS` | on | `off` stops sending `landledger.cost.*` metrics to Clickland |
| `LANDLEDGER_COST_METRICS_ENDPOINT` | `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics` | Where the cost metrics are posted (OTLP/HTTP JSON) |
| `LANDLEDGER_STEP_DEADLINE_HOURS` | `24` | Business hours a pending approval step waits before it escalates (then as long again before the request expires); 1–720 |
| `LANDLEDGER_BUSINESS_DAYS` | `mon-fri` | The days that count toward a deadline, each whole in `LANDLEDGER_TZ`: a range `mon-fri` or a list `sun,mon,tue,wed,thu`. This machine: `sun-thu` (a default to confirm, `docs/plan.md`) |
| `LANDLEDGER_TZ` | `UTC` | The IANA time zone business days are counted in (`Asia/Jerusalem` on this machine); also when a month is over for its invoice and for its close and accrual, the day an accrual reversal is dated, the month a month-end page shows by default, "today" for renewals and seats, and the access review's days |
| `LANDLEDGER_HOLIDAYS_FILE` | `deploy/holidays.txt` | Dates that never count toward a deadline, nor are a contract's notice date: one `YYYY-MM-DD` per line, `#` comments; `none` for no file. The file is empty for now |
| `LANDLEDGER_RECONCILE_TOLERANCE_PCT` | `2` | Reconciliation's tolerance: a provider × model × month is within it when \|invoiced − estimated\| ≤ this percent of the estimate |
| `LANDLEDGER_RECONCILE_TOLERANCE_USD` | `0.50` | Reconciliation's floor: a variance this small is within tolerance whatever the percent |
| `LANDLEDGER_ANOMALY_MIN_USD` | `1` | The smallest daily jump above the median that is a cost anomaly, USD ([anomalies.md](../anomalies.md)) |
| `LANDLEDGER_DEV_ANOMALY` | unset | `on` allows `anomaly spike` and `anomaly reverse` (the dev-only test spike); refused unless the API listens on loopback and the database is on this machine; a spike expires two hours on |
| `LANDLEDGER_CLICKLAND_API_URL` | `LANDLEDGER_CLICKLAND_URL`, else `http://localhost:4710` | Clickland's API for wave 3: the alert rule and Agent Value |
| `LANDLEDGER_CLICKLAND_VALUE_KEY` | unset | A Clickland key with `read`, for Agent Value on the Agents page and in AI budget evidence (in the untracked `apps/api/.env.local`); without it the page shows cost only |
| `LANDLEDGER_RENEWAL_WINDOW_DAYS` | `30` | Days before a contract's notice date its renewal shows first and `contract.renewal_due` goes out, 0 to 365 ([contracts.md](../contracts.md#renewals)) |
| `LANDLEDGER_CLICKLAND_ALERTS_KEY` | unset | A Clickland key with `alerts:write`, for `anomaly clickland-alert` (in the untracked `apps/api/.env.local`) |
| `LANDLEDGER_CLOSE_UNALLOCATED_PCT` | `5` | Close step 3: the most Unallocated may be, percent of the month's spend (0 to 99.99) ([close.md](../close.md)) |
| `LANDLEDGER_DATARAILS_URL` | `http://127.0.0.1:4819` | Datarails' base URL: `fake-datarails` on this machine ([datarails.md](../datarails.md)) |
| `LANDLEDGER_DATARAILS_MCP_URL`, `LANDLEDGER_DATARAILS_UPLOAD_URL` | `${URL}/mcp`, `${URL}/api/v1/fileboxes/upload_file` | The MCP server budgets are read from, and the FileBox upload actuals and notes go to |
| `LANDLEDGER_DATARAILS_MCP_TOKEN` | the fake's dev token when both URLs are loopback, else unset | Bearer token for the MCP server |
| `LANDLEDGER_DATARAILS_USER`, `LANDLEDGER_DATARAILS_PASSWORD` | the fake's dev user when both URLs are loopback, else unset | Basic auth for the upload |
| `LANDLEDGER_DATARAILS_FILEBOX` | `fb_technology_costs` | The FileBox the month's files go to |
| `LANDLEDGER_DATARAILS_REAL` | unset | `true` lets the connector call a host that isn't loopback (only `127.0.0.1` and `::1` count as loopback; `localhost` doesn't). There is no tenant: wave 5 builds our own FP&A product instead (plan.md, Decision 4). Unset, such a host gets 503 |
| `LANDLEDGER_INTEGRATION` | unset | Tests: a comma list of real services to test against (`db`, or `all`) |
