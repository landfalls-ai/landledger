# Plan 011: Access review

**Spec**: [spec.md](spec.md) · **Date**: 2026-11-15

## Technical context

| Project | What it gains |
|---|---|
| `libs/schema` | `0012_wave3.sql`: `access_reviews`, `access_review_items` (snapshots), `access_review_attestations` (append only), `access_review_notices` |
| `libs/contracts` | `AccessReviewView`, `AttestInput`, webhook `access_review.due` |
| `apps/api` | `access-review.ts` (open, attest, complete, the quarterly notice) |
| `apps/console` | `routes/access-review.tsx` |

## Constitution Check

| Principle | Status | Evidence |
|---|---|---|
| 1. Agents request; people decide | PASS | Only a signed-in admin person attests; a key never does; nobody attests their own access. |
| 4. Nothing is edited | PASS | Snapshots and attestations append only; every attestation audited. |
| 2, 3, 5–7 | PASS / N/A | No money; webhook out only; local; this spec. |
