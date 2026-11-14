# Environment variables

Every default is in `.env.example`; copy it to `.env` (git-ignored) to change one. The API and `pnpm db:*` read `.env`
from the workspace root. Development credentials only.

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
| `LANDLEDGER_BACKGROUND_JOBS` | on | `off` stops the webhook dispatcher and the session cleanup |
| `LANDLEDGER_TELEMETRY` | `on` | `off` (or `OTEL_SDK_DISABLED=true`) stops traces, metrics and logs |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://127.0.0.1:24318` | Clickland's collector (OTLP/HTTP) |
| `LANDLEDGER_ENV` | `local` | `deployment.environment.name` on telemetry |
| `LANDLEDGER_INTEGRATION` | unset | Tests: a comma list of real services to test against (`db`, or `all`) |
