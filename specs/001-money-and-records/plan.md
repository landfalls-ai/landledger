# Plan 001: Money and cost records

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-14

## Technical context

| Project | What it gains |
|---|---|
| `libs/money` (`@landledger/money`) | `Decimal` (bigint coefficient + scale, parsed from strings), `Money` (bigint micro-units + ISO 4217 code), `Rate` and `Quantity` (decimals with a unit), the rounding modes, `split`, the ISO 4217 minor-unit table, `convert` over an FX lookup; no dependencies |
| `libs/focus` (`@landledger/focus`) | The kept FOCUS 1.4 columns and `x_` columns as data (name, type, level, nullable, table column), `check(record)`, the unit strings, `reverse` and `correct` builders, the FOCUS view's column list |
| `libs/schema` | Migrations: `periods`, `fx_rates`, `cost_records` (partitioned by `billing_period_start`, monthly), `ingest_runs` (its shape is spec 002's), the append-only and locked-period triggers, `cost_records_focus` |
| `libs/contracts` | zod schemas for a cost record, a period and an FX rate on the wire (amounts as decimal strings, never JSON numbers) |
| `apps/api` | `GET /api/periods`, `POST /api/periods/:month/close`, `POST /api/periods/:month/lock`; `GET /api/records` (paged, filtered; read only) |

## Constitution Check

| Principle (`docs/plan.md`) | Status | Evidence |
|---|---|---|
| 1. Agents request; people decide | PASS | Locking a month needs a signed-in person; an `ll_…` key with any scope is refused. |
| 2. Estimated or invoiced | PASS | `x_Basis` is not null; `BilledCost` is 0 on estimated rows, checked by `libs/focus` and by a database `CHECK`. |
| 3. Money is exact | PASS, refined | Integers and decimals only. Stored amounts are integer **micro-units** with the ISO 4217 code, not cents: an AI call costs fractions of a cent and FOCUS's own detail runs to 6 decimals (`upstream/focus-spec/specification/appendix/rounding_variance_tolerance.md:3`). Amounts are rounded to the currency's minor unit when posted or shown. This refines "integer minor units" in `CLAUDE.md` and `docs/architecture.md`; the docs change with this spec. |
| 4. Nothing is edited | PASS | Triggers refuse `UPDATE`/`DELETE` on `cost_records` and `fx_rates`; corrections are reversal + re-entry; locked months refuse inserts. |
| 5. Nobody depends on it | N/A | No outbound effect. |
| 6. Local only | PASS | Postgres in `landledger-infra`; tests against `landledger_test` behind `LANDLEDGER_INTEGRATION=db`. |
| 7. Spec-driven | PASS | This spec; property tests for money; database tests for the triggers. |

## Claims checked against the sources

Each claim the design leans on, checked on 2026-11-14 against the pinned sources (`scripts/fetch-upstream.sh`).

| Claim | Source | Holds |
|---|---|---|
| `BilledCost` is invoiced amounts only, and 0 for an entity that doesn't invoice | `upstream/focus-spec/specification/datasets/cost_and_usage/columns/billedcost.md:20`-`:21` | yes |
| `EffectiveCost` = `BilledCost` for uncovered Usage (the rule estimated rows depart from) | `datasets/cost_and_usage/columns/effectivecost.md:18` | yes |
| `ListCost` / `ContractedCost` are unit price × `PricingQuantity` | `…/columns/listcost.md:16`, `…/columns/contractedcost.md:16` | yes |
| Ledger corrections: reversal with opposite-sign additive metrics, other columns equal, then a re-entry; the style must be documented | `attributes/correction_handling.md:49`, `:59`, `:62` | yes |
| `ChargeClass = Correction` only for corrections to a closed period; booked in the open period with the original charge dates | `…/columns/chargeclass.md:11`-`:13`; `appendix/correction_handling_examples/closed_billing_period.md:11` | yes |
| A closed billing period doesn't reopen unless the customer asks | `datasets/billing_period/columns/billingperiodstatus.md:13` | yes |
| Currency columns are ISO 4217 three-letter codes | `attributes/currency_format.md:14`-`:15` | yes |
| Numbers: plain decimal, `-` only, no `+`, no symbols; decimal128 (34 digits) is an allowed precision | `attributes/numeric_format.md:13`-`:17`, `:39` | yes |
| Reconciliation tolerance `MAX(100 × subunit, √rows × 0.5 × subunit)`, subunit 0.01 for USD | `appendix/rounding_variance_tolerance.md:9`, `:14` | yes |
| Custom columns: `x_` prefix, Pascal case, `Id`/`Name` suffixes | `attributes/custom_column_handling.md:23`-`:31` | yes |
| Date/times in UTC | `attributes/datetime_format.md:9` | yes |
| OpenCost computes cost in `float64`, so it is no model for storage | `upstream/opencost/core/pkg/opencost/allocation.go:925` and the cost fields around it (research/opencost.md §9) | yes |

## Decisions

- **Micro-units, not cents.** `Money.amount` is a `bigint` of 10⁻⁶ of the major unit, for every currency (a JPY amount
  is micro-yen). One scale everywhere means a sum never mixes scales, and 2⁶³ micro-units is 9.2 trillion dollars.
  Postgres stores `bigint`; the FOCUS view divides by 10⁶ into `numeric(38,6)`.
- **Two rounding modes, each with one job.**
  - **Half-even** (banker's) when an exact product becomes micro-units: millions of AI rows are rounded and then
    summed, and half-even has no upward bias, so the sum of rounded rows stays inside FOCUS's tolerance of the exact
    sum. At 10⁻⁶ the choice rarely matters, but it is the unbiased one.
  - **Half away from zero** when an amount is posted or shown at the minor unit: that is what finance means by
    rounding, what Excel's `ROUND` and invoices do, so a figure Landledger shows matches the one an analyst recomputes
    from the export.
- **Splits by largest remainder.** `split(amount, weights)` floors each share to the micro-unit and gives the
  remainder one micro-unit at a time to the largest fractional parts (ties to the lowest index, so it is deterministic).
  Allocation (spec 003) and the cluster split (spec 002) both use it, so parts always add up to the whole.
- **Our own `Decimal`.** A bigint coefficient and a scale (up to 18), with add, subtract, multiply, compare, and divide
  only with an explicit scale and rounding mode. It is about 200 lines and keeps the library dependency-free; `big.js`
  and `decimal.js` were considered and rejected because their rounding is global configuration.
- **Snake-case table, FOCUS names in a view.** `cost_records` columns are snake case (`effective_cost_micros`,
  `charge_period_start`); `libs/focus` holds the mapping and `cost_records_focus` exposes the FOCUS names. Postgres
  quoted Pascal case would leak into every query.
- **One row type, many sources.** Cluster, Docker and AI rows share the table; AI-only and cluster-only columns are
  nullable, as FOCUS has them (`research/focus.md` §3).
- **`x_SourceKey` + `x_Basis` + `source_revision` is unique.** Each re-entry for the same key increments the revision;
  a reversal carries its original's revision and `is_reversal = true`. A key's current value is the sum of its rows.
- **Partitions by billing month**, created a month ahead by a migration helper; the locked-period trigger checks
  `periods` on insert.
- **Locking is two steps**: `closing` (ingest still lands, rules and rate cards frozen for the month, wave 4's
  checklist runs) then `locked` (final). A month that is not in `periods` yet is created `open` by the first record.
- **FX**: one reporting currency (USD, `docs/plan.md` decision 6), so `convert` is the identity today; the table, the
  lookup rule and the recorded rate id exist so a second currency is data, not code.

## Risks

- Micro-units in Postgres `bigint` overflow above 9.2 × 10¹² major units: far beyond any figure here; `libs/money`
  checks the bound on every operation anyway.
- The "refined" principle must reach `CLAUDE.md`, `docs/architecture.md` and `docs/plan.md` in the same change as the
  code (T014).
