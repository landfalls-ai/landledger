# Plan 003: Allocation

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-14

## Technical context

| Project | What it gains |
|---|---|
| `libs/allocation` (`@landledger/allocation`) | Selector matching, first-match evaluation, share coefficients (weighted per resource, even, fixed), the two layers, exact splits through `libs/money`; pure, no I/O |
| `libs/contracts` | `rules.ts` (selector, target, share rule, rule set version), `allocation.ts` (an allocation row, a preview), `spend.ts` (Explore's query and result) |
| `libs/schema` | `cost_centers`, `teams`, `products` (versioned, with owners), `allocation_rule_sets`, `allocation_rule_set_versions`, `allocation_generations`, `allocations` (partitioned by month) |
| `apps/api` | The `allocate` job after ingest; `POST /api/allocation/rebuild/:month`; rule set routes (list, propose with preview, approve by a person); `GET /api/spend` |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| 1. Agents request; people decide | PASS | A rule set version takes effect only when a person approves it; an agent (or key) can propose one, with its preview as evidence. |
| 2. Estimated or invoiced | PASS | Allocation keeps the record's `x_Basis`; Explore shows estimated and invoiced parts per group. |
| 3. Money is exact | PASS | Every split is `libs/money` `split` (largest remainder); property tests that parts sum to the record. |
| 4. Nothing is edited | PASS | Records are never touched; a rebuild is a new generation, old ones kept; locked and closing months refuse new generations in the database. |
| 5. Nobody depends on it | N/A | Internal. |
| 6. Local only | PASS | Postgres in `landledger-infra`; fixtures. |
| 7. Spec-driven | PASS | This spec; table-driven tests from OpenCost's sharing cases and finance's examples. |

## Claims checked against the sources

Checked on 2026-11-14 against OpenCost v1.121.3 (`upstream/opencost`) and FOCUS v1.4 (`upstream/focus-spec`).

| Claim | Source | Holds |
|---|---|---|
| OpenCost's share options: a share filter, shared namespaces, shared labels, fixed hourly shared costs, and a weighted or even split | `upstream/opencost/core/pkg/opencost/allocation.go:1533`-`:1551` | yes |
| Shared allocations are set aside before aggregation; fixed costs become synthetic `__shared__` allocations worth cost × hours | `allocation.go:1739`-`:1744`, `:1843`-`:1863` | yes |
| Weighted coefficients use each aggregate's cost excluding its own shared cost; even counts each aggregate once | `allocation.go:2227`, `:2278`-`:2288` | yes |
| Idle and unmounted allocations don't receive shares | `allocation.go:2253`-`:2261` | yes |
| A filtered-out allocation still counts toward coefficients (`__filtered__`), so a filter doesn't change shares | `allocation.go:2270`-`:2276` | yes |
| Idle is shared per resource: CPU idle by CPU cost, RAM by RAM, GPU by GPU | `allocation.go:2304`, `:2342`-`:2348` | yes |
| Only weighted sharing exists for idle | `allocation.go:1623`-`:1625` | yes |
| Idle is capacity cost − allocated cost per resource; negative idle clamped | `upstream/opencost/pkg/costmodel/costmodel.go:2137`-`:2139`, `:2142`-`:2156` | yes |
| The open API exposes none of the sharing options | `costmodel.go:1745`-`:1750` | yes |
| Kubecost's API exposes `shareNamespaces`, `shareLabels`, `shareCost` | Kubecost documentation | [docs] only |
| FOCUS's split cost allocation is the data generator's resource-level split, with an unallocated portion (null `AllocatedResourceId`); it is not an organizational allocation | `upstream/focus-spec/specification/attributes/data_generator_calculated_split_cost_allocation_handling.md:9`-`:11`; `datasets/cost_and_usage/columns/allocatedresourceid.md:13`-`:14` | yes |
| Shared and idle cost is its own row, *Shared pool*, never folded into teams; the measure counts direct attribution | `docs/ui.md:58`-`:59`; `docs/plan.md:100` | yes |

## Decisions

- **First match wins**, in an explicit order. Finance reads a list top to bottom; overlapping rules are resolved by
  position, and the preview names each record's rule. A rule set version is the whole ordered list, so "which rule
  applied on 3 November" is one lookup.
- **Two layers, not one.** OpenCost folds shared cost into aggregates at query time; Landledger keeps `direct`
  (shared and idle in *Shared pool*) as the books' view, which the 80% measure counts, and `spread` as the view a
  budget or a showback may choose. Each layer sums exactly to the records, so switching views never changes a total.
- **Weighted per resource for idle**, OpenCost's rule: a team that uses CPU carries CPU idle, not memory idle. Other
  shared rows (a shared namespace's own usage) are weighted by each recipient's direct cost of the same resource on
  the same day and cluster, and AI shared rows by direct AI cost. `even` and `fixed` are finance's alternatives;
  `fixed` is added because a platform's split is often a negotiated percentage.
- **Coefficients before filters**, OpenCost's `__filtered__` rule: computed once per day over all records, stored in
  the `spread` rows, so a filtered Explore view shows the same shares.
- **Recipients**: cost centers with direct cost on that day (and cluster, for cluster rows) for `weighted`; the
  rule's listed cost centers for `even` and `fixed`. *Shared pool* and *Unallocated* never receive. A day with no
  recipient leaves the row in *Shared pool* in the `spread` layer too, with a warning.
- **Effective by charge day.** A record is allocated by the version effective on its `ChargePeriodStart`, so a
  correction booked in November for 30 October uses October's rules (and October's rate card, spec 002).
- **Generations, not deletes.** `allocation_generations(month, number, created, reason, rule set versions used)`;
  `allocations` rows carry the generation; the current generation per month is the highest. Old generations are kept
  for audit and can be pruned only for open months, by a migration-level job, never for locked ones.
- **Selectors on labels** match nothing until Clickland reports pod labels (spec 002); the preview says so for each
  label rule.
- **P&L classes** are a fixed list: cost of revenue, R&D, S&M, G&A (`docs/ui.md:50`-`:51`). Capitalisable is a
  boolean on the target, never inferred.

## Risks

- A wide rule change in an open month produces a large generation; generations are per month and partitioned, so the
  cost is one month's rows.
- Weighted spreads move when another team's usage moves; the `spread` layer is a view, budgets say whether they use it,
  and the default (`direct`) doesn't move.
