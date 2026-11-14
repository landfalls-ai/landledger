# Plan 009: Contracts and renewals

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-15

## Technical context

| Project | What it gains |
|---|---|
| `libs/schema` | `0012_wave3.sql`: `contract_versions` (append only, newest wins), `seat_reservations` (reserved → applied or released), `contract_alerts`; `requests.kind` takes `contract`, `requests.contract` and `requests.seat`; the seeded `contract` policy |
| `libs/contracts` | `ContractImportInput`, `ContractView`, `ContractRequestTerms` on `CreateRequestInput`, `ContractRenewalDueData` |
| `apps/api` | `contracts.ts` (import, list, renewal job, seats); `reservations.ts` (a contract reserves seats, not money); `requests.ts` (the terms, applying a contract on approval) |
| `apps/console` | `routes/contracts.tsx`; renewals in Needs you |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| 1. Agents request; people decide | PASS | A contract request goes through the policy; importing is a controller's. |
| 2. Estimated or invoiced | PASS | Contract values are contracted, labelled; they are not in the ledger's actuals. |
| 3. Money is exact | PASS | TCV and annual value in micro-units, half-even. |
| 4. Nothing is edited | PASS | Versions and alerts append only; seat reservations move forward only. |
| 5–7 | PASS | Webhook out only; local; this spec. |
