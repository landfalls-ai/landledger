# Landledger

The land family's cost subledger for technology and AI spend (see README.md). Today the repository holds the plan, the
architecture, the screen spec and a static prototype. No product code yet.

## Read first

- `docs/README.md`: the docs index.
- `docs/plan.md`: the waves, the principles, the changes asked of sibling repos, the open decisions.
- `docs/architecture.md`: processes, code map, data, jobs, and how it meets each land product.
- `docs/ui.md` and `ui/prototype.html`: the console's screens.

## Rules

- **Agents request; people decide.** Nothing an agent holds (API key, MCP session, token) may approve a request.
- **Money is exact:** integer minor units with an ISO 4217 code; rates as decimals; never floats.
- **Append only:** cost records, decisions and the audit log are never updated; locked periods never change.
- **Every figure is labelled** `estimated` or `invoiced`; notional cluster cost never goes to the books as actuals.
- Spec-driven (the Landbright method): a feature starts as `specs/NNN-name/` (spec, plan, tasks).
- Docs move with the code: each change updates its page, `docs/limitations.md` and `docs/roadmap.md` when they exist,
  and gets a row in `docs/history.md`.

## Local only

- Run only on this machine: the OrbStack Docker engine and later its Kubernetes cluster (`--context orbstack`,
  namespace `landledger-dev`). Never deploy to a cloud, never push images.
- Build with `COMPOSE_BAKE=false`. Touch only the `landledger-*` compose projects and the `landledger-dev` namespace;
  other projects share this engine; don't prune.
- Use only development credentials. Outside services (Datarails, cloud billing) are fakes until the user decides
  otherwise.
- Landflow, Clickland, Landbright, Landfall and Landlens are separate repositories next to this one. Read them freely;
  change them only when asked, and message the session that owns one before touching it.
