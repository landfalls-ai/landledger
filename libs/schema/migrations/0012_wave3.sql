-- 0012_wave3: wave 3, "Plan and reconcile" (specs 005–011). Invoices and their lines, reconciliation snapshots,
-- invoice links keyed by estimate and invoiced record; anomalies and their acknowledgements, and the `dev-anomaly`
-- source for a test spike; contracts (versioned), seat reservations and renewal alerts, the `contract` request kind
-- and its policy; the access review. Shipped migrations are never edited: a change is a new file.

-- Sources: `dev-anomaly` is a test spike's own source (spec 007), never a real one, reversed after the test --------

ALTER TABLE cost_records DROP CONSTRAINT cost_records_source_check;
ALTER TABLE cost_records ADD CONSTRAINT cost_records_source_check
  CHECK (source IN ('landflow','clickland','invoice','manual','dev-anomaly'));
ALTER TABLE provisional_usage DROP CONSTRAINT cost_records_source_check;
ALTER TABLE provisional_usage ADD CONSTRAINT provisional_usage_source_check
  CHECK (source IN ('landflow','clickland','invoice','manual','dev-anomaly'));
ALTER TABLE ingest_runs DROP CONSTRAINT ingest_runs_source_check;
ALTER TABLE ingest_runs ADD CONSTRAINT ingest_runs_source_check
  CHECK (source IN ('landflow','clickland','invoice','manual','dev-anomaly'));

-- 005 Invoices ----------------------------------------------------------------------------------------------------

-- One row per imported version of a provider's invoice (or its void). The newest version is the invoice.
CREATE TABLE invoices (
  id             text NOT NULL,
  version        integer NOT NULL CHECK (version >= 1),
  provider       text NOT NULL CHECK (provider <> ''),
  number         text NOT NULL CHECK (number <> ''),
  month          date NOT NULL CHECK (landledger_first_of_month(month)),
  status         text NOT NULL CHECK (status IN ('posted','voided')),
  origin         text NOT NULL DEFAULT 'entered' CHECK (origin IN ('entered','dev-fixture')),
  total_micros   bigint NOT NULL,
  currency       char(3) NOT NULL CHECK (currency = 'USD'),
  correction     boolean NOT NULL DEFAULT false,
  added          integer NOT NULL DEFAULT 0,
  reversed       integer NOT NULL DEFAULT 0,
  unchanged      integer NOT NULL DEFAULT 0,
  linked         integer NOT NULL DEFAULT 0,
  ingest_run_id  text NOT NULL REFERENCES ingest_runs (id),
  file_name      text,
  file_sha256    text NOT NULL,
  note           text NOT NULL DEFAULT '',
  imported_by    text NOT NULL REFERENCES users (id),
  imported_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);
CREATE INDEX invoices_month ON invoices (month);
CREATE TRIGGER invoices_append_only BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER invoices_no_truncate BEFORE TRUNCATE ON invoices
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

CREATE TABLE invoice_lines (
  invoice_id       text NOT NULL,
  version          integer NOT NULL,
  line             integer NOT NULL CHECK (line >= 1),
  model            text,
  sku              text,
  quantity         numeric,
  unit             text,
  amount_micros    bigint NOT NULL,
  charge_category  text NOT NULL CHECK (charge_category IN ('Usage','Purchase','Tax','Credit','Adjustment')),
  description      text NOT NULL DEFAULT '',
  PRIMARY KEY (invoice_id, version, line),
  FOREIGN KEY (invoice_id, version) REFERENCES invoices (id, version),
  CHECK (model IS NOT NULL OR sku IS NOT NULL)
);
CREATE TRIGGER invoice_lines_append_only BEFORE UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER invoice_lines_no_truncate BEFORE TRUNCATE ON invoice_lines
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- A reconciliation as it stood when an invoice was imported (the live one is computed when read).
CREATE TABLE reconciliations (
  id                 text PRIMARY KEY,
  invoice_id         text NOT NULL,
  invoice_version    integer NOT NULL,
  month              date NOT NULL CHECK (landledger_first_of_month(month)),
  provider           text NOT NULL,
  model              text NOT NULL,
  estimated_micros   bigint NOT NULL,
  invoiced_micros    bigint NOT NULL,
  variance_micros    bigint NOT NULL CHECK (variance_micros = invoiced_micros - estimated_micros),
  tolerance_pct      numeric NOT NULL,
  status             text NOT NULL CHECK (status IN ('matched','outside','not_invoiced','no_estimate')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invoice_id, invoice_version) REFERENCES invoices (id, version)
);
CREATE TRIGGER reconciliations_append_only BEFORE UPDATE OR DELETE ON reconciliations
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER reconciliations_no_truncate BEFORE TRUNCATE ON reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- An estimate can be replaced by a later invoice once the one before was voided: one link per estimate and invoiced
-- record. Reads leave an estimate out while any live invoiced entry exists for the source key of a record it is
-- linked to (a re-entered invoice keeps it replaced; a voided one gives it back).
ALTER TABLE invoice_estimate_links DROP CONSTRAINT invoice_estimate_links_pkey;
ALTER TABLE invoice_estimate_links ADD PRIMARY KEY (estimated_source_key, invoiced_record_id);
CREATE INDEX invoice_estimate_links_estimate ON invoice_estimate_links (estimated_source_key);

-- 007 Anomalies ---------------------------------------------------------------------------------------------------

CREATE TABLE anomalies (
  id             text PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('cost','approval')),
  rule           text NOT NULL CHECK (rule IN ('cost_jump','split','automatic_ratchet','fast_relay','same_pair')),
  dimension      text NOT NULL,
  key            text NOT NULL,
  label          text NOT NULL,
  window_start   timestamptz NOT NULL,
  window_end     timestamptz NOT NULL,
  summary        text NOT NULL,
  observed_micros  bigint,
  baseline_micros  bigint,
  mad_micros       bigint,
  score          numeric,
  cost_center    text,
  request_ids    text[] NOT NULL DEFAULT '{}',
  details        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  detected_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, rule, dimension, key, window_start)
);
CREATE INDEX anomalies_recent ON anomalies (detected_at DESC);
CREATE TRIGGER anomalies_append_only BEFORE UPDATE OR DELETE ON anomalies
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER anomalies_no_truncate BEFORE TRUNCATE ON anomalies
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

CREATE TABLE anomaly_acks (
  anomaly_id  text PRIMARY KEY REFERENCES anomalies (id),
  by_user     text NOT NULL REFERENCES users (id),
  note        text NOT NULL CHECK (length(note) >= 3),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER anomaly_acks_append_only BEFORE UPDATE OR DELETE ON anomaly_acks
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER anomaly_acks_no_truncate BEFORE TRUNCATE ON anomaly_acks
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- 009 Contracts and 010 seats -------------------------------------------------------------------------------------

CREATE TABLE contract_versions (
  id               text NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  vendor           text NOT NULL CHECK (vendor <> ''),
  product          text NOT NULL CHECK (product <> ''),
  cost_center      text NOT NULL REFERENCES cost_center_codes (code),
  tcv_micros       bigint NOT NULL CHECK (tcv_micros >= 0),
  currency         char(3) NOT NULL CHECK (currency = 'USD'),
  term_start       date NOT NULL,
  term_end         date NOT NULL CHECK (term_end >= term_start),
  term_months      integer NOT NULL CHECK (term_months BETWEEN 1 AND 120),
  seats_paid       integer CHECK (seats_paid IS NULL OR seats_paid >= 0),
  seats_used       integer CHECK (seats_used IS NULL OR seats_used >= 0),
  renewal_date     date NOT NULL,
  notice_days      integer NOT NULL CHECK (notice_days BETWEEN 0 AND 365),
  auto_renew       boolean NOT NULL DEFAULT true,
  landbright_app   text,
  origin           text NOT NULL CHECK (origin IN ('entered','dev-fixture','request')),
  request_id       text REFERENCES requests (id),
  note             text NOT NULL DEFAULT '',
  imported_by      text NOT NULL REFERENCES users (id),
  imported_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version),
  CHECK ((seats_paid IS NULL) = (seats_used IS NULL))
);
CREATE TRIGGER contract_versions_append_only BEFORE UPDATE OR DELETE ON contract_versions
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER contract_versions_no_truncate BEFORE TRUNCATE ON contract_versions
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- A seat an approved request takes from a contract: reserved, then applied (Landbright granted) or released.
CREATE TABLE seat_reservations (
  id           text PRIMARY KEY,
  contract_id  text NOT NULL,
  request_id   text NOT NULL UNIQUE REFERENCES requests (id),
  seats        integer NOT NULL CHECK (seats >= 1),
  status       text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','applied','released')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  CHECK ((status = 'reserved') = (closed_at IS NULL))
);
CREATE FUNCTION seat_reservations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.status <> 'reserved'
     OR (to_jsonb(NEW) - 'status' - 'closed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'closed_at') THEN
    RAISE EXCEPTION 'seat reservation %: reserved, then applied or released, once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER seat_reservations_guard BEFORE INSERT OR UPDATE OR DELETE ON seat_reservations
  FOR EACH ROW EXECUTE FUNCTION seat_reservations_guard();
CREATE TRIGGER seat_reservations_no_truncate BEFORE TRUNCATE ON seat_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- contract.renewal_due is sent once per contract and renewal date.
CREATE TABLE contract_alerts (
  contract_id   text NOT NULL,
  renewal_date  date NOT NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, renewal_date)
);
CREATE TRIGGER contract_alerts_append_only BEFORE UPDATE OR DELETE ON contract_alerts
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();

-- Requests: the `contract` kind with its terms, and a seat request's terms.
ALTER TABLE requests DROP CONSTRAINT requests_kind_check;
ALTER TABLE requests ADD CONSTRAINT requests_kind_check CHECK (kind IN ('infra_change','ai_budget','tool_or_seat',
  'rate_card_change','rule_set_change','policy_change','other','contract'));
ALTER TABLE requests ADD COLUMN contract jsonb CHECK (contract IS NULL OR jsonb_typeof(contract) = 'object');
ALTER TABLE requests ADD COLUMN seat jsonb CHECK (seat IS NULL OR jsonb_typeof(seat) = 'object');
ALTER TABLE requests ADD CONSTRAINT requests_contract_terms CHECK ((kind = 'contract') = (contract IS NOT NULL));
ALTER TABLE requests ADD CONSTRAINT requests_seat_terms CHECK (seat IS NULL OR kind = 'tool_or_seat');
ALTER TABLE policies DROP CONSTRAINT policies_kind_check;
ALTER TABLE policies ADD CONSTRAINT policies_kind_check CHECK (kind IN ('infra_change','ai_budget','tool_or_seat',
  'rate_card_change','rule_set_change','policy_change','other','contract'));

-- The contract policy (a default, docs/plan.md decision 9): never automatic; the budget owner and Finance always, the
-- CFO above USD 25,000 of total contract value.
INSERT INTO policies (id, kind, version, definition, note, origin, status, proposed_by, approved_at)
VALUES ('pol_contract_1', 'contract', 1, jsonb_build_object('automaticBelow', NULL, 'steps', jsonb_build_array(
  '{"key":"budget_owner","label":"Budget owner","approvers":{"groups":["Budget Owners"],"costCenterOwner":true},"when":{"always":true}}'::jsonb,
  '{"key":"finance","label":"Finance","approvers":{"groups":["Finance Controllers","Finance CFO"],"costCenterOwner":false},"when":{"always":true}}'::jsonb,
  '{"key":"cfo","label":"CFO","approvers":{"groups":["Finance CFO"],"costCenterOwner":false},"when":{"amountAbove":"25000"}}'::jsonb)),
  'A contract is approved for its total contract value and term: the budget owner and Finance always, the CFO above USD 25,000 (docs/plan.md, decision 9, a default to confirm).',
  'decision', 'approved', 'seed', '2026-11-15T00:00:00Z');

-- 011 Access review -----------------------------------------------------------------------------------------------

CREATE TABLE access_reviews (
  id            text PRIMARY KEY,
  quarter       text NOT NULL UNIQUE CHECK (quarter ~ '^\d{4}-Q[1-4]$'),
  opened_by     text NOT NULL REFERENCES users (id),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE FUNCTION access_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'access reviews are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL
     OR (to_jsonb(NEW) - 'completed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'completed_at') THEN
    RAISE EXCEPTION 'an access review is completed once and never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER access_reviews_guard BEFORE UPDATE OR DELETE ON access_reviews
  FOR EACH ROW EXECUTE FUNCTION access_reviews_guard();

CREATE TABLE access_review_items (
  id          text PRIMARY KEY,
  review_id   text NOT NULL REFERENCES access_reviews (id),
  kind        text NOT NULL CHECK (kind IN ('person','key','link','relay_channel','owner')),
  subject_id  text NOT NULL,
  label       text NOT NULL,
  detail      text NOT NULL,
  -- People the item is about (its person, a key's minter, a link's or ownership's person): they never attest it.
  about       text[] NOT NULL DEFAULT '{}',
  snapshot    jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  UNIQUE (review_id, kind, subject_id)
);
CREATE TRIGGER access_review_items_append_only BEFORE UPDATE OR DELETE ON access_review_items
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();

CREATE TABLE access_review_attestations (
  item_id     text PRIMARY KEY REFERENCES access_review_items (id),
  decision    text NOT NULL CHECK (decision IN ('keep','revoke')),
  comment     text NOT NULL DEFAULT '',
  by_user     text NOT NULL REFERENCES users (id),
  at          timestamptz NOT NULL DEFAULT now(),
  CHECK (decision = 'keep' OR length(comment) >= 3)
);
CREATE FUNCTION access_review_attestations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item access_review_items;
BEGIN
  SELECT * INTO item FROM access_review_items WHERE id = NEW.item_id;
  IF NEW.by_user = ANY (item.about) THEN
    RAISE EXCEPTION 'nobody attests their own access' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.by_user AND kind = 'person' AND active) THEN
    RAISE EXCEPTION 'an attestation is a person''s' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER access_review_attestations_guard BEFORE INSERT ON access_review_attestations
  FOR EACH ROW EXECUTE FUNCTION access_review_attestations_guard();
CREATE TRIGGER access_review_attestations_append_only BEFORE UPDATE OR DELETE ON access_review_attestations
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();

CREATE TABLE access_review_notices (
  quarter   text PRIMARY KEY,
  sent_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER access_review_notices_append_only BEFORE UPDATE OR DELETE ON access_review_notices
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();

-- The app ---------------------------------------------------------------------------------------------------------

GRANT SELECT, INSERT ON invoices, invoice_lines, reconciliations, anomalies, anomaly_acks, contract_versions,
  seat_reservations, contract_alerts, access_reviews, access_review_items, access_review_attestations,
  access_review_notices TO landledger_app;
GRANT UPDATE (status, closed_at) ON seat_reservations TO landledger_app;
GRANT UPDATE (completed_at) ON access_reviews TO landledger_app;
