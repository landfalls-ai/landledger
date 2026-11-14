# Identity: sign-in, roles from groups, SCIM

Who a person is comes from Landbright. Landledger is an OIDC relying party (client `landledger-local`) and, since wave
2, a SCIM 2.0 service provider at `/scim/v2` that Landbright pushes users and groups to. The SCIM side follows
Clickland's (`landfalls-ai/clickland`, `apps/api/src/scim.ts`), adapted to Landledger's tables.

Routes: [reference/api.md](reference/api.md#scim-20-scimv2-for-landbrights-push).

## Roles from groups

Group names map to roles, case-insensitively: `Finance CFO` → CFO, `Finance Controllers` → controller,
`Finance FP&A` → FP&A, `Budget Owners` → budget owner, `Landledger Auditors` → auditor, `Engineering` → engineer.
Other groups are ignored. Someone in none of them is refused at sign-in (`signin_error=no_role`) and isn't created.

A person's groups are **effective groups**, read on every request (`landledger_effective_groups(user)`, migration
0009): the SCIM memberships once SCIM has set them for that person (`users.scim_groups_at`), otherwise the `roles`
claim of their last sign-in. So a group change pushed by SCIM changes their role on their next request, without
signing in again; SCIM wins over the claim.

Scopes per role: CFO and controller `read`, `requests:write`, `admin`; FP&A, budget owner and engineer `read`,
`requests:write`; auditor `read` only.

## Users

- **Just in time:** the first sign-in creates the user from the claims (subject, email, name, groups).
- **Pushed first:** SCIM can create a person before they sign in. Without an `externalId` the subject is a placeholder
  `scim:<id>`; their first sign-in adopts the account by email and sets the real subject.
- **Adopted:** a person who signed in first is adopted by a SCIM create with the same email (or a pathless PATCH), and
  SCIM takes over their profile.
- **Deactivated** (`active: false`, or `DELETE`): every session ends at once, and sign-in is refused
  (`signin_error=inactive`) until SCIM reactivates them. A `DELETE` also hides them and removes their memberships; the
  row stays, so their decisions and audit entries keep naming them. Pushing the same person again brings back the
  same id.
- A decision checks the person is active when it is made, for a session and for a relay.

## SCIM

`/scim/v2`: `ServiceProviderConfig`, `ResourceTypes`, `Schemas`; `Users` and `Groups` with `eq` filters, `POST`, `GET`,
`PUT`, `PATCH` (the forms Landbright sends, including a user's `groups` replace by name, member add and remove, group
rename) and `DELETE`; RFC 7644 errors and its content type. Every change is audited with actor `scim:<token name>`.

**Tokens** are `lls_` and 40 base64url characters, shown once and stored as sha256 (`scim_tokens`); only a bearer token
is accepted on `/scim/v2` (never a cookie or the dev bypass). An admin person manages them at `/api/scim/tokens`, or:

```bash
pnpm scim:token                 # writes ~/.config/land-family/landledger-scim.env (mode 600): LANDLEDGER_SCIM_URL, LANDLEDGER_SCIM_TOKEN
pnpm scim:token --name Landbright --out <file> --url http://127.0.0.1:4810/scim/v2
```

It prints the token's id, name and prefix, never the token. Landbright's session reads the file to configure its push.

Code: `apps/api/src/scim.ts` (`Scim`, `ScimTokens`, `registerScim`), `apps/api/src/scim-token.ts`,
`apps/api/src/auth.ts` (`reconcile`: JIT, adoption, inactive, no role), `apps/api/src/principal.ts`, migration
`libs/schema/migrations/0009_identity.sql`. Tests: `apps/api/test/identity.integration.test.ts`, Clickland's
conformance suite adapted (discovery, create and conflict, filters, adoption both ways, deactivation, groups deciding
roles, the replace form, group delete, user delete and recreate, no role).

## On this machine

A token named `Landbright` was minted on 14 Nov 2026 into `~/.config/land-family/landledger-scim.env`. Landbright's push
isn't configured yet; until it is, groups come from the claim at sign-in.
