-- 0013_review_wave3: the review of wave 3. Link kinds, so a locked month's true-up and a late estimate are linked to
-- the invoice that covers them without moving a locked month; the logout token's hash and iat; anomalies that update
-- their figure, are assigned and closed with an outcome; seats released and expired; seats used as of a date; contract
-- notices (reminder, missed); the access review's new kinds (webhooks, sessions), items added after opening, revokes
-- carried out at once, reminders and a missed quarter. Shipped migrations are never edited: a change is a new file.

-- B1–B3: invoice ↔ estimate links by kind -------------------------------------------------------------------------
-- `split`: an invoice line's share replaces the estimate (it drops out of every figure). `late`: an estimate that
-- arrived after its provider, model and month were invoiced; it drops out too, and the reconciliation row says
-- "estimates after invoice: re-reconcile" until the invoice is imported again. `trued_up`: a locked month's estimate
-- the open month's true-up already subtracted; it stays in its locked month (never hidden), and no later invoice
-- subtracts it again. Reads hide an estimate by a split or late link while the invoiced entry it names was live as of
-- the estimate's own billing month, so once that month locks, nothing done later moves it (apps/api/src/spend.ts).
ALTER TABLE invoice_estimate_links ADD COLUMN kind text NOT NULL DEFAULT 'split'
  CHECK (kind IN ('split','late','trued_up'));

CREATE OR REPLACE FUNCTION invoice_estimate_links_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv cost_record_keys;
  inv_month date;
BEGIN
  SELECT * INTO inv FROM cost_record_keys WHERE record_id = NEW.invoiced_record_id;
  IF NOT FOUND OR inv.basis <> 'invoiced' OR inv.is_reversal THEN
    RAISE EXCEPTION 'record % is not an invoiced entry in the ledger', NEW.invoiced_record_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  inv_month := (inv.billing_period_start AT TIME ZONE 'UTC')::date;
  IF NEW.kind = 'trued_up' THEN
    -- The true-up is booked in the open month, at or after the locked month of the estimates it covers.
    IF inv_month < NEW.month THEN
      RAISE EXCEPTION 'a true-up is booked at or after the month it trues up' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cost_record_keys k WHERE k.source_key = NEW.estimated_source_key
                     AND k.basis = 'estimated') THEN
      RAISE EXCEPTION 'no estimate %', NEW.estimated_source_key USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind = 'split' AND inv_month <> NEW.month THEN
    RAISE EXCEPTION 'an invoice line replaces estimates of its own billing month' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'late' AND inv_month > NEW.month THEN
    RAISE EXCEPTION 'a late estimate is covered by an invoice booked at or before its month'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cost_record_keys k WHERE k.source_key = NEW.estimated_source_key
                   AND k.basis = 'estimated' AND (k.billing_period_start AT TIME ZONE 'UTC')::date = NEW.month) THEN
    RAISE EXCEPTION 'no estimate % in %', NEW.estimated_source_key, to_char(NEW.month, 'YYYY-MM')
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- A link that hides an estimate never lands in a locked month (or one before a locked month).
  IF EXISTS (SELECT 1 FROM periods WHERE month >= NEW.month AND status = 'locked') THEN
    RAISE EXCEPTION 'period % is locked: its figures never move', to_char(NEW.month, 'YYYY-MM')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- A system actor that links an estimate arriving after its month was invoiced (ingest calls it).
INSERT INTO users (id, issuer, subject, email, name, kind)
VALUES ('invoices', 'landledger', 'invoices', NULL, 'Invoices: late estimates linked as they arrive', 'system')
ON CONFLICT (id) DO NOTHING;

-- Should-fix 12: back-channel logout keeps each token's hash and iat for the audit -----------------------------------
ALTER TABLE logout_tokens ADD COLUMN token_sha256 text;
ALTER TABLE logout_tokens ADD COLUMN iat timestamptz;

-- Should-fix 13: anomalies -----------------------------------------------------------------------------------------
-- A cost anomaly's figure as the day accrues: one row per scan that saw it higher; `alerted` when it doubled since the
-- last alert (a second `cost.anomaly`).
CREATE TABLE anomaly_observations (
  id              text PRIMARY KEY,
  anomaly_id      text NOT NULL REFERENCES anomalies (id),
  observed_micros bigint NOT NULL,
  score           numeric,
  alerted         boolean NOT NULL DEFAULT false,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX anomaly_observations_anomaly ON anomaly_observations (anomaly_id, at DESC);
CREATE TRIGGER anomaly_observations_append_only BEFORE UPDATE OR DELETE ON anomaly_observations
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER anomaly_observations_no_truncate BEFORE TRUNCATE ON anomaly_observations
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Assigned (again and again) and closed once with an outcome; each a person's, audited.
CREATE TABLE anomaly_actions (
  id          text PRIMARY KEY,
  anomaly_id  text NOT NULL REFERENCES anomalies (id),
  action      text NOT NULL CHECK (action IN ('assigned','closed')),
  by_user     text NOT NULL REFERENCES users (id),
  assignee    text REFERENCES users (id),
  outcome     text CHECK (outcome IN ('expected','fixed','false_positive')),
  note        text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'assigned') = (assignee IS NOT NULL)),
  CHECK ((action = 'closed') = (outcome IS NOT NULL)),
  CHECK (action <> 'closed' OR length(note) >= 3)
);
CREATE UNIQUE INDEX anomaly_actions_closed_once ON anomaly_actions (anomaly_id) WHERE action = 'closed';
CREATE INDEX anomaly_actions_anomaly ON anomaly_actions (anomaly_id, at DESC);
CREATE TRIGGER anomaly_actions_append_only BEFORE UPDATE OR DELETE ON anomaly_actions
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER anomaly_actions_no_truncate BEFORE TRUNCATE ON anomaly_actions
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Should-fix 4 and 5: seats ------------------------------------------------------------------------------------------
-- A seat is reserved, then applied (Landbright granted) or released (access denied, or expired unapplied after 30
-- days); an applied seat is released when the grant is revoked. Why it closed is kept.
ALTER TABLE seat_reservations ADD COLUMN close_reason text
  CHECK (close_reason IS NULL OR close_reason IN ('access_denied','grant_revoked','not_needed','expired'));
-- When Landbright granted it: an applied seat keeps this when it is released later, so seats used stay right.
ALTER TABLE seat_reservations ADD COLUMN applied_at timestamptz;
CREATE OR REPLACE FUNCTION seat_reservations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'seat reservations are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM requests WHERE id = NEW.request_id AND status IN ('approved','applied')) THEN
      RAISE EXCEPTION 'only an approved request reserves a seat' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'reserved' AND NEW.status IN ('applied','released'))
          OR (OLD.status = 'applied' AND NEW.status = 'released')
          -- the backfill below: an applied seat takes its applied_at once
          OR (OLD.status = 'applied' AND NEW.status = 'applied' AND OLD.applied_at IS NULL
              AND NEW.applied_at IS NOT NULL AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at))
     OR (to_jsonb(NEW) - 'status' - 'closed_at' - 'close_reason' - 'applied_at')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'closed_at' - 'close_reason' - 'applied_at')
     OR (OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at) THEN
    RAISE EXCEPTION 'seat reservation %: reserved, then applied or released; applied, then released', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
UPDATE seat_reservations SET applied_at = closed_at WHERE status = 'applied' AND applied_at IS NULL;

-- Seats used, as of the day the CSV's count was taken: seats applied after that day count on top of it.
ALTER TABLE contract_versions ADD COLUMN seats_used_as_of date;

-- Should-fix 15: a reminder before the notice date and an alert when it passed, once per contract, renewal and day.
CREATE TABLE contract_notices (
  contract_id   text NOT NULL,
  renewal_date  date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('reminder','missed')),
  day           date NOT NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, renewal_date, kind, day)
);
CREATE TRIGGER contract_notices_append_only BEFORE UPDATE OR DELETE ON contract_notices
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();

-- Should-fix 9: the access review ------------------------------------------------------------------------------------
ALTER TABLE access_review_items DROP CONSTRAINT access_review_items_kind_check;
ALTER TABLE access_review_items ADD CONSTRAINT access_review_items_kind_check
  CHECK (kind IN ('person','key','link','relay_channel','owner','webhook','session'));
-- Items the review picked up after it opened (a key minted, a deputy named): null for the opening snapshot.
ALTER TABLE access_review_items ADD COLUMN added_at timestamptz;
-- Who attests an item nobody in Landledger stands behind (a key a system minted): the CFO only.
ALTER TABLE access_review_items ADD COLUMN cfo_only boolean NOT NULL DEFAULT false;

-- What Landledger revoked itself when an attester chose revoke and confirmed (keys, links, sessions); the rest is
-- tracked until the access is gone.
CREATE TABLE access_review_revocations (
  item_id     text PRIMARY KEY REFERENCES access_review_items (id),
  how         text NOT NULL,
  by_user     text NOT NULL REFERENCES users (id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER access_review_revocations_append_only BEFORE UPDATE OR DELETE ON access_review_revocations
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();

-- Reminders while a quarter's review is not complete, and a quarter that ended without one.
CREATE TABLE access_review_events (
  quarter   text NOT NULL CHECK (quarter ~ '^\d{4}-Q[1-4]$'),
  kind      text NOT NULL CHECK (kind IN ('reminder','missed')),
  day       date NOT NULL,
  sent_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quarter, kind, day)
);
CREATE TRIGGER access_review_events_append_only BEFORE UPDATE OR DELETE ON access_review_events
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();

-- A relay channel's creator by user id, so an email change never lets them attest their own channel.
ALTER TABLE relay_channels ADD COLUMN created_by_user text REFERENCES users (id);
UPDATE relay_channels c SET created_by_user = u.id FROM users u
WHERE u.email = c.created_by AND u.kind = 'person' AND c.created_by_user IS NULL;

-- The app ---------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON anomaly_observations, anomaly_actions, contract_notices, access_review_revocations,
  access_review_events TO landledger_app;
GRANT UPDATE (status, closed_at, close_reason, applied_at) ON seat_reservations TO landledger_app;
