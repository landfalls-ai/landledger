# Allocation

Who each cost belongs to (spec 003): every record goes to a cost center (with team, product, P&L class and the
capitalisable flag), to the **shared pool**, or to **Unallocated**. Code: `libs/allocation` (the pure engine),
`apps/api/src/allocation.ts` (rule sets, generations, the job); tables in migration 0003.

## Rules

A rule set version is an ordered list of rules. A rule has a **selector** (each field optional, all given must match,
case-insensitive, `*` as a wildcard): `source`, `resource`, `idle`, `cluster`, `service`, `provider`, `model`,
`namespace`, `workload`, `container`, `composeProject`, `composeService`, `workflow` and `agent` (by id or name),
`actor`, `meter`, `label` (key and value). The **first** rule that matches decides; its target is a cost center
(and optionally team, product, P&L class, capitalisable) or `shared: true`. Idle rows are matched only by a rule that
selects `idle: true`, so idle stays in the shared pool unless finance says otherwise. What no rule matches goes to
Unallocated, so a gap in the rules shows as a number rather than hiding.

## Two layers

- **Direct** (the books' view, the default everywhere): the shared pool and Unallocated are their own lines.
- **Spread** (opt-in, Explore's *spread* chip, `?layer=spread`): the shared pool shared out by the version's share
  rules: `weighted` (each cost center's direct cost of the same resource that day, OpenCost's split), `even` or
  `fixed` percentages. Unallocated is never spread and never receives. Both layers give the same grand total to the
  micro-unit (`split` by largest remainder; property tests in `libs/allocation/test`).

The spread layer is computed when read, from the stored direct layer; it is not stored.

## Generations

`allocations` holds each record's direct split, in **generations** per month (`allocation_generations`). Records
ingested later join the month's newest generation (`allocate` runs after every ingest run that entered records). A rule
set approval or `POST /api/allocation/rebuild/:month` starts a new generation for each **open** month; the database
refuses a generation for a closing or locked month, and old generations stay. Reads use the newest generation; today's
provisional rows (and any record not yet allocated) are allocated on the fly with the rules in effect.

## Approval

A rule set version is proposed (here by the seed, the system user `seed`: `proposed_by` references `users`) and approved
by `POST /api/allocation/rule-sets/versions/:id/approve`: a person, controller or CFO, not the proposer; never an API
key or a system actor (the database refuses an approver who isn't a user of kind `person`, migration 0005). Approval
rebuilds the open months and is audited. A rebuild is audited under whoever asked: a person, or `system` for ingest,
the CLI and the local developer (`LANDLEDGER_DEV_AUTH`), which is never recorded as a person. `rsv_main_1`, approved
before 0005, keeps its approval with a `version_notes` row saying its proposer was free text then.
`GET /api/allocation/rule-sets` lists the versions; the console shows them on Rates and rules.

## The dev seed

`rsv_main_1` (effective 2026-10-01, origin `dev-seed`, marked *development seed data*) maps this machine to the six dev
cost centers. Approved on 2026-11-14 by `dana.shalev@landbright.test` (CFO).

| Rule | Selector | Goes to |
|---|---|---|
| ai-agents | source `landflow` (every AI call) | ENG-AGENTS, R&D, capitalisable |
| lf-agent-cache, -cache-pvc, -mcp, -harness | `landflow-dev` workloads `landflow-cache*`, `*-mcp`, `*agent*` | ENG-AGENTS |
| lf-platform | namespace `landflow-dev` (the rest) | ENG-PLATFORM, R&D, capitalisable |
| ck-platform | namespace `clickland-dev` | ENG-PLATFORM |
| kagent | container `landflow-kagent-*` | ENG-AGENTS |
| k8s-system | namespace `kube-system` | shared pool |
| dc-clickland | compose `clickland-*` | RND-DATA |
| dc-landbright, dc-landledger | compose `landbright-*`, `landledger-*` | GA-IT, G&A |
| dc-landfall | compose `landfall-*` | CS-SUPPORT, cost of revenue |
| dc-landflow, dc-lab | compose `landflow-*`, `lab-*` | ENG-PLATFORM |

Share rule: `weighted`. Everything else on the machine (other projects' containers, OrbStack's own) is Unallocated.

## Where this differs from spec 003

- The spread layer is computed on read rather than stored per generation.
- A late record joins the newest generation instead of waiting for a rebuild.
- Rule set proposals come from the seed only: the proposal route with its preview (T010) is not built.

## Open

- Label rules match nothing until Clickland carries pod labels.
- Proposing and previewing a rule change from the console; teams and products as targets in the dev seed.
