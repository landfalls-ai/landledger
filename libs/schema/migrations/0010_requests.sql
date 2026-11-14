-- 0010_requests: wave 2, "Control the spend" (spec 004, docs/approvals.md). Requests, the policy that gives each its
-- path, the steps, the evidence snapshots people were shown, their decisions, the reservations approval makes, and
-- the budget alerts sent. Requests, steps and reservations move forward only; policies' definitions, snapshots,
-- decisions and alerts are append-only. The database checks the person-shaped rules again: a decision is a person's
-- (never a system actor, never inactive), never the requester's or the sponsor's, one step per person, and never a
-- rate card's or rule set's proposer or line author; a request is approved only by policy or when every step is.
-- Shipped migrations are never edited: a change is a new file.

-- Policies -----------------------------------------------------------------------------------------------------------
-- A version per kind and cost center (null: every cost center). `definition` is `{ automaticBelow, steps }`
-- (libs/contracts PolicyDef). A change is a new version, proposed by a person and approved through a policy_change
-- request; the decided defaults (docs/plan.md, decision 2) are written here as approved, `origin = 'decision'`.

CREATE TABLE policies (
  id            text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('infra_change','ai_budget','tool_or_seat','rate_card_change',
                                              'rule_set_change','policy_change','other')),
  cost_center   text REFERENCES cost_center_codes (code),
  version       integer NOT NULL CHECK (version >= 1),
  definition    jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND jsonb_typeof(definition->'steps') = 'array'),
  note          text NOT NULL DEFAULT '',
  origin        text NOT NULL DEFAULT 'entered' CHECK (origin IN ('entered','decision')),
  status        text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  proposed_by   text NOT NULL REFERENCES users (id),
  proposed_at   timestamptz NOT NULL DEFAULT now(),
  approved_by   text REFERENCES users (id),
  approved_at   timestamptz,
  CHECK (status <> 'approved' OR approved_at IS NOT NULL),
  CHECK (status <> 'approved' OR origin = 'decision' OR approved_by IS NOT NULL),
  CHECK (approved_by IS NULL OR approved_by <> proposed_by)
);
CREATE UNIQUE INDEX policies_version ON policies (kind, coalesce(cost_center, ''), version);

CREATE FUNCTION policies_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'policies are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The app proposes; only a migration writes a decided policy as approved.
    IF NEW.status <> 'proposed' AND current_user = 'landledger_app' THEN
      RAISE EXCEPTION 'a policy is proposed first; it is approved through its request' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'proposed' OR NEW.status = 'proposed'
     OR (to_jsonb(NEW) - 'status' - 'approved_by' - 'approved_at') IS DISTINCT FROM
        (to_jsonb(OLD) - 'status' - 'approved_by' - 'approved_at') THEN
    RAISE EXCEPTION 'a proposed policy is approved or rejected once; a change is a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'approved' AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.approved_by AND kind = 'person') THEN
    RAISE EXCEPTION 'policy % is approved by a person', NEW.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policies_guard BEFORE INSERT OR UPDATE OR DELETE ON policies
  FOR EACH ROW EXECUTE FUNCTION policies_guard();
CREATE TRIGGER policies_no_truncate BEFORE TRUNCATE ON policies
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- The decided defaults (14 Nov 2026): automatic under USD 500 a month; the budget owner to 5,000; Finance (Finance
-- Controllers or Finance CFO) to 25,000, and whenever the cost center is at risk or over, or the request takes it over
-- budget; the CFO above. One-off amounts on the same lines. Seats always go to the budget owner; rate cards, rule
-- sets and policies to Finance and then the CFO, whatever the amount.
DO $$
DECLARE
  owner_step jsonb := '{"key":"budget_owner","label":"Budget owner","approvers":{"groups":["Budget Owners"],"costCenterOwner":true},"when":{"amountAtLeast":"500"}}';
  owner_always jsonb := '{"key":"budget_owner","label":"Budget owner","approvers":{"groups":["Budget Owners"],"costCenterOwner":true},"when":{"always":true}}';
  finance_step jsonb := '{"key":"finance","label":"Finance","approvers":{"groups":["Finance Controllers","Finance CFO"],"costCenterOwner":false},"when":{"amountAbove":"5000","costCenterAtRisk":true}}';
  cfo_step jsonb := '{"key":"cfo","label":"CFO","approvers":{"groups":["Finance CFO"],"costCenterOwner":false},"when":{"amountAbove":"25000"}}';
  finance_always jsonb := '{"key":"finance","label":"Finance","approvers":{"groups":["Finance Controllers","Finance CFO"],"costCenterOwner":false},"when":{"always":true}}';
  cfo_always jsonb := '{"key":"cfo","label":"CFO","approvers":{"groups":["Finance CFO"],"costCenterOwner":false},"when":{"always":true}}';
  note text := 'Decided 14 Nov 2026 (docs/plan.md, decision 2): automatic under USD 500 a month, the budget owner to 5,000, Finance to 25,000, the CFO above; one-off amounts on the same lines.';
  k text;
BEGIN
  FOREACH k IN ARRAY ARRAY['infra_change','ai_budget','other'] LOOP
    INSERT INTO policies (id, kind, version, definition, note, origin, status, proposed_by, approved_at)
    VALUES ('pol_' || k || '_1', k, 1,
            jsonb_build_object('automaticBelow', '500', 'steps', jsonb_build_array(owner_step, finance_step, cfo_step)),
            note, 'decision', 'approved', 'seed', '2026-11-14T00:00:00Z');
  END LOOP;
  INSERT INTO policies (id, kind, version, definition, note, origin, status, proposed_by, approved_at)
  VALUES ('pol_tool_or_seat_1', 'tool_or_seat', 1,
          jsonb_build_object('automaticBelow', NULL, 'steps', jsonb_build_array(owner_always, finance_step, cfo_step)),
          note || ' Seats always go to the budget owner (ui/prototype.html, Policies).', 'decision', 'approved', 'seed',
          '2026-11-14T00:00:00Z');
  FOREACH k IN ARRAY ARRAY['rate_card_change','rule_set_change','policy_change'] LOOP
    INSERT INTO policies (id, kind, version, definition, note, origin, status, proposed_by, approved_at)
    VALUES ('pol_' || k || '_1', k, 1,
            jsonb_build_object('automaticBelow', NULL, 'steps', jsonb_build_array(finance_always, cfo_always)),
            'A change to how every figure is priced, allocated or approved: Finance and then the CFO, whatever the amount (ui/prototype.html, Policies).',
            'decision', 'approved', 'seed', '2026-11-14T00:00:00Z');
  END LOOP;
END $$;

-- Requests -----------------------------------------------------------------------------------------------------------

CREATE SEQUENCE request_numbers;

CREATE TABLE requests (
  id                 text PRIMARY KEY,
  number             integer NOT NULL UNIQUE DEFAULT nextval('request_numbers'),
  kind               text NOT NULL CHECK (kind IN ('infra_change','ai_budget','tool_or_seat','rate_card_change',
                                                   'rule_set_change','policy_change','other')),
  title              text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  note               text NOT NULL DEFAULT '',
  cost_center        text NOT NULL REFERENCES cost_center_codes (code),
  amount_micros      bigint NOT NULL CHECK (amount_micros >= 0),
  currency           char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  recurrence         text NOT NULL CHECK (recurrence IN ('monthly','once')),
  start_day          date NOT NULL,
  end_day            date CHECK (end_day IS NULL OR end_day >= start_day),
  evidence           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object'),
  origin             jsonb NOT NULL CHECK (jsonb_typeof(origin) = 'object' AND origin ? 'type'),
  related            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(related) = 'array'),
  -- What a rate card, rule set or policy change applies: { type, versionId | policyId }.
  change             jsonb CHECK (change IS NULL OR jsonb_typeof(change) = 'object'),
  requester_kind     text NOT NULL CHECK (requester_kind IN ('person','agent')),
  requester_id       text REFERENCES users (id),
  agent_id           text,
  agent_name         text,
  agent_system       text,
  sponsor_id         text REFERENCES users (id),
  created_via        text NOT NULL CHECK (created_via IN ('session','key','mcp')),
  created_by_key     text,
  idempotency_scope  text,
  idempotency_key    text,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','pending','approved','rejected','cancelled','expired','applied')),
  policy_id          text REFERENCES policies (id),
  policy_reason      text,
  automatic          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  submitted_at       timestamptz,
  decided_at         timestamptz,
  applied_at         timestamptz,
  closed_by          text,
  close_note         jsonb,
  CHECK ((requester_kind = 'person' AND requester_id IS NOT NULL AND agent_id IS NULL AND sponsor_id IS NULL)
      OR (requester_kind = 'agent' AND requester_id IS NULL AND agent_id IS NOT NULL AND agent_name IS NOT NULL
          AND sponsor_id IS NOT NULL)),
  CHECK ((change IS NULL) = (kind NOT IN ('rate_card_change','rule_set_change','policy_change'))),
  UNIQUE (idempotency_scope, idempotency_key)
);
CREATE INDEX requests_status ON requests (status, created_at DESC);
CREATE INDEX requests_cost_center ON requests (cost_center, start_day);

-- Requester and sponsor are people, never system actors.
CREATE FUNCTION requests_people() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.requester_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.requester_id AND kind = 'person') THEN
    RAISE EXCEPTION 'a requester is a person (or an agent with a sponsor)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.sponsor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.sponsor_id AND kind = 'person') THEN
    RAISE EXCEPTION 'an agent''s sponsor is a person' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requests_people BEFORE INSERT ON requests FOR EACH ROW EXECUTE FUNCTION requests_people();

-- Status only forward; only the workflow's columns change, and only with a move.
CREATE FUNCTION requests_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moves constant text[] := ARRAY['draft>pending','draft>cancelled','pending>approved','pending>rejected',
                                 'pending>cancelled','pending>expired','approved>applied'];
  workflow constant text[] := ARRAY['status','policy_id','policy_reason','automatic','submitted_at','decided_at',
                                    'applied_at','closed_by','close_note'];
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
  -- Approved by policy (no steps), or every step approved by a person.
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
CREATE TRIGGER requests_forward_only BEFORE UPDATE OR DELETE ON requests
  FOR EACH ROW EXECUTE FUNCTION requests_forward_only();
CREATE TRIGGER requests_no_truncate BEFORE TRUNCATE ON requests
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Steps: the path, fixed at submission. waiting → pending → approved | rejected | expired; skipped when not reached.
CREATE TABLE request_steps (
  request_id      text NOT NULL REFERENCES requests (id),
  position        integer NOT NULL CHECK (position >= 1),
  key             text NOT NULL,
  label           text NOT NULL,
  groups          text[] NOT NULL DEFAULT '{}',
  -- The cost center's owner, as a user, when the step is the owner's and the owner is known here.
  owner_id        text REFERENCES users (id),
  status          text NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting','pending','approved','rejected','skipped','expired')),
  deadline_hours  integer NOT NULL CHECK (deadline_hours >= 1),
  escalate_to     text[] NOT NULL DEFAULT '{}',
  started_at      timestamptz,
  deadline_at     timestamptz,
  escalated_at    timestamptz,
  escalated_to    text[] NOT NULL DEFAULT '{}',
  decided_at      timestamptz,
  PRIMARY KEY (request_id, position),
  CHECK (cardinality(groups) > 0 OR owner_id IS NOT NULL)
);

CREATE FUNCTION request_steps_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  moves constant text[] := ARRAY['waiting>pending','waiting>skipped','pending>approved','pending>rejected',
                                 'pending>expired','pending>skipped','pending>pending'];
  workflow constant text[] := ARRAY['status','started_at','deadline_at','escalated_at','escalated_to','decided_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'request steps are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (OLD.status || '>' || NEW.status = ANY (moves))
     OR (to_jsonb(NEW) - workflow) IS DISTINCT FROM (to_jsonb(OLD) - workflow) THEN
    RAISE EXCEPTION 'step % of request % moves forward only (% to %)', OLD.position, OLD.request_id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- Pending to pending is an escalation, once.
  IF OLD.status = 'pending' AND NEW.status = 'pending' AND (OLD.escalated_at IS NOT NULL OR NEW.escalated_at IS NULL) THEN
    RAISE EXCEPTION 'a pending step escalates once' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Decided only by a decision.
  IF NEW.status IN ('approved','rejected') AND NOT EXISTS (
       SELECT 1 FROM decisions d WHERE d.request_id = NEW.request_id AND d.step = NEW.position
         AND d.outcome = CASE NEW.status WHEN 'approved' THEN 'approve' ELSE 'reject' END) THEN
    RAISE EXCEPTION 'step % of request % is decided by a person''s decision', NEW.position, NEW.request_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- What a person was shown: the request and Landledger's evidence, as canonical JSON, and its sha256.
CREATE TABLE evidence_snapshots (
  request_id  text NOT NULL REFERENCES requests (id),
  sha256      char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  body        jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, sha256)
);
CREATE TRIGGER evidence_snapshots_append_only BEFORE UPDATE OR DELETE ON evidence_snapshots
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER evidence_snapshots_no_truncate BEFORE TRUNCATE ON evidence_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Decisions: append-only, one per step.
CREATE TABLE decisions (
  id               text PRIMARY KEY,
  request_id       text NOT NULL,
  step             integer NOT NULL,
  step_key         text NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('approve','reject')),
  comment          text NOT NULL DEFAULT '' CHECK (outcome = 'approve' OR length(btrim(comment)) >= 3),
  decided_by       text NOT NULL REFERENCES users (id),
  evidence_sha256  char(64) NOT NULL,
  via              text NOT NULL CHECK (via IN ('console','relay')),
  relayed_by       text,
  channel          text,
  decided_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, step),
  FOREIGN KEY (request_id, step) REFERENCES request_steps (request_id, position),
  FOREIGN KEY (request_id, evidence_sha256) REFERENCES evidence_snapshots (request_id, sha256),
  CHECK ((via = 'relay') = (relayed_by IS NOT NULL))
);
CREATE TRIGGER decisions_append_only BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER decisions_no_truncate BEFORE TRUNCATE ON decisions
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

CREATE FUNCTION decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER decisions_guard BEFORE INSERT ON decisions FOR EACH ROW EXECUTE FUNCTION decisions_guard();

CREATE TRIGGER request_steps_forward_only BEFORE UPDATE OR DELETE ON request_steps
  FOR EACH ROW EXECUTE FUNCTION request_steps_forward_only();
CREATE TRIGGER request_steps_no_truncate BEFORE TRUNCATE ON request_steps
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Reservations: budget an approved request holds until its real cost arrives. reserved → consumed | released.
CREATE TABLE reservations (
  id               text PRIMARY KEY,
  request_id       text NOT NULL REFERENCES requests (id),
  cost_center      text NOT NULL REFERENCES cost_center_codes (code),
  month            date NOT NULL CHECK (landledger_first_of_month(month)),
  amount_micros    bigint NOT NULL CHECK (amount_micros >= 0),
  currency         char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  consumed_micros  bigint NOT NULL DEFAULT 0 CHECK (consumed_micros >= 0),
  -- Which real cost consumes it: the request's `match` selector (null: none matches; released at month end).
  selector         jsonb,
  from_day         date NOT NULL,
  status           text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','consumed','released')),
  note             text NOT NULL DEFAULT '',
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  UNIQUE (request_id, month),
  CHECK ((status = 'reserved') = (closed_at IS NULL))
);
CREATE INDEX reservations_month ON reservations (month, cost_center) WHERE status = 'reserved';

CREATE FUNCTION reservations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservations are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM requests WHERE id = NEW.request_id AND status IN ('approved','applied')) THEN
      RAISE EXCEPTION 'only an approved request reserves budget' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'reserved'
     OR (to_jsonb(NEW) - 'status' - 'consumed_micros' - 'closed_at' - 'note')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'consumed_micros' - 'closed_at' - 'note') THEN
    RAISE EXCEPTION 'reservation %: reserved, then consumed or released, once', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservations_guard BEFORE INSERT OR UPDATE OR DELETE ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservations_guard();
CREATE TRIGGER reservations_no_truncate BEFORE TRUNCATE ON reservations
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- budget.at_risk is sent once per cost center, month and state.
CREATE TABLE budget_alerts (
  cost_center  text NOT NULL REFERENCES cost_center_codes (code),
  month        date NOT NULL CHECK (landledger_first_of_month(month)),
  state        text NOT NULL CHECK (state IN ('risk','over')),
  data         jsonb NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cost_center, month, state)
);
CREATE TRIGGER budget_alerts_append_only BEFORE UPDATE OR DELETE ON budget_alerts
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER budget_alerts_no_truncate BEFORE TRUNCATE ON budget_alerts
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- The app ----------------------------------------------------------------------------------------------------------

GRANT USAGE ON SEQUENCE request_numbers TO landledger_app;
GRANT SELECT, INSERT ON policies, requests, request_steps, evidence_snapshots, decisions, reservations, budget_alerts
  TO landledger_app;
GRANT UPDATE (status, approved_by, approved_at) ON policies TO landledger_app;
GRANT UPDATE (status, policy_id, policy_reason, automatic, submitted_at, decided_at, applied_at, closed_by, close_note)
  ON requests TO landledger_app;
GRANT UPDATE (status, started_at, deadline_at, escalated_at, escalated_to, decided_at) ON request_steps TO landledger_app;
GRANT UPDATE (status, consumed_micros, closed_at, note) ON reservations TO landledger_app;
