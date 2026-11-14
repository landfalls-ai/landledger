# Feature 003: Allocation (wave 1)

**Status**: specified 2026-11-14 (wave 0) · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md)

## Why

A cost record says what was used; finance needs to know **whose** it is: the cost center, team and product that own
it, its P&L class, and whether it can be capitalised. The plan's measure is at least 80% of technology spend attributed
directly to a cost center, with shared and idle cost reported on its own line, never quietly folded into teams. The
mapping is finance's to decide and must not move a locked month.

Research: [docs/research.md](../../docs/research.md) D1, D3, D4, D14; [OpenCost](../../docs/research/opencost.md) §4,
§5, §8; [FOCUS](../../docs/research/focus.md) §3 (split cost allocation).

## User stories

1. **As the finance lead**, I write ordered rules: "namespace `landflow-dev` → cost center *Platform*, team *Flow*,
   product *Landflow*, R&D, capitalisable"; "agent `triage` → *Support*, cost of revenue"; "label `team=billing` →
   *Billing*". The first rule that matches a record decides it.
2. **As the finance lead**, I see what a rule change would do to the open month before I ask for approval, and once
   approved it applies from its effective date; a locked month is untouched.
3. **As a finance analyst**, I see the cluster's idle capacity and shared namespaces (`kube-system`, `clickland-dev`)
   as the *Shared pool*, never inside a team's figure.
4. **As the finance lead**, I can still say how the shared pool would split: weighted by each cost center's own usage
   of each resource, evenly, or by agreed percentages; Explore shows that spread only when asked, and budgets say
   which they use.
5. **As a finance analyst**, every allocated amount names the rule and rule version that produced it, and a record's
   parts add up exactly to the record.
6. **As the controller**, I see what is unallocated (no rule matched) for the month and its share of spend, against the
   80% measure.

## Acceptance

- `libs/allocation` is a pure function: (records, a rule set version per day, the dimensions) → allocation rows; no
  database, no clock.
- A rule is a selector (all of: source, service, provider, model, namespace, workload, container, label, Landflow
  workflow, agent, actor, SKU meter, idle) and a target (cost center, team, product, P&L class, capitalisable), or a
  marker that sends matches to the *Shared pool*. Rules are ordered; the first match wins; no match → *Unallocated*.
- Idle rows (null `AllocatedResourceId`, spec 002) go to the *Shared pool* unless a rule matches them explicitly.
- A **share rule** spreads the shared pool of a day (and cluster, for cluster rows) to cost centers: `weighted` (per
  resource, by each recipient's directly allocated cost of that resource, as OpenCost shares idle), `even`, or
  `fixed` (percentages that sum to 100). Coefficients are computed over all of the day's records before any filter.
  Shared and unallocated rows don't receive shares.
- Allocations are stored in two layers: `direct` (every record exactly once: its target, *Shared pool* or
  *Unallocated*) and `spread` (only shared-pool records, redistributed by the share rules). Each layer's rows for a
  record sum exactly to its `EffectiveCost` (largest remainder, spec 001).
- Rule sets are versioned and effective-dated; a record is allocated by the version effective on its charge day. A new
  version is a proposal with a preview (old against new per cost center for the open months) and becomes active when
  a person approves it. Its effective date can't fall in a locked month.
- Allocation runs after every ingest for the records it added, and **rebuilds** an open (not closing or locked) month
  on demand or when a version takes effect: a rebuild writes a new generation and the month's current generation
  moves to it; earlier generations are kept. The database refuses a generation for a locked or closing month.
- `GET /api/spend` (Explore's query) groups by any dimension over the current generation, `direct` by default,
  `spread` when asked, and reports the unallocated share.

## Out of scope

Requests and approval policies in general (wave 2; until then a rule set version is approved by a person in the
console or API); fixed overhead and seats as records (contracts, wave 3: once they are records, the same rules split
them); allocating by people's Landbright groups (when SCIM provisioning lands); budgets (wave 1, separate spec);
showback statements per cost center (wave 4).
