# The access review

Wave 3, [spec 011](../specs/011-access-review/spec.md), asked for by the review of wave 2. Landledger's controls rest
on who holds what: people's roles, keys and their scopes, Slack links, relay channels, and who owns each cost center.
Once a quarter a person confirms each is still right, and the answer is kept. `apps/api/src/access-review.ts`,
`/api/access-reviews`, the console's **Setup → Access review**.

## Opening the quarter's review

`POST /api/access-reviews`, by the controller or the CFO, signed in (an auditor, an engineer, a key and the local
developer get 403). One review per quarter (`2026-Q4`); opening it again is `409`. Opening takes a **snapshot** of
every item, kept with the review (append only), and is audited `access_review.opened` with the count of each kind:

| Kind | Items | What it shows | About (never attests it) |
|---|---|---|---|
| `person` | every active person with a Landledger role | roles, the Landbright groups they come from, last seen, SCIM-managed | the person |
| `key` | every key not revoked | scopes, bound workflows, who minted it, when, last used | the person who minted it |
| `link` | every Slack link not removed | the Slack member id; decisions relayed from it count as the person's | the person |
| `relay_channel` | every relay channel not disabled | Slack team and app; it relays decisions into Landledger | the person who added it |
| `owner` | every cost center with an owner (the owners map, or the cost center's own owner when it names a person) | the owner and deputies, where it came from | the owner and the deputies |

## Attesting

`POST /api/access-reviews/:id/items/:itemId/attest` `{ decision: keep | revoke, comment }`, by the controller or the
CFO, signed in:

- **Never an item about yourself** (your own person row, a key you minted, your own link or channel, a cost center
  you own or deputise): 403, and the database refuses it too.
- **Revoke needs a reason** (3 characters or more); keep needs none.
- **Once per item:** attested again is `409`. Attestations are append only, audited `access_review.attested` with the
  decision and comment.
- The last attestation **completes** the review (`completed_at`, once), audited `access_review.completed` with the
  number of items and of revokes. A complete review takes no more attestations (409).

A revoke is a decision, recorded here. The revoking itself is done where the access lives: a key in Settings, a link
by its person or an admin, a relay channel by an admin, a role in Landbright's groups. The review links to it; it does
not revoke in one step.

## When it is due

The hourly job sends webhook `access_review.due` `{ quarter, reviewId, url }` once a quarter (`access_review_notices`),
from the quarter's first day, while that quarter's review is not complete; audited `access_review.due`. Landflow can
turn it into a reminder for the controllers. `GET /api/access-reviews` says the current quarter and whether it is
`due`.

## Reading

`GET /api/access-reviews` and `GET /api/access-reviews/:id` (scope `read`): every review, its items with their
snapshot, and each attestation (who, when, keep or revoke, why). An auditor reads them here and in the audit log.

## Not yet

Revoking from the review in one step; Landbright's own access reviews of its groups (Landbright's side).
