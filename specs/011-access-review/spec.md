# Feature 011: Access review (wave 3, "Plan and reconcile")

**Status**: specified 2026-11-15 · **Plan**: [plan.md](plan.md) · **Tasks**: [tasks.md](tasks.md)

## Why

The controls rest on who holds what: people's roles, keys and their scopes, Slack links, relay channels, cost center
ownership. The review of wave 2 asked for a periodic check that each is still right, made by a person and kept.

## User stories

1. **As a controller or the CFO**, each quarter I open the access review and attest each item: keep, or revoke (with
   a comment), and the review is complete when every item has an attestation.
2. **As an auditor**, I read every review, who attested what and when, in the audit log.
3. **As Landflow**, I hear `access_review.due` when a quarter's review is due, to remind the controllers.

## Acceptance

- `POST /api/access-reviews` (an admin person) opens the quarter's review (one per quarter): a snapshot of every
  item: people with roles (groups, roles, last seen, SCIM-managed), keys (scopes, bound workflows, creator, last
  used), Slack links, relay channels, cost center owners and deputies.
- `POST /api/access-reviews/:id/items/:itemId/attest { decision: keep | revoke, comment }`: an admin person
  (controller or CFO); a comment is required to revoke; nobody attests an item about themselves (their own person row,
  link or ownership, or a key they minted). Attestations append only, audited `access_review.attested`; the last one
  completes the review (`access_review.completed`). Revoking a key or link is then done where it lives (the review
  records the decision and links to it).
- `GET /api/access-reviews`, `GET /api/access-reviews/:id` (read).
- The job sends `access_review.due` once per quarter, from the quarter's first day, while no review of it is complete.
- Console: Access review (Setup), one card per kind, Keep / Revoke per item, phone first.

## Out of scope

Revoking from the review in one step; Landbright's own access reviews.
