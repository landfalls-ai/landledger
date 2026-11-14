-- 0001_core: the tables wave 1 stands on (docs/architecture.md, "The data").
-- Money is bigint minor units + char(3) ISO 4217 currency; rates and quantities are numeric (exact); never floats.
-- Requests, policies, decisions, reservations, contracts and invoices come in later waves (new migrations).
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

-- Rate cards ---------------------------------------------------------------------------------------------------------

CREATE TABLE rate_cards (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  owner       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A version is effective-dated; versions of one card never overlap. Once written, only its end date may be set (when
-- the next version takes over); its rates never change.
CREATE TABLE rate_card_versions (
  id              text PRIMARY KEY,
  rate_card_id    text NOT NULL REFERENCES rate_cards (id),
  version         integer NOT NULL CHECK (version >= 1),
  effective_from  date NOT NULL,
  effective_to    date,
  note            text NOT NULL DEFAULT '',
  approved_by     text,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rate_card_id, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  EXCLUDE USING gist (rate_card_id WITH =, daterange(effective_from, effective_to) WITH &&)
);

CREATE FUNCTION rate_card_versions_close_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rate card versions are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.effective_to IS NOT NULL
     OR (to_jsonb(NEW) - 'effective_to') IS DISTINCT FROM (to_jsonb(OLD) - 'effective_to') THEN
    RAISE EXCEPTION 'a rate card version only gets an end date; anything else is a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rate_card_versions_close_only BEFORE UPDATE OR DELETE ON rate_card_versions
  FOR EACH ROW EXECUTE FUNCTION rate_card_versions_close_only();

CREATE TABLE rate_card_rates (
  version_id  text NOT NULL REFERENCES rate_card_versions (id),
  key         text NOT NULL,
  label       text NOT NULL,
  unit        text NOT NULL,
  price       numeric NOT NULL CHECK (price >= 0),
  currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  position    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (version_id, key)
);
CREATE TRIGGER rate_card_rates_append_only BEFORE UPDATE OR DELETE ON rate_card_rates
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER rate_card_rates_no_truncate BEFORE TRUNCATE ON rate_card_rates
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Allocation rules: ordered selectors → cost center, team, product, P&L class, capitalisable; effective-dated --------

CREATE TABLE allocation_rules (
  id                text PRIMARY KEY,
  rule_key          text NOT NULL,
  version           integer NOT NULL CHECK (version >= 1),
  position          integer NOT NULL,
  selector          jsonb NOT NULL CHECK (jsonb_typeof(selector) = 'object'),
  cost_center_code  text,
  team_code         text,
  product_code      text,
  pl_class          text NOT NULL CHECK (pl_class IN ('cost_of_revenue','rnd','sm','ga')),
  capitalisable     boolean NOT NULL DEFAULT false,
  shared_split      jsonb,
  effective_from    date NOT NULL,
  effective_to      date,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_key, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- FX rates: per pair and day, with their source; append only ----------------------------------------------------------

CREATE TABLE fx_rates (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  base        char(3) NOT NULL CHECK (base ~ '^[A-Z]{3}$'),
  quote       char(3) NOT NULL CHECK (quote ~ '^[A-Z]{3}$'),
  rate_date   date NOT NULL,
  rate        numeric NOT NULL CHECK (rate > 0),
  source      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (base, quote, rate_date, source),
  CHECK (base <> quote)
);
CREATE TRIGGER fx_rates_append_only BEFORE UPDATE OR DELETE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER fx_rates_no_truncate BEFORE TRUNCATE ON fx_rates
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Periods: each month open, closing, locked. Status only moves forward; locked is final ---------------------------

CREATE TABLE periods (
  month      date PRIMARY KEY CHECK (landledger_first_of_month(month)),
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closing','locked')),
  locked_by  text,
  locked_at  timestamptz,
  CHECK (status <> 'locked' OR (locked_by IS NOT NULL AND locked_at IS NOT NULL))
);

CREATE FUNCTION periods_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rank_of jsonb := '{"open": 0, "closing": 1, "locked": 2}';
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'periods are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'locked' THEN
    RAISE EXCEPTION 'period % is locked: it never changes; corrections post to the open period', OLD.month
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (rank_of ->> NEW.status)::int < (rank_of ->> OLD.status)::int OR NEW.month <> OLD.month THEN
    RAISE EXCEPTION 'a period only moves forward (open → closing → locked)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER periods_forward_only BEFORE UPDATE OR DELETE ON periods
  FOR EACH ROW EXECUTE FUNCTION periods_forward_only();

-- Budgets: amount per cost center and month; a change is a new version ------------------------------------------------

CREATE TABLE budgets (
  id                text PRIMARY KEY,
  cost_center_code  text NOT NULL,
  month             date NOT NULL CHECK (landledger_first_of_month(month)),
  amount_minor      bigint NOT NULL,
  currency          char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  version           integer NOT NULL CHECK (version >= 1),
  source            text NOT NULL CHECK (source IN ('datarails','csv','entered')),
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cost_center_code, month, version)
);
CREATE TRIGGER budgets_append_only BEFORE UPDATE OR DELETE ON budgets
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();

-- Cost records: one row per resource, charge and day, FOCUS columns + x_ extensions; append only, monthly partitions -

CREATE TABLE cost_records (
  id                    text NOT NULL,
  charge_period_start   timestamptz NOT NULL,
  charge_period_end     timestamptz NOT NULL,
  charge_category       text NOT NULL CHECK (charge_category IN ('Usage','Purchase','Tax','Credit','Adjustment')),
  charge_class          text CHECK (charge_class = 'Correction'),
  charge_description    text NOT NULL DEFAULT '',
  service_name          text NOT NULL,
  provider_name         text NOT NULL,
  resource_id           text,
  consumed_quantity     numeric,
  consumed_unit         text,
  list_unit_price       numeric CHECK (list_unit_price >= 0),
  billed_cost_minor     bigint NOT NULL,
  effective_cost_minor  bigint NOT NULL,
  billing_currency      char(3) NOT NULL CHECK (billing_currency ~ '^[A-Z]{3}$'),
  tags                  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(tags) = 'object'),
  x_basis               text NOT NULL CHECK (x_basis IN ('estimated','invoiced')),
  x_source              text NOT NULL,
  x_rate_card_version   text REFERENCES rate_card_versions (id),
  x_ingest_run          text,
  x_corrects            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, charge_period_start),
  CHECK (charge_period_end > charge_period_start),
  CHECK ((charge_class IS NOT NULL) = (x_corrects IS NOT NULL)),
  CHECK ((consumed_quantity IS NULL) = (consumed_unit IS NULL))
) PARTITION BY RANGE (charge_period_start);

CREATE INDEX cost_records_ingest_run ON cost_records (x_ingest_run);
CREATE INDEX cost_records_tags ON cost_records USING gin (tags);

CREATE TRIGGER cost_records_append_only BEFORE UPDATE OR DELETE ON cost_records
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER cost_records_no_truncate BEFORE TRUNCATE ON cost_records
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- The month's partition, created when first needed (UTC month bounds). Returns its name.
CREATE FUNCTION ensure_cost_records_partition(day date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  first date := day - (extract(day FROM day)::int - 1);
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

-- 2026 and 2027 exist from the start; ingest calls ensure_cost_records_partition for anything else.
SELECT ensure_cost_records_partition(make_date(y, m, 1))
FROM generate_series(2026, 2027) AS y, generate_series(1, 12) AS m;

-- Allocations: each record's split; rebuilt for open periods only -------------------------------------------------

CREATE TABLE allocations (
  id                   text PRIMARY KEY,
  cost_record_id       text NOT NULL,
  charge_period_start  timestamptz NOT NULL,
  period_month         date NOT NULL CHECK (landledger_first_of_month(period_month)),
  cost_center_code     text,
  team_code            text,
  product_code         text,
  pl_class             text NOT NULL CHECK (pl_class IN ('cost_of_revenue','rnd','sm','ga')),
  capitalisable        boolean NOT NULL DEFAULT false,
  shared               boolean NOT NULL DEFAULT false,
  weight               numeric NOT NULL CHECK (weight >= 0),
  amount_minor         bigint NOT NULL,
  currency             char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rule_id              text REFERENCES allocation_rules (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (cost_record_id, charge_period_start) REFERENCES cost_records (id, charge_period_start)
);
CREATE INDEX allocations_record ON allocations (cost_record_id, charge_period_start);
CREATE INDEX allocations_period ON allocations (period_month, cost_center_code);

CREATE FUNCTION allocations_open_period_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m date := CASE WHEN TG_OP = 'DELETE' THEN OLD.period_month ELSE NEW.period_month END;
BEGIN
  IF EXISTS (SELECT 1 FROM periods WHERE month = m AND status = 'locked')
     OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM periods WHERE month = OLD.period_month AND status = 'locked')) THEN
    RAISE EXCEPTION 'period % is locked: its allocations never change', m USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER allocations_open_period_only BEFORE INSERT OR UPDATE OR DELETE ON allocations
  FOR EACH ROW EXECUTE FUNCTION allocations_open_period_only();

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
