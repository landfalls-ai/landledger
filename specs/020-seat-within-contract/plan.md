# Plan: A seat within its contract (spec 020)

- `withinContract()` in `reservations.ts`, used by `addsInMonth`, approval, `reserve` and the commitments queries.

The contract is `libs/contracts/src/wave4.ts` (pushed first, then changed only additively); the routes are in
[docs/reference/api.md](../../docs/reference/api.md#wave-4-month-end-specs-012019).
