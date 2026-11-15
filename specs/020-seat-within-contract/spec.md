# Feature 020: A seat within its contract (wave 4, "Month-end")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md) · **Page**:
[docs/contracts.md](../../docs/contracts.md)

## Why

Review of wave 3 left one item open: a seat request on a contract reserved its monthly price as money while the
contract's own value was already in the forecast as contracted, so the seat counted twice.

## User stories

1. **As Finance**, a seat request on a contract shows "within contract" and holds a seat, not money, until
   Landbright prices seats.

## Acceptance

- On approval a `tool_or_seat` request with a `seat` reserves the seat on the contract and no money.
- It adds nothing in evidence, budgets, commitments or the year ahead; `POST /api/reservations` for it is 409.
- `RequestSummary.withinContract` is true; the console shows _within contract_.

## Out of scope

Landbright pricing seats (then a seat beyond the contract could reserve money again).
