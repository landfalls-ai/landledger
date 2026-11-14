-- 0011_review_wave2: the review of wave 2 (docs/approvals.md, docs/history.md). Keys: `webhooks:write`, workflows a key
-- may vouch for, and a relay key that holds neither `requests:write` nor `admin`. Relay channels (Slack now; Teams and
-- email later) and the links people make from their own session between a channel's user and themselves. Requests:
-- who raised them (`created_by_*`), whether their origin is verified, and `awaiting_confirmation` until the person a key
-- named confirms. Snapshots record who they were served to. Cost center owners and deputies. Reservations consume
-- above a baseline. Weekly exception reports are stored with their sha256. A rate card version's lines freeze once a
-- request exists for it. Back-channel logout tokens are used once. Shipped migrations are never edited.

-- API keys -------------------------------------------------------------------------------------------------------------

ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check1;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_known
  CHECK (scopes <@ ARRAY['read','requests:write','reservations:write','decisions:relay','webhooks:write','ingest',
                         'admin']::text[]);
-- A relay key carries a person's signed press, nothing else: never also the key that raises requests or administers.
-- Keys minted before this rule are refused at use (the API) and only revoked from here on.
ALTER TABLE api_keys ADD CONSTRAINT api_keys_relay_alone
  CHECK (revoked_at IS NOT NULL OR NOT ('decisions:relay' = ANY (scopes))
         OR NOT (scopes && ARRAY['requests:write','admin']::text[])) NOT VALID;
ALTER TABLE api_keys
  ADD COLUMN bound_workflow_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN created_by_user text REFERENCES users (id);

-- Webhooks: the key that created a subscription (`webhooks:write` sees only its own).
ALTER TABLE webhooks ADD COLUMN created_by_key text REFERENCES api_keys (id);

-- Relay channels and person links ---------------------------------------------------------------------------------------

CREATE TABLE relay_channels (
  id           text PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('slack','teams','email')),
  name         text NOT NULL,
  -- Slack: { teamId, appId }. Never the secret.
  config       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  -- Slack: the signing secret, sealed (`enc:v1:`, secrets.ts) with the row id as additional data.
  secret       text NOT NULL CHECK (secret LIKE 'enc:v1:%'),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  disabled_at  timestamptz
);

CREATE TABLE person_links (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id),
  kind         text NOT NULL CHECK (kind IN ('slack','teams','email')),
  external_id  text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz
);
CREATE UNIQUE INDEX person_links_external ON person_links (kind, external_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX person_links_person ON person_links (user_id, kind) WHERE removed_at IS NULL;
-- A link is the person's own: only a person, never a system actor.
CREATE FUNCTION person_links_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'person links are removed, never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'removed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'removed_at')
                           OR OLD.removed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a person link is removed once and never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND kind = 'person') THEN
    RAISE EXCEPTION 'a link belongs to a person' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER person_links_guard BEFORE INSERT OR UPDATE OR DELETE ON person_links
  FOR EACH ROW EXECUTE FUNCTION person_links_guard();

-- Cost center owners and deputies (append-only; the newest row per cost center is in effect) -------------------------------

CREATE TABLE cost_center_owners (
  id           text PRIMARY KEY,
  cost_center  text NOT NULL REFERENCES cost_center_codes (code),
  owner_id     text NOT NULL REFERENCES users (id),
  note         text NOT NULL DEFAULT '',
  set_by       text NOT NULL,
  set_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cost_center_owners_cc ON cost_center_owners (cost_center, set_at DESC);
CREATE TABLE cost_center_deputies (
  owners_id  text NOT NULL REFERENCES cost_center_owners (id),
  user_id    text NOT NULL REFERENCES users (id),
  PRIMARY KEY (owners_id, user_id)
);
CREATE TRIGGER cost_center_owners_append_only BEFORE UPDATE OR DELETE ON cost_center_owners
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER cost_center_deputies_append_only BEFORE UPDATE OR DELETE ON cost_center_deputies
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();

-- Requests -------------------------------------------------------------------------------------------------------------

ALTER TABLE requests DROP CONSTRAINT requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check
  CHECK (status IN ('draft','awaiting_confirmation','pending','approved','rejected','cancelled','expired','applied'));
ALTER TABLE requests
  ADD COLUMN created_by_kind text CHECK (created_by_kind IN ('key','person')),
  ADD COLUMN created_by_id text,
  ADD COLUMN created_by_name text,
  ADD COLUMN origin_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN idempotency_body_sha256 char(64),
  -- The person a key named (requester, or the agent's sponsor), who confirms it from their own session.
  ADD COLUMN confirm_person_id text REFERENCES users (id),
  ADD COLUMN confirm_status text CHECK (confirm_status IN ('waiting','confirmed','declined','expired')),
  ADD COLUMN confirm_at timestamptz,
  ADD COLUMN confirm_deadline_at timestamptz,
  ADD COLUMN confirm_reason text NOT NULL DEFAULT '',
  ADD CONSTRAINT requests_confirm_person CHECK ((confirm_status IS NULL) = (confirm_person_id IS NULL));

-- Requests raised before this migration: stamp who raised them, as best known (a key by name, else the person).
ALTER TABLE requests DISABLE TRIGGER requests_forward_only;
UPDATE requests r SET
  created_by_kind = CASE WHEN r.created_by_key IS NOT NULL THEN 'key' ELSE 'person' END,
  created_by_id = CASE WHEN r.created_by_key IS NOT NULL
                       THEN coalesce((SELECT k.id FROM api_keys k WHERE k.name = r.created_by_key ORDER BY k.created_at LIMIT 1),
                                     'key:' || r.created_by_key)
                       ELSE coalesce(r.requester_id, r.sponsor_id) END,
  created_by_name = coalesce(r.created_by_key, (SELECT u.name FROM users u WHERE u.id = coalesce(r.requester_id, r.sponsor_id))),
  origin_verified = (r.origin->>'type') IN ('console','mcp') AND r.created_by_key IS NULL;
ALTER TABLE requests ENABLE TRIGGER requests_forward_only;
ALTER TABLE requests ALTER COLUMN created_by_kind SET NOT NULL, ALTER COLUMN created_by_id SET NOT NULL,
  ALTER COLUMN created_by_name SET NOT NULL;

CREATE OR REPLACE FUNCTION requests_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moves constant text[] := ARRAY['draft>pending','draft>cancelled','draft>awaiting_confirmation',
                                 'awaiting_confirmation>pending','awaiting_confirmation>cancelled',
                                 'awaiting_confirmation>expired','pending>approved','pending>rejected',
                                 'pending>cancelled','pending>expired','approved>applied'];
  workflow constant text[] := ARRAY['status','policy_id','policy_reason','automatic','submitted_at','decided_at',
                                    'applied_at','closed_by','close_note','confirm_status','confirm_at',
                                    'confirm_deadline_at','confirm_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'requests are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (OLD.status || '>' || NEW.status = ANY (moves)) THEN
    RAISE EXCEPTION 'request % can''t move from % to %: status only moves forward', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - workflow) IS DISTINCT FROM (to_jsonb(OLD) - workflow) THEN
    RAISE EXCEPTION 'a request''s content never changes; only its status moves' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Out of awaiting_confirmation into the policy only when the named person confirmed.
  IF OLD.status = 'awaiting_confirmation' AND NEW.status = 'pending' AND NEW.confirm_status IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'request % waits on its named person''s confirmation', NEW.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'approved' THEN
    IF NEW.automatic THEN
      IF EXISTS (SELECT 1 FROM request_steps WHERE request_id = NEW.id) THEN
        RAISE EXCEPTION 'request % has steps: a person approves each', NEW.id USING ERRCODE = 'restrict_violation';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM request_steps WHERE request_id = NEW.id)
       OR EXISTS (SELECT 1 FROM request_steps WHERE request_id = NEW.id AND status <> 'approved') THEN
      RAISE EXCEPTION 'request % is approved only when every step is', NEW.id USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Steps: the cost center's deputies beside its owner (fixed at submission), and why a step escalated at once.
ALTER TABLE request_steps
  ADD COLUMN deputy_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN note text;

CREATE OR REPLACE FUNCTION request_steps_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moves constant text[] := ARRAY['waiting>pending','waiting>skipped','pending>approved','pending>rejected',
                                 'pending>expired','pending>skipped','pending>pending'];
  workflow constant text[] := ARRAY['status','started_at','deadline_at','escalated_at','escalated_to','decided_at',
                                    'note'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'request steps are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (OLD.status || '>' || NEW.status = ANY (moves))
     OR (to_jsonb(NEW) - workflow) IS DISTINCT FROM (to_jsonb(OLD) - workflow) THEN
    RAISE EXCEPTION 'step % of request % moves forward only (% to %)', OLD.position, OLD.request_id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'pending' AND (OLD.escalated_at IS NOT NULL OR NEW.escalated_at IS NULL) THEN
    RAISE EXCEPTION 'a pending step escalates once' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IN ('approved','rejected') AND NOT EXISTS (
       SELECT 1 FROM decisions d WHERE d.request_id = NEW.request_id AND d.step = NEW.position
         AND d.outcome = CASE NEW.status WHEN 'approved' THEN 'approve' ELSE 'reject' END) THEN
    RAISE EXCEPTION 'step % of request % is decided by a person''s decision', NEW.position, NEW.request_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- Snapshots: who each was served to, and when. A decision cites one served to its person (or, for a relay, the card's
-- hash served to a key or webhook) within 30 minutes; the API checks it.
CREATE TABLE evidence_serves (
  request_id  text NOT NULL,
  sha256      char(64) NOT NULL,
  to_kind     text NOT NULL CHECK (to_kind IN ('person','key','webhook','dev')),
  to_id       text NOT NULL,
  served_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (request_id, sha256) REFERENCES evidence_snapshots (request_id, sha256)
);
CREATE INDEX evidence_serves_lookup ON evidence_serves (request_id, sha256, to_kind, to_id, served_at DESC);
CREATE TRIGGER evidence_serves_append_only BEFORE UPDATE OR DELETE ON evidence_serves
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER evidence_serves_no_truncate BEFORE TRUNCATE ON evidence_serves
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Decisions: the relay channel and its user, and the database's own check of where a relay may decide.
ALTER TABLE decisions
  ADD COLUMN relay_channel_id text REFERENCES relay_channels (id),
  ADD COLUMN relay_external_id text,
  ADD CONSTRAINT decisions_relay_channel CHECK (via <> 'relay' OR relayed_by IS NULL
                                                OR (relay_channel_id IS NOT NULL AND relay_external_id IS NOT NULL))
    NOT VALID;

CREATE OR REPLACE FUNCTION decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r requests;
  s request_steps;
BEGIN
  SELECT * INTO r FROM requests WHERE id = NEW.request_id;
  SELECT * INTO s FROM request_steps WHERE request_id = NEW.request_id AND position = NEW.step;
  IF r.status <> 'pending' OR s.status <> 'pending' THEN
    RAISE EXCEPTION 'step % of request % isn''t waiting on a decision', NEW.step, NEW.request_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.decided_by AND kind = 'person' AND active AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'a decision is an active person''s, never a system actor''s, a key''s or an agent''s'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.decided_by = r.requester_id OR NEW.decided_by = r.sponsor_id THEN
    RAISE EXCEPTION 'the requester and the sponsor can''t decide request %', r.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM decisions WHERE request_id = NEW.request_id AND decided_by = NEW.decided_by) THEN
    RAISE EXCEPTION 'a person decides one step of a request' USING ERRCODE = 'restrict_violation';
  END IF;
  -- A relay decides only the budget owner's step of an infra change, AI budget, tool or seat, or other request.
  IF NEW.via = 'relay' AND (s.key <> 'budget_owner' OR r.kind NOT IN ('infra_change','ai_budget','tool_or_seat','other')) THEN
    RAISE EXCEPTION 'a relay never decides % of a % request: a person decides it in the console', s.key, r.kind
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF r.change->>'type' = 'rate_card_version' AND (
       EXISTS (SELECT 1 FROM rate_card_versions WHERE id = r.change->>'versionId' AND proposed_by = NEW.decided_by)
       OR EXISTS (SELECT 1 FROM rate_lines WHERE version_id = r.change->>'versionId' AND added_by = NEW.decided_by)) THEN
    RAISE EXCEPTION 'the proposer of a rate card version, and anyone who added a line, can''t decide it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF r.change->>'type' = 'rule_set_version' AND EXISTS (
       SELECT 1 FROM allocation_rule_set_versions WHERE id = r.change->>'versionId' AND proposed_by = NEW.decided_by) THEN
    RAISE EXCEPTION 'the proposer of a rule set version can''t decide it' USING ERRCODE = 'restrict_violation';
  END IF;
  IF r.change->>'type' = 'policy' AND EXISTS (
       SELECT 1 FROM policies WHERE id = r.change->>'policyId' AND proposed_by = NEW.decided_by) THEN
    RAISE EXCEPTION 'the proposer of a policy can''t decide it' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- A rate card version's lines are frozen once a request exists for it.
CREATE FUNCTION rate_lines_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM requests WHERE change->>'type' = 'rate_card_version'
               AND change->>'versionId' = NEW.version_id) THEN
    RAISE EXCEPTION 'rate card version %''s lines are frozen: a request exists for it', NEW.version_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rate_lines_frozen BEFORE INSERT ON rate_lines FOR EACH ROW EXECUTE FUNCTION rate_lines_frozen();

-- Reservations: consumed only by cost above the matched cost's daily baseline at approval.
ALTER TABLE reservations
  ADD COLUMN consumption text NOT NULL DEFAULT 'none' CHECK (consumption IN ('matched','none')),
  ADD COLUMN baseline_daily_micros bigint CHECK (baseline_daily_micros >= 0);
ALTER TABLE reservations DISABLE TRIGGER reservations_guard;
UPDATE reservations SET consumption = 'matched', baseline_daily_micros = 0 WHERE selector IS NOT NULL;
ALTER TABLE reservations ENABLE TRIGGER reservations_guard;

-- The weekly exceptions report, kept with its figures and sha256.
CREATE TABLE exception_reports (
  id            text PRIMARY KEY,
  from_month    text NOT NULL,
  to_month      text NOT NULL,
  generated_at  timestamptz NOT NULL,
  rows          integer NOT NULL CHECK (rows >= 0),
  body          jsonb NOT NULL,
  sha256        char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER exception_reports_append_only BEFORE UPDATE OR DELETE ON exception_reports
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER exception_reports_no_truncate BEFORE TRUNCATE ON exception_reports
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Back-channel logout tokens: each `jti` once.
CREATE TABLE logout_tokens (
  jti      text PRIMARY KEY,
  sub      text,
  seen_at  timestamptz NOT NULL DEFAULT now()
);

-- The app ----------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON relay_channels, person_links, cost_center_owners, cost_center_deputies, evidence_serves,
  exception_reports, logout_tokens TO landledger_app;
GRANT UPDATE (disabled_at) ON relay_channels TO landledger_app;
GRANT UPDATE (removed_at) ON person_links TO landledger_app;
GRANT DELETE ON logout_tokens TO landledger_app;
GRANT UPDATE (confirm_status, confirm_at, confirm_deadline_at, confirm_reason) ON requests TO landledger_app;
GRANT UPDATE (note) ON request_steps TO landledger_app;
