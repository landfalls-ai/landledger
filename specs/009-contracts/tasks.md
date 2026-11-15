# Tasks 009: Contracts and renewals

- [x] T001 The contract; migration (versions, seats, alerts, the `contract` kind and policy).
- [x] T002 CSV import with every problem by line; list with the notice window first.
- [x] T003 The renewal job and `contract.renewal_due`, once per contract and renewal date.
- [x] T004 Contract requests: TCV and term, seats as the reservation; no money reserved; applied on approval.
- [x] T005 Console `#contracts`; Needs you.
- [x] T006 Docs: `docs/contracts.md`, references, plan and history.

## Review of wave 3

- [x] R001 Should-fix 6: a new contract or a TCV raise above $25,000 held as a pending contract request (Decision 9);
  smaller imports on the exceptions report until an approved request covers them.
- [x] R002 Should-fix 15: "today" in `LANDLEDGER_TZ`; the notice date as the last business day on or before it;
  reminders 7 and 1 days before; `contract.notice_missed`.
- [x] R003 Nits: annual value over the exact term; the dev principal imports contracts; `termEnd` checked.
- [x] R004 Console: held imports, covered, as-of, business-day notice; the dev fixture box only on a dev API.

## Review of wave 4

- [x] R001 Should-fix 12: `billing` on each contract version (`monthly_in_arrears` by default).
