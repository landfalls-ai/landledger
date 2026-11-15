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
| `key` | every key not revoked | scopes, bound workflows, who minted it, when, last used | the person who minted it (by id) |
| `link` | every Slack link not removed | the Slack member id; decisions relayed from it count as the person's | the person |
| `session` | each person signed in to the console now (one item per person) | how many sessions, since when, last seen | the person |
| `relay_channel` | every relay channel not disabled | Slack team and app; it relays decisions into Landledger | the person who added it (by id) |
| `webhook` | every webhook subscription not disabled | its URL and events, who subscribed it | the person who subscribed it |
| `owner` | every cost center with an owner (the owners map, or the cost center's own owner when it names a person) | the owner and deputies, where it came from | the owner and the deputies |

Review of wave 3 (should-fix 9): who an item is about is checked as it stands now as well as in the snapshot, so a
deputy named after the review opened can't attest that cost center. A key, channel or webhook no person stands behind
(minted by the CLI or the bootstrap key) is `cfoOnly`: only the CFO attests it.

**Granted after it opened:** anything new (a key minted, a link made, a deputy named, a webhook, a person who signed in)
joins the open review with `addedAt` (audited `access_review.items_added`) whenever it is read or the hourly job runs;
a cost center whose owners changed joins again under its new owners. A completed review takes nothing more. A review
opened before this change (the live 2026-Q4 one) picks up its webhooks and sessions the same way, with nothing
attested for anyone.

## Attesting

`POST /api/access-reviews/:id/items/:itemId/attest` `{ decision: keep | revoke, comment, confirm? }`, by the
controller or the CFO, signed in:

- **Never an item about yourself** (your own person row, a key you minted, your own link or channel, a cost center
  you own or deputise): 403, and the database refuses it too.
- **Revoke needs a reason** (3 characters or more); keep needs none.
- **Once per item:** attested again is `409`. Attestations are append only, audited `access_review.attested` with the
  decision and comment.
- **A revoke Landledger can do, it does at once** (should-fix 9): a key (`revoked_at`), a Slack link (`removed_at`) or
  a person's sessions (all ended, audited `auth.sessions_ended`). The attester confirms first (`confirm: true`; 400
  without), and the item carries the `revocation` (how, by whom, when; `access_review_revocations`).
- **Any other revoke is tracked** until the access is gone: a role (in Landbright's groups), a relay channel or a
  webhook (disabled in Settings), a cost center's owners (once anyone the item named no longer owns or deputises it).
  Until then the item is `outstanding`.
- The review **completes** (`completed_at`, once) when every item is attested and no revoke is outstanding, checked on
  each attestation, each read and each hourly run; audited `access_review.completed` with the number of items and of
  revokes. A complete review takes no more attestations (409). `counts` carries `outstanding` and `added`.

## When it is due

The hourly job sends webhook `access_review.due` `{ quarter, reviewId, url }` from the quarter's first day
(`access_review_notices`), then again with `reminder: true` each week while that quarter's review is not complete
(`access_review_events`); audited `access_review.due` and `access_review.reminder`. A quarter that ends without a
completed review is recorded once (`access_review.missed` `{ quarter, reviewId, url, missed: true }`, audited), and
`GET /api/access-reviews` lists it under `missed` beside the current quarter and whether it is `due`. Landflow can turn
these into reminders for the controllers.

## Reading

`GET /api/access-reviews` and `GET /api/access-reviews/:id` (scope `read`): every review, its items with their
snapshot, and each attestation (who, when, keep or revoke, why). An auditor reads them here and in the audit log.

## Not yet

Revoking a role, a relay channel or a webhook from the review in one step (tracked until done instead); Landbright's
own access reviews of its groups (Landbright's side).
