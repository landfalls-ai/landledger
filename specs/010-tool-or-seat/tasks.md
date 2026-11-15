# Tasks 010: Tool or seat

- [x] T001 The contract: `seat` on requests, its evidence, the lookup.
- [x] T002 Validation (amount = seats × price), evidence, seat reservation on approval, applied → used.
- [x] T003 `GET /api/contracts/seats?landbrightApp=`; `request.decided` carries `seat`.
- [x] T004 Tests: a seat request end to end, none left, refused amounts.
- [x] T005 `docs/integrations.md` for Landflow and Landbright; references, plan and history.

## Review of wave 3

- [x] R001 Should-fix 4: a seat price below the contract's refused; no automatic approval when no seat is left.
- [x] R002 Should-fix 5: `seats_used_as_of`; `POST /api/requests/:id/seats/release` (`seat.released`); unapplied seats
  expire after 30 days.
- [x] R003 `origin.breakGlass` on a Landbright request (additive), listed on the exceptions report until approved.
- [x] R004 Console: release the seat from the Request page.
