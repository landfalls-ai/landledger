# Plan 010: Tool or seat

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-15

## Technical context

| Project | What it gains |
|---|---|
| `libs/contracts` | `SeatTerms` on `CreateRequestInput`, `RequestView.seat`, `SeatEvidence`, `ContractSeats` |
| `apps/api` | `contracts.ts` (seats left, the lookup by Landbright app), `requests.ts` (validate the terms, evidence, reserve the seat on approval, apply it) |
| `docs` | `integrations.md`: Landflow's flow, Landbright's access bundles |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| 1. Agents request; people decide | PASS | Landflow raises; a person approves (the budget owner always: the seeded `tool_or_seat` policy); a request a key raises naming a person waits for that person's confirmation, as in wave 2. |
| 2–7 | PASS | Contracted prices, labelled; micro-units; seat reservations forward only; Landbright still grants if Landledger is down only by its own rule (documented); local; this spec. |

## The flow

```
Landbright access request (app with seat cost)
  → Landflow flow: GET /api/contracts/seats?landbrightApp=…   (key: read)
  → POST /api/requests { kind: tool_or_seat, seat, origin: landbright_request, requester: { person } }  (key: requests:write)
  → the person confirms in Landledger (request.needs_confirmation) → policy → budget owner (→ Finance if at risk or no budget)
  → request.decided { request.seat } → Landflow tells Landbright: grant or refuse
  → Landbright grants → Landflow POST /api/requests/:id/applied → the seat is used
```
