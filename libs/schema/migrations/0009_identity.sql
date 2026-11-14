-- 0009_identity: SCIM 2.0 for Landbright's push (spec 004, docs/identity.md), after Clickland's 0007_identity. A user
-- is still a person who signed in (or a system actor); SCIM can now create, change and deactivate people and push
-- their groups. Once SCIM has set a person's groups (`scim_groups_at`), their memberships decide their roles on every
-- request; before that, the `roles` claim of their last sign-in does (users.groups). Users are never deleted: they are
-- named by approvals and decisions, so a SCIM DELETE deactivates and hides them (`deleted_at`).
-- Shipped migrations are never edited: a change is a new file.

ALTER TABLE users
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  -- SCIM created or changed this person: it owns the profile, and sign-in no longer refreshes it.
  ADD COLUMN scim_managed boolean NOT NULL DEFAULT false,
  -- SCIM set this person's groups: memberships, not the sign-in claim, decide their roles.
  ADD COLUMN scim_groups_at timestamptz,
  -- SCIM's userName (the email Landbright sends).
  ADD COLUMN user_name text,
  ADD COLUMN given_name text,
  ADD COLUMN family_name text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN deactivated_at timestamptz,
  ADD COLUMN deleted_at timestamptz;
CREATE UNIQUE INDEX users_user_name ON users (lower(user_name)) WHERE user_name IS NOT NULL AND deleted_at IS NULL;

-- Groups as SCIM pushes them ("Finance Controllers", …); a display name maps to a role (libs/contracts ROLE_BY_GROUP).
CREATE TABLE scim_groups (
  id            text PRIMARY KEY,                     -- grp_…, the SCIM id
  display_name  text NOT NULL,
  external_id   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scim_groups_display_name ON scim_groups (lower(display_name));

CREATE TABLE scim_group_members (
  group_id  text NOT NULL REFERENCES scim_groups (id) ON DELETE CASCADE,
  user_id   text NOT NULL REFERENCES users (id),
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX scim_group_members_user ON scim_group_members (user_id);

-- SCIM bearer tokens (`lls_…`): shown once, stored as sha256.
CREATE TABLE scim_tokens (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  prefix        text NOT NULL,
  hash          text NOT NULL UNIQUE,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- A person's groups now: SCIM's memberships once it set them, else the claim. Used by sign-in, every request, and
-- the approvers of a step.
CREATE FUNCTION landledger_effective_groups(u users) RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN u.scim_groups_at IS NOT NULL THEN coalesce((
           SELECT array_agg(g.display_name ORDER BY g.display_name)
           FROM scim_group_members m JOIN scim_groups g ON g.id = m.group_id WHERE m.user_id = u.id), '{}')
         ELSE u.groups END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_groups, scim_group_members TO landledger_app;
GRANT SELECT, INSERT ON scim_tokens TO landledger_app;
GRANT UPDATE (revoked_at, last_used_at) ON scim_tokens TO landledger_app;
GRANT UPDATE (active, scim_managed, scim_groups_at, user_name, given_name, family_name, updated_at, deactivated_at,
              deleted_at, subject, issuer) ON users TO landledger_app;
GRANT EXECUTE ON FUNCTION landledger_effective_groups(users) TO landledger_app;
