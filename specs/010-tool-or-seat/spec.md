# Feature 010: Tool or seat (wave 3, "Plan and reconcile")

**Status**: built 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md)

## Why

A paid seat is spend: someone asks Landbright for access to an app that costs per seat. Landbright grants only once a
person approved the cost in Landledger, and the seat comes out of a contract that has (or lacks) seats left.
Landledger owns the request, the policy, the decision and the seat count; Landflow carries the conversation between
the two; Landbright grants.

## User stories

1. **As Landflow's flow**, when Landbright asks for approval of an access request with a seat cost, I find the
   app's contract (`GET /api/contracts/seats?landbrightApp=`), raise a `tool_or_seat` request with the seat price and
   the contract, wait for `request.decided`, and tell Landbright.
2. **As the budget owner**, the request shows the seat price, the contract, its seats paid, used, reserved and left,
   and what is left after this one.
3. **As Landbright**, I grant after approval and say so; Landflow marks the request applied and the seat moves from
   reserved to used.

## Acceptance

- `CreateRequestInput.seat`: `{ contractId, seats (1–100, default 1), seatPrice (USD a month) }`, only on
  `tool_or_seat`; the request's amount must be seats × seat price a month (400 otherwise).
- Evidence `seat`: the contract (vendor, product, renewal), seats paid, used, reserved, left now and after, and a
  note when none is left ("approving buys a seat beyond the contract").
- On approval: a seat reservation (`reserved`) on the contract and the usual monthly money reservation of the seat
  price. On `applied` (Landflow, after Landbright granted): the seat reservation is `applied` and counts as used. On
  rejection, cancellation or expiry nothing is reserved.
- `GET /api/contracts/seats?landbrightApp=<app>` (scope `read`): the contract that grants that app, its seat price
  (annual value ÷ seats paid ÷ 12, or as imported) and seats left; 404 when no contract names the app.
- `request.decided` carries the request's `seat` so Landflow can answer Landbright without another call.
- `docs/integrations.md`: what Landflow's flow and Landbright's access bundles need, step by step. Landledger
  changes neither repo.

## Out of scope

Landbright's and Landflow's sides (written down for their sessions); seat counts read live from Landbright.
