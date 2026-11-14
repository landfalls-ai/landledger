# Tasks 003: Allocation

Ordered; each task ends with its tests passing. Depends on spec 001 and on spec 002's records (fixtures suffice).

- [ ] T001 `libs/contracts` `rules.ts`: selector (each field optional, all must match; label as key and value),
      target, *Shared pool* marker, share rule (`weighted` | `even` | `fixed` with percentages summing to 100), rule set
      version; schema tests.
- [ ] T002 `libs/allocation` selector matching against a record (cluster, AI and idle fixtures); table tests.
- [ ] T003 First-match evaluation into the `direct` layer: target, *Shared pool* (shared rules and idle rows),
      *Unallocated*; each row names its rule; tests.
- [ ] T004 Share coefficients: weighted per resource (cluster), by AI cost (AI), even, fixed; computed over the whole
      day before filters; shared and unallocated never receive; tests from OpenCost's cases (`allocation.go:2227`-`:2348`)
      rewritten as fixtures.
- [ ] T005 The `spread` layer with `split`; property tests that each layer's rows sum exactly to each record and that
      both layers give the same grand total.
- [ ] T006 Migrations: `cost_centers`, `teams`, `products` (versioned, owners), `allocation_rule_sets`,
      `allocation_rule_set_versions` (effective from, proposed by, approved by), seed P&L classes; database tests.
- [ ] T007 Migrations: `allocation_generations` and `allocations` (monthly partitions); the trigger that refuses a
      generation for a closing or locked month; database tests.
- [ ] T008 The `allocate` job: after an ingest run, allocate its new records into the month's current generation;
      tests.
- [ ] T009 Rebuild of an open month into a new generation; tests that the old generation stays, that a locked month is
      refused, and that a rebuild with unchanged rules gives identical rows.
- [ ] T010 Rule set proposal with preview (old against new per cost center for each open month) and approval by a
      person; effective date in a locked month refused; route tests.
- [ ] T011 `GET /api/spend`: group by any dimension, filters, `direct` or `spread`, estimated and invoiced parts, the
      unallocated share; route tests.
- [ ] T012 Live check: rules for this machine's namespaces and Landflow's agents, the shared pool on its own row, the
      spread view, a rule change previewed and approved; screenshots at 390 and 1440 px once the console shows it.
- [ ] T013 Docs: `docs/allocation.md` (rules, first match, the two layers, shares, generations), `docs/reference/` for
      the routes, limitations (label rules wait for Clickland), history.
