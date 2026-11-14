# Environment variables

Every default is in `.env.example`; copy it to `.env` (git-ignored) to change one. The API, the ingest CLI and
`pnpm db:*` read, without overriding what is already set, `.env.local` in the directory they start in, then
`apps/api/.env.local`, `.env.local` and `.env` at the workspace root. Keys for the sources go in `apps/api/.env.local`
(git-ignored). Development credentials only.

| Variable | Default | What |
|---|---|---|
| `LANDLEDGER_PG_PASSWORD` | `landledger-dev` | The dev Postgres password (`deploy/compose.infra.yml`) |
| `LANDLEDGER_PG_URL` | `postgres://landledger:landledger-dev@127.0.0.1:25532/landledger` | The database |
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
| `LANDLEDGER_BOOTSTRAP_KEY` | unset | An admin key for scripts before anyone has signed in |
| `LANDLEDGER_SECRET_KEY` | unset | 32 bytes, base64 or hex (`openssl rand -base64 32`), in the git-ignored `apps/api/.env.local`. Seals the ID token a session keeps for sign-out and each webhook's signing secret with AES-256-GCM, bound to their row (`enc:v1:…`). Unset: sessions keep no ID token (sign-out skips the hint) and webhooks can't be created. At start, rows from before are sealed (or, with no key, ID tokens dropped) |
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
| `LANDLEDGER_INTEGRATION` | unset | Tests: a comma list of real services to test against (`db`, or `all`) |
