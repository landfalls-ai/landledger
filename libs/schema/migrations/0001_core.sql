-- 0001_core: the tables wave 1 stands on (docs/architecture.md, "The data"; specs 001 and 002).
-- Money is bigint micro-units (10⁻⁶ of the major unit) + char(3) ISO 4217 currency; rates and quantities are numeric
-- (exact); never floats. Allocation (spec 003), budgets, requests, policies, decisions, reservations, contracts and
-- invoices come in later migrations.
-- Shipped migrations are never edited: a change is a new file (libs/schema refuses a changed checksum).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Shared guards ------------------------------------------------------------------------------------------------------

-- Append-only tables refuse UPDATE, DELETE and TRUNCATE: a correction is a new row.
CREATE FUNCTION landledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation', HINT = 'Append a correcting row instead.';
END $$;

CREATE FUNCTION landledger_first_of_month(d date) RETURNS boolean LANGUAGE sql IMMUTABLE AS
  $$ SELECT extract(day FROM d) = 1 $$;

-- Who ----------------------------------------------------------------------------------------------------------------

-- People who signed in through Landbright (OIDC); later also pushed by SCIM.
CREATE TABLE users (
  id            text PRIMARY KEY,
  issuer        text NOT NULL,
  subject       text NOT NULL,
  email         text,
  name          text NOT NULL,
  roles         text[] NOT NULL DEFAULT '{}',
  groups        text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject),
  CHECK (roles <@ ARRAY['cfo','controller','fpa','budget_owner','auditor','engineer']::text[])
);

-- Landbright groups seen in the `roles` claim, and the Landledger role each maps to (null: ignored).
CREATE TABLE groups (
  name           text PRIMARY KEY,
  role           text CHECK (role IN ('cfo','controller','fpa','budget_owner','auditor','engineer')),
  source         text NOT NULL DEFAULT 'claim' CHECK (source IN ('claim','scim')),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

-- Console sessions: the cookie carries a random token; only its sha256 is kept.
CREATE TABLE sessions (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  id_token      text,
  user_agent    text,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Sign-ins in flight (authorization code + PKCE): state, verifier and nonce until the callback, ten minutes at most.
CREATE TABLE auth_requests (
  state_hash     text PRIMARY KEY,
  code_verifier  text NOT NULL,
  nonce          text NOT NULL,
  return_to      text NOT NULL DEFAULT '/',
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);

-- API keys `ll_…`: shown once, stored as sha256. No scope decides a request.
CREATE TABLE api_keys (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  prefix        text NOT NULL,
  hash          text NOT NULL UNIQUE,
  scopes        text[] NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  CHECK (cardinality(scopes) > 0),
  CHECK (scopes <@ ARRAY['read','requests:write','reservations:write','decisions:relay','ingest','admin']::text[])
);

-- Dimensions (versioned: a change is a new version; valid_to closes the one before) -------------------------------

CREATE TABLE cost_centers (
  code           text NOT NULL,
  version        integer NOT NULL CHECK (version >= 1),
  name           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  owner_name     text,
  owner_subject  text,
  valid_from     date NOT NULL,
  valid_to       date,
  origin         text NOT NULL DEFAULT 'entered' CHECK (origin IN ('entered','scim','datarails','csv','dev-seed')),
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, version),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (code WITH =, daterange(valid_from, valid_to) WITH &&)
);

CREATE TABLE teams (
  code              text NOT NULL,
  version           integer NOT NULL CHECK (version >= 1),
  name              text NOT NULL,
  cost_center_code  text,
  owner_name        text,
  owner_subject     text,
  valid_from        date NOT NULL,
  valid_to          date,
  origin            text NOT NULL DEFAULT 'entered' CHECK (origin IN ('entered','scim','datarails','csv','dev-seed')),
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, version),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (code WITH =, daterange(valid_from, valid_to) WITH &&)
);

CREATE TABLE products (
  code           text NOT NULL,
  version        integer NOT NULL CHECK (version >= 1),
  name           text NOT NULL,
  owner_name     text,
  owner_subject  text,
  valid_from     date NOT NULL,
  valid_to       date,
  origin         text NOT NULL DEFAULT 'entered' CHECK (origin IN ('entered','scim','datarails','csv','dev-seed')),
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, version),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (code WITH =, daterange(valid_from, valid_to) WITH &&)
);

-- Rate cards (spec 002's shape): a version is a proposal until a person approves it; approved versions of one card
-- never overlap; an approved version's lines never change, and it only gets an end date when the next one takes over.

CREATE TABLE rate_cards (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  owner       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_card_versions (
  id               text PRIMARY KEY,
  rate_card_id     text NOT NULL REFERENCES rate_cards (id),
  version          integer NOT NULL CHECK (version >= 1),
  effective_from   date NOT NULL,
  effective_to     date,
  hours_per_month  numeric NOT NULL DEFAULT 730 CHECK (hours_per_month > 0),
  note             text NOT NULL DEFAULT '',
  proposed_by      text NOT NULL,
  proposed_at      timestamptz NOT NULL DEFAULT now(),
  approved_by      text REFERENCES users (id),
  approved_at      timestamptz,
  UNIQUE (rate_card_id, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  EXCLUDE USING gist (rate_card_id WITH =, daterange(effective_from, effective_to) WITH &&) WHERE (approved_at IS NOT NULL)
);

CREATE FUNCTION rate_card_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rate card versions are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.approved_at IS NULL THEN
    -- A proposal changes only by being approved (by a person: approved_by references users).
    IF NEW.approved_at IS NULL OR (to_jsonb(NEW) - 'approved_by' - 'approved_at')
                                   IS DISTINCT FROM (to_jsonb(OLD) - 'approved_by' - 'approved_at') THEN
      RAISE EXCEPTION 'a proposed rate card version only gets approved; a change is a new proposal'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF OLD.effective_to IS NOT NULL
     OR (to_jsonb(NEW) - 'effective_to') IS DISTINCT FROM (to_jsonb(OLD) - 'effective_to') THEN
    RAISE EXCEPTION 'an approved rate card version only gets an end date; anything else is a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rate_card_versions_guard BEFORE UPDATE OR DELETE ON rate_card_versions
  FOR EACH ROW EXECUTE FUNCTION rate_card_versions_guard();

-- One price line: a unit price per pricing unit (FOCUS Unit Format) for a SKU and meter.
CREATE TABLE rate_lines (
  id             text PRIMARY KEY,
  version_id     text NOT NULL REFERENCES rate_card_versions (id),
  sku_id         text NOT NULL,
  sku_price_id   text NOT NULL,
  sku_meter      text NOT NULL,
  label          text NOT NULL,
  provider       text,
  model          text,
  pricing_unit   text NOT NULL,
  unit_price     numeric NOT NULL CHECK (unit_price >= 0),
  currency       char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  details        jsonb CHECK (details IS NULL OR jsonb_typeof(details) = 'object'),
  position       integer NOT NULL DEFAULT 0,
  UNIQUE (version_id, sku_price_id)
);

CREATE FUNCTION rate_lines_proposal_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM rate_card_versions WHERE id = NEW.version_id AND approved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'rate card version % is approved: its lines never change', NEW.version_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rate_lines_proposal_only BEFORE INSERT ON rate_lines
  FOR EACH ROW EXECUTE FUNCTION rate_lines_proposal_only();
CREATE TRIGGER rate_lines_append_only BEFORE UPDATE OR DELETE ON rate_lines
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER rate_lines_no_truncate BEFORE TRUNCATE ON rate_lines
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- FX rates (spec 001): append only; the rate for a day is the latest recorded one for the latest date on or before it.

CREATE TABLE fx_rates (
  id           text PRIMARY KEY,
  base         char(3) NOT NULL CHECK (base ~ '^[A-Z]{3}$'),
  quote        char(3) NOT NULL CHECK (quote ~ '^[A-Z]{3}$'),
  rate_date    date NOT NULL,
  rate         numeric NOT NULL CHECK (rate > 0),
  source       text NOT NULL,
  recorded_by  text NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (base <> quote)
);
CREATE INDEX fx_rates_lookup ON fx_rates (base, quote, rate_date DESC, recorded_at DESC);
CREATE TRIGGER fx_rates_append_only BEFORE UPDATE OR DELETE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER fx_rates_no_truncate BEFORE TRUNCATE ON fx_rates
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Periods (spec 001): each UTC month open → closing → locked, one step at a time, by a person; locked is final (FOCUS
-- Closed) and months lock in order. The first record of a month creates it open.

CREATE TABLE periods (
  month       date PRIMARY KEY CHECK (landledger_first_of_month(month)),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closing','locked')),
  opened_at   timestamptz NOT NULL DEFAULT now(),
  closing_by  text REFERENCES users (id),
  closing_at  timestamptz,
  locked_by   text REFERENCES users (id),
  locked_at   timestamptz,
  CHECK ((status = 'open') = (closing_by IS NULL AND closing_at IS NULL)),
  CHECK ((status = 'locked') = (locked_by IS NOT NULL AND locked_at IS NOT NULL)),
  CHECK (status <> 'open' OR locked_by IS NULL)
);

CREATE FUNCTION periods_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'periods are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'locked' THEN
    RAISE EXCEPTION 'period % is locked: it never reopens; corrections go to the open month', OLD.month
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.month <> OLD.month OR NEW.opened_at <> OLD.opened_at
     OR NOT ((OLD.status = 'open' AND NEW.status = 'closing') OR (OLD.status = 'closing' AND NEW.status = 'locked'))
     OR (OLD.status = 'closing' AND (NEW.closing_by, NEW.closing_at) IS DISTINCT FROM (OLD.closing_by, OLD.closing_at)) THEN
    RAISE EXCEPTION 'a period moves one step forward: open → closing → locked' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'locked' AND EXISTS (SELECT 1 FROM periods WHERE month < NEW.month AND status <> 'locked') THEN
    RAISE EXCEPTION 'lock the months before % first', NEW.month USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER periods_forward_only BEFORE UPDATE OR DELETE ON periods
  FOR EACH ROW EXECUTE FUNCTION periods_forward_only();
CREATE TRIGGER periods_no_truncate BEFORE TRUNCATE ON periods
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Ingest runs (spec 002's shape): one row per run, finished once; never deleted.

CREATE TABLE ingest_runs (
  id                    text PRIMARY KEY,
  source                text NOT NULL CHECK (source IN ('landflow','clickland','invoice','manual')),
  kind                  text NOT NULL CHECK (kind IN ('hourly','daily','backfill','manual')),
  day                   date NOT NULL,
  rate_card_version_id  text REFERENCES rate_card_versions (id),
  params                jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),
  started_by            text NOT NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  outcome               text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running','succeeded','failed')),
  read_count            integer NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  new_count             integer NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  corrected_count       integer NOT NULL DEFAULT 0 CHECK (corrected_count >= 0),
  unchanged_count       integer NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  warnings              jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings) = 'array'),
  error                 text,
  CHECK ((outcome = 'running') = (finished_at IS NULL))
);
CREATE INDEX ingest_runs_recent ON ingest_runs (source, started_at DESC);

CREATE FUNCTION ingest_runs_finish_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ingest runs are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.outcome <> 'running'
     OR (to_jsonb(NEW) - 'finished_at' - 'outcome' - 'read_count' - 'new_count' - 'corrected_count' - 'unchanged_count'
         - 'warnings' - 'error')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'finished_at' - 'outcome' - 'read_count' - 'new_count' - 'corrected_count' - 'unchanged_count'
         - 'warnings' - 'error') THEN
    RAISE EXCEPTION 'an ingest run is finished once; its source, day and parameters never change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ingest_runs_finish_once BEFORE UPDATE OR DELETE ON ingest_runs
  FOR EACH ROW EXECUTE FUNCTION ingest_runs_finish_once();

-- Cost records (spec 001): FOCUS 1.4 columns in snake case (libs/focus maps them) and Landledger's x_ columns.
-- Amounts are bigint micro-units (10⁻⁶) of billing_currency; prices and quantities numeric. Append only: a correction
-- is a reversal (every additive column negated, correction_of_id = the original) and a re-entry. Partitioned by
-- billing month; a locked month refuses inserts. One live entry per source key and basis: a re-entry needs the
-- previous one reversed, and source_revision counts them.

CREATE FUNCTION landledger_next_month(t timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS
  $$ SELECT ((t AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' $$;

CREATE TABLE cost_records (
  seq                       bigint GENERATED ALWAYS AS IDENTITY,
  record_id                 text NOT NULL,
  basis                     text NOT NULL CHECK (basis IN ('estimated','invoiced')),
  source                    text NOT NULL CHECK (source IN ('landflow','clickland','invoice','manual')),
  source_key                text NOT NULL CHECK (source_key <> ''),
  source_revision           integer NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  is_reversal               boolean GENERATED ALWAYS AS (correction_of_id IS NOT NULL) STORED,
  source_cost               numeric,
  rate_card_version_id      text REFERENCES rate_card_versions (id),
  ingest_run_id             text NOT NULL REFERENCES ingest_runs (id),
  correction_of_id          text,
  workflow_id               text,
  agent_id                  text,
  actor_id                  text,

  billed_cost_micros        bigint NOT NULL,
  effective_cost_micros     bigint NOT NULL,
  list_cost_micros          bigint NOT NULL,
  contracted_cost_micros    bigint NOT NULL,
  list_unit_price           numeric CHECK (list_unit_price >= 0),
  contracted_unit_price     numeric CHECK (contracted_unit_price >= 0),
  pricing_quantity          numeric,
  pricing_unit              text,
  consumed_quantity         numeric,
  consumed_unit             text,
  billing_currency          char(3) NOT NULL CHECK (billing_currency ~ '^[A-Z]{3}$'),

  charge_period_start       timestamptz NOT NULL,
  charge_period_end         timestamptz NOT NULL,
  billing_period_start      timestamptz NOT NULL,
  billing_period_end        timestamptz NOT NULL,

  charge_category           text NOT NULL CHECK (charge_category IN ('Usage','Purchase','Tax','Credit','Adjustment')),
  charge_class              text CHECK (charge_class = 'Correction'),
  charge_description        text,
  charge_frequency          text NOT NULL CHECK (charge_frequency IN ('One-Time','Recurring','Usage-Based')),
  pricing_category          text CHECK (pricing_category IN ('Standard','Dynamic','Committed','Other')),
  service_category          text NOT NULL CHECK (service_category IN ('AI and Machine Learning','Analytics',
                              'Business Applications','Compute','Databases','Developer Tools','Multicloud','Identity',
                              'Integration','Internet of Things','Management and Governance','Media','Migration',
                              'Mobile','Networking','Security','Storage','Web','Other')),
  service_subcategory       text NOT NULL,
  service_name              text NOT NULL,
  service_provider_name     text NOT NULL,
  host_provider_name        text,
  invoice_issuer_name       text NOT NULL,
  billing_account_id        text NOT NULL,
  billing_account_name      text,
  sub_account_id            text,
  sub_account_name          text,
  sub_account_type          text,
  invoice_id                text,

  resource_id               text,
  resource_name             text,
  resource_type             text,
  sku_id                    text,
  sku_meter                 text,
  sku_price_id              text,
  sku_price_details         jsonb CHECK (sku_price_details IS NULL OR jsonb_typeof(sku_price_details) = 'object'),
  tags                      jsonb CHECK (tags IS NULL OR jsonb_typeof(tags) = 'object'),

  allocated_method_id       text,
  allocated_method_details  jsonb CHECK (allocated_method_details IS NULL
                                         OR jsonb_typeof(allocated_method_details) = 'object'),
  allocated_resource_id     text,
  allocated_resource_name   text,
  allocated_tags            jsonb CHECK (allocated_tags IS NULL OR jsonb_typeof(allocated_tags) = 'object'),

  recorded_at               timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (record_id, billing_period_start),
  -- Estimated or invoiced (docs/research/focus.md §2)
  CONSTRAINT estimated_billed_zero CHECK (basis <> 'estimated' OR billed_cost_micros = 0),
  CONSTRAINT estimated_effective CHECK (basis <> 'estimated' OR effective_cost_micros = contracted_cost_micros),
  CONSTRAINT invoiced_usage_effective CHECK (basis <> 'invoiced' OR charge_category <> 'Usage'
                                             OR effective_cost_micros = billed_cost_micros),
  CONSTRAINT invoiced_no_rate_card CHECK (basis <> 'invoiced' OR rate_card_version_id IS NULL),
  -- Quantities with their units
  CHECK ((pricing_quantity IS NULL) = (pricing_unit IS NULL)),
  CHECK ((consumed_quantity IS NULL) = (consumed_unit IS NULL)),
  -- UTC days and months
  CONSTRAINT charge_period_utc_days CHECK (charge_period_start = date_trunc('day', charge_period_start, 'UTC')
                                           AND charge_period_end = date_trunc('day', charge_period_end, 'UTC')
                                           AND charge_period_end > charge_period_start),
  CONSTRAINT billing_period_utc_month CHECK (billing_period_start = date_trunc('month', billing_period_start, 'UTC')
                                             AND billing_period_end = landledger_next_month(billing_period_start)),
  -- ChargeClass only on a correction booked in a later month than the charge
  CONSTRAINT correction_class CHECK (
    (charge_class IS NULL AND date_trunc('month', charge_period_start, 'UTC') = billing_period_start)
    OR (charge_class IS NOT NULL AND charge_period_start < billing_period_start)),
  CHECK (correction_of_id IS NULL OR correction_of_id <> record_id)
) PARTITION BY RANGE (billing_period_start);

CREATE INDEX cost_records_seq ON cost_records (billing_period_start, seq);
CREATE INDEX cost_records_charge ON cost_records (charge_period_start);
CREATE INDEX cost_records_source_key ON cost_records (source_key, basis);
CREATE INDEX cost_records_ingest_run ON cost_records (ingest_run_id);

-- Every record's identity across partitions: record ids are unique, a record is reversed at most once, and
-- (source_key, basis, source_revision, is_reversal) is unique (a partitioned table can't hold those constraints).
CREATE TABLE cost_record_keys (
  record_id             text PRIMARY KEY,
  source_key            text NOT NULL,
  basis                 text NOT NULL,
  source_revision       integer NOT NULL,
  is_reversal           boolean NOT NULL,
  correction_of_id      text UNIQUE REFERENCES cost_record_keys (record_id),
  billing_period_start  timestamptz NOT NULL,
  UNIQUE (source_key, basis, source_revision, is_reversal),
  CHECK (is_reversal = (correction_of_id IS NOT NULL))
);
CREATE TRIGGER cost_record_keys_append_only BEFORE UPDATE OR DELETE ON cost_record_keys
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER cost_record_keys_no_truncate BEFORE TRUNCATE ON cost_record_keys
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

CREATE FUNCTION cost_records_enter() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m date := (NEW.billing_period_start AT TIME ZONE 'UTC')::date;
  st text;
  orig cost_record_keys;
  amounts record;
BEGIN
  -- The month: created open by its first record; a locked month (or one before a locked month) takes nothing.
  INSERT INTO periods (month) VALUES (m) ON CONFLICT DO NOTHING;
  SELECT status INTO st FROM periods WHERE month = m FOR SHARE;
  IF st = 'locked' OR EXISTS (SELECT 1 FROM periods WHERE month > m AND status = 'locked') THEN
    RAISE EXCEPTION 'period % is locked: book a correction in the open month', to_char(m, 'YYYY-MM')
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.correction_of_id IS NOT NULL THEN
    -- A reversal: of an entry (not a reversal) of the same key and basis, with every amount negated.
    SELECT * INTO orig FROM cost_record_keys WHERE record_id = NEW.correction_of_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'record % reverses %, which is not in the ledger', NEW.record_id, NEW.correction_of_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF orig.is_reversal OR orig.source_key <> NEW.source_key OR orig.basis <> NEW.basis THEN
      RAISE EXCEPTION 'a reversal reverses an entry of its own source key and basis, never another reversal'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT billed_cost_micros, effective_cost_micros, list_cost_micros, contracted_cost_micros, billing_currency
      INTO amounts FROM cost_records
      WHERE record_id = NEW.correction_of_id AND billing_period_start = orig.billing_period_start;
    IF amounts.billed_cost_micros <> -NEW.billed_cost_micros OR amounts.effective_cost_micros <> -NEW.effective_cost_micros
       OR amounts.list_cost_micros <> -NEW.list_cost_micros OR amounts.contracted_cost_micros <> -NEW.contracted_cost_micros
       OR amounts.billing_currency <> NEW.billing_currency THEN
      RAISE EXCEPTION 'a reversal negates every amount of the record it reverses' USING ERRCODE = 'check_violation';
    END IF;
    NEW.source_revision := orig.source_revision;
  ELSE
    -- An entry: only when the key has no live entry for this basis (reverse that first).
    PERFORM pg_advisory_xact_lock(hashtextextended('landledger:cost_records:' || NEW.basis || ':' || NEW.source_key, 0));
    IF EXISTS (SELECT 1 FROM cost_record_keys k
               WHERE k.source_key = NEW.source_key AND k.basis = NEW.basis AND NOT k.is_reversal
                 AND NOT EXISTS (SELECT 1 FROM cost_record_keys r WHERE r.correction_of_id = k.record_id)) THEN
      RAISE EXCEPTION '% (%) has a live entry: reverse it before a re-entry', NEW.source_key, NEW.basis
        USING ERRCODE = 'unique_violation';
    END IF;
    SELECT coalesce(max(source_revision) + 1, 0) INTO NEW.source_revision
      FROM cost_record_keys WHERE source_key = NEW.source_key AND basis = NEW.basis;
  END IF;

  INSERT INTO cost_record_keys (record_id, source_key, basis, source_revision, is_reversal, correction_of_id,
                                billing_period_start)
  VALUES (NEW.record_id, NEW.source_key, NEW.basis, NEW.source_revision, NEW.correction_of_id IS NOT NULL,
          NEW.correction_of_id, NEW.billing_period_start);
  RETURN NEW;
END $$;
CREATE TRIGGER cost_records_enter BEFORE INSERT ON cost_records
  FOR EACH ROW EXECUTE FUNCTION cost_records_enter();
CREATE TRIGGER cost_records_append_only BEFORE UPDATE OR DELETE ON cost_records
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER cost_records_no_truncate BEFORE TRUNCATE ON cost_records
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- A month's partition (UTC bounds), created ahead by this helper. Returns its name.
CREATE FUNCTION ensure_cost_records_partition(month date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  first date := date_trunc('month', month)::date;
  next date := (first + interval '1 month')::date;
  part text := 'cost_records_' || to_char(first, 'YYYY_MM');
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF cost_records FOR VALUES FROM (%L) TO (%L)',
      part, (first::timestamp AT TIME ZONE 'UTC'), (next::timestamp AT TIME ZONE 'UTC'));
    -- TRUNCATE triggers don't reach partitions from the parent; each one refuses it itself.
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only()',
      part || '_no_truncate', part);
  END IF;
  RETURN part;
END $$;

-- 2025 to 2027 exist from the start (backfill reaches 400 days back); ingest creates the month ahead as it goes.
SELECT ensure_cost_records_partition(make_date(y, m, 1))
FROM generate_series(2025, 2027) AS y, generate_series(1, 12) AS m;

-- The FOCUS view: FOCUS names, amounts as numeric(38,6) major units, date/times as UTC text, so an export is a select.
CREATE VIEW cost_records_focus AS
SELECT
  (billed_cost_micros::numeric / 1000000)::numeric(38,6)      AS "BilledCost",
  (effective_cost_micros::numeric / 1000000)::numeric(38,6)   AS "EffectiveCost",
  (list_cost_micros::numeric / 1000000)::numeric(38,6)        AS "ListCost",
  (contracted_cost_micros::numeric / 1000000)::numeric(38,6)  AS "ContractedCost",
  list_unit_price                                             AS "ListUnitPrice",
  contracted_unit_price                                       AS "ContractedUnitPrice",
  pricing_quantity                                            AS "PricingQuantity",
  pricing_unit                                                AS "PricingUnit",
  consumed_quantity                                           AS "ConsumedQuantity",
  consumed_unit                                               AS "ConsumedUnit",
  billing_currency::text                                      AS "BillingCurrency",
  to_char(charge_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')  AS "ChargePeriodStart",
  to_char(charge_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')    AS "ChargePeriodEnd",
  to_char(billing_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "BillingPeriodStart",
  to_char(billing_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')   AS "BillingPeriodEnd",
  charge_category          AS "ChargeCategory",
  charge_class             AS "ChargeClass",
  charge_description       AS "ChargeDescription",
  charge_frequency         AS "ChargeFrequency",
  pricing_category         AS "PricingCategory",
  service_category         AS "ServiceCategory",
  service_subcategory      AS "ServiceSubcategory",
  service_name             AS "ServiceName",
  service_provider_name    AS "ServiceProviderName",
  host_provider_name       AS "HostProviderName",
  invoice_issuer_name      AS "InvoiceIssuerName",
  billing_account_id       AS "BillingAccountId",
  billing_account_name     AS "BillingAccountName",
  sub_account_id           AS "SubAccountId",
  sub_account_name         AS "SubAccountName",
  sub_account_type         AS "SubAccountType",
  invoice_id               AS "InvoiceId",
  resource_id              AS "ResourceId",
  resource_name            AS "ResourceName",
  resource_type            AS "ResourceType",
  sku_id                   AS "SkuId",
  sku_meter                AS "SkuMeter",
  sku_price_id             AS "SkuPriceId",
  sku_price_details        AS "SkuPriceDetails",
  tags                     AS "Tags",
  allocated_method_id      AS "AllocatedMethodId",
  allocated_method_details AS "AllocatedMethodDetails",
  allocated_resource_id    AS "AllocatedResourceId",
  allocated_resource_name  AS "AllocatedResourceName",
  allocated_tags           AS "AllocatedTags",
  record_id                AS "x_RecordId",
  basis                    AS "x_Basis",
  source                   AS "x_Source",
  source_key               AS "x_SourceKey",
  source_cost              AS "x_SourceCost",
  rate_card_version_id     AS "x_RateCardVersion",
  ingest_run_id            AS "x_IngestRunId",
  correction_of_id         AS "x_CorrectionOfId",
  workflow_id              AS "x_WorkflowId",
  agent_id                 AS "x_AgentId",
  actor_id                 AS "x_ActorId"
FROM cost_records;

-- Provisional usage (spec 002): today's figures so far, the same row shape, replaced on each hourly run and never
-- summed with cost_records. Not a ledger: rows are deleted and rewritten per source and day.
CREATE TABLE provisional_usage (LIKE cost_records INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED);
ALTER TABLE provisional_usage
  ADD PRIMARY KEY (record_id),
  ADD UNIQUE (source, source_key, basis),
  ADD FOREIGN KEY (ingest_run_id) REFERENCES ingest_runs (id),
  ADD CONSTRAINT provisional_estimated CHECK (basis = 'estimated' AND correction_of_id IS NULL),
  ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY;
CREATE INDEX provisional_usage_day ON provisional_usage (source, charge_period_start);

-- The audit log: every change, each entry carrying the hash of the one before -----------------------------------
-- hash = sha256(prev_hash || canonical_json(entry)); the first entry's prev_hash is 64 zeros. GET /api/audit/verify
-- walks it. seq is assigned by the appender under a lock, so the chain has no gaps.

CREATE TABLE audit_log (
  seq           bigint PRIMARY KEY CHECK (seq >= 1),
  at            timestamptz NOT NULL,
  actor         text NOT NULL,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('person','agent','key','system')),
  action        text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    text NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
  prev_hash     char(64) NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash          char(64) NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX audit_log_subject ON audit_log (subject_type, subject_id);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Webhooks out (Standard Webhooks) and their outbox: deliveries are queued in the same transaction as the change, then
-- sent by the dispatcher with a lease, retried, and kept ------------------------------------------------------------

CREATE TABLE webhooks (
  id           text PRIMARY KEY,
  url          text NOT NULL,
  secret       text NOT NULL,
  events       text[] NOT NULL CHECK (cardinality(events) > 0),
  description  text NOT NULL DEFAULT '',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  disabled_at  timestamptz
);

CREATE TABLE outbox (
  id               text PRIMARY KEY,
  webhook_id       text NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  event_id         text NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz
);
CREATE INDEX outbox_due ON outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX outbox_webhook ON outbox (webhook_id, created_at DESC);
