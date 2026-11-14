# Landledger

The land family's cost subledger for technology and AI spend (see README.md). A pnpm + Nx monorepo: `apps/api`
(Fastify), `apps/console` (React + Vite), `libs/money`, `libs/focus`, `libs/contracts`, `libs/schema`, `libs/tokens`;
Postgres in `deploy/compose.infra.yml`. Wave 1 "See the spend" is built: ingest from
Landflow and Clickland (`apps/api/src/ingest/`, `libs/pricing`), rate card approval, allocation (`libs/allocation`),
budgets, Overview, Explore and Budgets, exports, MCP and cost metrics to Clickland. Wave 2 "Control the spend" is
built and reviewed: requests, policies, decisions by people (console, or a Slack relay Landledger verifies),
reservations, SCIM, the exceptions report (`docs/approvals.md`, `docs/identity.md`). Wave 3 is next.

## Read first

- `docs/README.md`: the docs index.
- `docs/plan.md`: the waves, the principles, the changes asked of sibling repos, the open decisions.
- `docs/architecture.md`: processes, code map, data, jobs, and how it meets each land product.
- `docs/ui.md` and `ui/prototype.html`: the console's screens.
- `docs/development.md`: setup, ports, commands, where each area's code starts, how to check a change.
- `docs/money.md`: micro-units, the two rounding modes, splits, corrections, periods.

## Rules

- **Agents request; people decide.** Nothing an agent holds (API key, MCP session, token) may approve a request.
- **Money is exact:** amounts are bigint **micro-units** (10⁻⁶ of the major unit) with an ISO 4217 code; rates and
  quantities exact decimals from strings; never floats. Computed amounts round half-even to the micro-unit; posted or
  shown amounts round half away from zero to the currency's minor unit (`docs/money.md`).
- **Append only:** cost records, decisions and the audit log are never updated; locked periods never change. A
  correction is a reversal and a re-entry (FOCUS ledger style); a correction to a locked month goes to the open month
  with `ChargeClass = Correction`.
- **Every figure is labelled** `estimated` or `invoiced`; notional cluster cost never goes to the books as actuals.
- Spec-driven (the Landbright method): a feature starts as `specs/NNN-name/` (spec, plan, tasks).
- Docs move with the code: each change updates its page, `docs/limitations.md` and `docs/roadmap.md` when they exist,
  and gets a row in `docs/history.md`.

## Checking a change

```bash
pnpm verify                 # format, typecheck, lint, unit tests, build
pnpm test:integration       # against the landledger-infra Postgres (pnpm dev:up first)
```

## Local only

- Run only on this machine: the OrbStack Docker engine and later its Kubernetes cluster (`--context orbstack`,
  namespace `landledger-dev`). Never deploy to a cloud, never push images.
- Build with `COMPOSE_BAKE=false`. Touch only the `landledger-*` compose projects and the `landledger-dev` namespace;
  other projects share this engine; don't prune.
- Use only development credentials. Outside services (Datarails, cloud billing) are fakes until the user decides
  otherwise.
- Landflow, Clickland, Landbright, Landfall and Landlens are separate repositories next to this one. Read them freely;
  change them only when asked, and message the session that owns one before touching it.
