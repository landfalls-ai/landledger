# Development

Everything runs on this machine: Postgres in the OrbStack Docker engine (compose project `landledger-infra`), the API
and the console as Node processes. Development credentials only (`.env.example`).

## Setup

Needs Node 24+, pnpm 10 and OrbStack.

```bash
pnpm install
pnpm dev:up        # Postgres 18 on 127.0.0.1:25532 (project landledger-infra), waits until healthy
pnpm db:migrate    # applies libs/schema/migrations in one transaction
pnpm db:seed       # rate card v1 (a proposal) and the development cost centers; idempotent
pnpm serve         # the API on :4810 and the console on :4811, both watching
```

Open http://localhost:4811 (use `localhost`, not `127.0.0.1`: Landbright's redirect URI and the session cookie are
registered for `localhost`) and **Sign in with Landbright**. Landbright must be running at `http://localhost:4402`,
and Landledger's client secret must be in `~/.config/land-family/landledger-local.env` (written by Landbright's
session; never copy it into this repository). Without the file, the console says sign-in is unavailable; for work that
needs no person, set `LANDLEDGER_DEV_AUTH=on` in `.env` to act as a local developer (controller).

Test people at Landbright (all `@landbright.test`): Finance CFO `dana.shalev`; Finance Controllers `yoav.bendavid` and
`admin`; Finance FP&A `michal.oren`; Budget Owners `amit.gal`, `shira.navon`; Engineering `eden.tzur`, `tal.levi`.
Landbright groups map to roles (`libs/contracts` `ROLE_BY_GROUP`); a group that maps to nothing (`Everyone`) is ignored,
and someone with no mapped group is turned away (`?signin_error=no_role`).

`pnpm dev:down` stops Postgres (the volume stays); `pnpm dev:logs` follows it. To start the database over:
`docker --context orbstack compose -p landledger-infra -f deploy/compose.infra.yml down -v`, then `dev:up`,
`db:migrate`, `db:seed`.

## Ports

| Port | What |
|---|---|
| 25532 | Postgres (`landledger` / `landledger-dev`) |
| 4810 | The API (`apps/api`) |
| 4811 | The console (`apps/console`, Vite; proxies `/api` to 4810) |
| 4402 | Landbright (sign-in), a sibling project |
| 24318 | Clickland's OTLP/HTTP collector, where the API sends its telemetry |

## Where the code starts

| Area | Start at |
|---|---|
| Money | `libs/money/src/money.ts` (`Money`, `split`), `decimal.ts`, `units.ts` (`Rate`, `Quantity`); [money.md](money.md) |
| Cost records | `libs/focus/src/columns.ts` (the catalogue), `check.ts`, `correct.ts` |
| Ingest | `apps/api/src/ingest/` (`sources.ts` clients, `build.ts` records, `runner.ts` runs), `libs/pricing`, the CLI `apps/api/src/cli.ts`; [ingest.md](ingest.md) |
| Allocation | `libs/allocation/src/index.ts` (engine), `apps/api/src/allocation.ts` (rule sets, generations, `DEV_RULES`); [allocation.md](allocation.md) |
| Spend | `apps/api/src/spend.ts` (Overview, Explore, Budgets), `budgets.ts`, `export.ts`, `mcp.ts`, `metrics.ts`; console `routes/overview.tsx`, `explore.tsx`, `budgets.tsx`; [spend.md](spend.md) |
| Tables | `libs/schema/migrations/0001_core.sql` … `0004_budgets.sql`; the runner in `libs/schema/src/index.ts` |
| Wire contracts | `libs/contracts/src/index.ts`, `sources.ts` (Landflow and Clickland), `spend.ts` (the read views) |
| API | `apps/api/src/app.ts` (routes), `auth.ts` + `oidc.ts` (sign-in), `principal.ts` (who is calling), `audit.ts` (hash chain), `anchors.ts` (its head, out to Clickland and webhooks), `ledger.ts` (periods, records), `webhooks.ts` (outbox) |
| Console | `apps/console/src/router.tsx`, `nav.ts` (the navigation of [ui.md](ui.md)), `components/shell/`, `routes/` |

## Conventions

- **Money**: amounts are `Money` (bigint micro-units); rates and quantities `Decimal` from strings; never `number`.
  Products round half-even to the micro-unit; anything shown or posted rounds half away from zero ([money.md](money.md)).
- **Migrations** are numbered `NNNN_name.sql`, applied in one transaction under an advisory lock, and never edited once
  shipped (the runner refuses a changed checksum): a change is a new file.
- **Append only**: `cost_records`, `cost_record_keys`, `fx_rates`, `rate_lines`, `audit_log`, `audit_anchors`, `allocations`, `allocation_generations`, `budget_imports`, `budgets`, `version_notes`, `invoice_estimate_links`, `cost_center_codes` refuse `UPDATE`, `DELETE`
  and `TRUNCATE` in the database; `periods`, `ingest_runs` and `rate_card_versions` only move forward.
- **Routes** validate with zod (`parse`), answer errors as `{ error: { code, message } }`, check scopes with `need`,
  and write the audit log in the same transaction as the change.
- **Specs first**: a feature starts as `specs/NNN-name/` (spec, plan, tasks). Docs move with the code.

## Checking a change

```bash
pnpm verify                                   # format, typecheck, lint, unit tests, build
pnpm test:integration                         # against a real Postgres (LANDLEDGER_INTEGRATION=db by default)
```

`pnpm test:integration` needs `pnpm dev:up`; each run creates `landledger_test_<random>` databases and drops them.
`LANDLEDGER_INTEGRATION` takes a comma list of the real services to test against (`db` today, or `all`); tests for a
service that isn't named skip.

Per package: `pnpm --filter @landledger/money test`, `pnpm --filter @landledger/api test:integration`, and so on.

## Telemetry

The API exports traces, metrics and logs over OTLP to Clickland's collector (`http://127.0.0.1:24318`) as
`service.name = landledger-api`, `service.namespace = landledger`. Its logs carry the trace and span ids.
`LANDLEDGER_TELEMETRY=off` turns it off. To see them, query Clickland, or its ClickHouse directly:

```bash
curl -s -u clickland_admin:clickland-dev-admin 'http://127.0.0.1:28123/' --data-binary \
  "SELECT SpanName, count() FROM otel_traces WHERE ServiceName = 'landledger-api' GROUP BY SpanName FORMAT PrettyCompact"
```

## Variables

[reference/env.md](reference/env.md) lists every variable; the routes are in [reference/api.md](reference/api.md).
