# Tasks 001: Money and cost records

Ordered; each task ends with its tests passing.

- [ ] T001 `libs/money` `Decimal`: parse from string (refuse floats in exponent form, `NaN`, `Infinity`, empty), add,
      subtract, multiply, compare, `divide(scale, mode)`; unit tests from a table of cases.
- [ ] T002 Rounding modes `halfEven` and `halfAwayFromZero` on `Decimal`, positive and negative ties; unit tests.
- [ ] T003 ISO 4217 table (code → minor-unit exponent) for the currencies in use plus JPY and BHD as test cases;
      `Money` (bigint micro-units + code): add, subtract, negate, compare, refuse mixed currencies, overflow bound.
- [ ] T004 `Money.fromProduct(rate, quantity)` (half-even to micro-units), `toMinor()` and `format()` (half away from
      zero); `Rate` and `Quantity` with their units; tests including a $0.0031 call and a 2.4 M-token row.
- [ ] T005 `split(amount, weights)` by largest remainder; property tests (parts sum to the whole, deterministic, zero
      weights, a single weight, negative amounts) with fast-check.
- [ ] T006 Property test of the tolerance: rounding rows to minor units then summing stays within
      `MAX(100 × subunit, √rows × 0.5 × subunit)` of rounding the exact sum.
- [ ] T007 `libs/focus` column catalogue: the 45 kept columns and the `x_` columns as data, with type, level, nullable
      and table column; a test that every name satisfies the custom-column naming rule and the FOCUS names are unique.
- [ ] T008 `libs/focus` `check(record)`: required columns, units in Unit Format, `BilledCost` 0 when estimated, cost =
      price × quantity to the micro-unit, UTC day boundaries, `ChargeClass` only on corrections; a test per rule.
- [ ] T009 `libs/focus` `reverse(record)` and `correct(original, replacement, periods)`: open-month and locked-month
      cases from `docs/research/focus.md` §6; tests that a reversal plus its original sums to zero in every additive
      column.
- [ ] T010 Migration: `periods` and `fx_rates` with append-only triggers; database tests (`LANDLEDGER_INTEGRATION=db`).
- [ ] T011 Migration: `cost_records` (monthly partitions, `CHECK`s for basis and billed cost, unique
      `(source_key, basis, source_revision, is_reversal)`), the append-only trigger, the locked-period insert trigger;
      database tests that `UPDATE`, `DELETE` and a locked-month insert fail for the owner too.
- [ ] T012 `cost_records_focus` view and an export test: a fixture's rows read back under FOCUS names, amounts with six
      decimals, no `+`, UTC times.
- [ ] T013 `libs/contracts` schemas and `apps/api` routes: periods (list, close, lock by a person only, no reopen) and
      records (paged, filtered, read only); route tests including an API key refused on lock.
- [ ] T014 Docs: `docs/money.md` (the units, the two rounding modes and why, splits, corrections), the refined money
      principle in `CLAUDE.md`, `docs/plan.md` and `docs/architecture.md` (micro-units, `x_IngestRunId`, the correction
      rule), `docs/reference/` for the routes, history.
