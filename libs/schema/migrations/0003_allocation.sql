-- 0003_allocation: spec 003. Rule sets are versioned and effective-dated (a version is a proposal until a person who
-- did not propose it approves it); each month's allocations are kept by generation, and a rebuild is a new generation,
-- never an edit. Closing and locked months refuse new generations.

CREATE TABLE allocation_rule_sets (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One version is the whole ordered list (rules: first match wins) and the share rules for the shared pool.
CREATE TABLE allocation_rule_set_versions (
  id              text PRIMARY KEY,
  rule_set_id     text NOT NULL REFERENCES allocation_rule_sets (id),
  version         integer NOT NULL CHECK (version >= 1),
  effective_from  date NOT NULL,
  effective_to    date,
  rules           jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array'),
  shares          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(shares) = 'array'),
  note            text NOT NULL DEFAULT '',
  origin          text NOT NULL DEFAULT 'entered' CHECK (origin IN ('entered','dev-seed')),
  proposed_by     text NOT NULL,
  proposed_at     timestamptz NOT NULL DEFAULT now(),
  approved_by     text REFERENCES users (id),
  approved_at     timestamptz,
  UNIQUE (rule_set_id, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (approved_by IS NULL OR approved_by <> proposed_by),
  EXCLUDE USING gist (rule_set_id WITH =, daterange(effective_from, effective_to) WITH &&) WHERE (approved_at IS NOT NULL)
);

CREATE FUNCTION allocation_rule_set_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rule set versions are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.approved_at IS NULL THEN
    IF NEW.approved_at IS NULL OR (to_jsonb(NEW) - 'approved_by' - 'approved_at')
                                   IS DISTINCT FROM (to_jsonb(OLD) - 'approved_by' - 'approved_at') THEN
      RAISE EXCEPTION 'a proposed rule set version only gets approved; a change is a new proposal'
        USING ERRCODE = 'restrict_violation';
    END IF;
    -- Its effective date can't fall in a closing or locked month: those months keep the rules they had.
    IF EXISTS (SELECT 1 FROM periods WHERE status <> 'open'
                 AND month = date_trunc('month', NEW.effective_from)::date) THEN
      RAISE EXCEPTION 'rule set version % takes effect in a closed month', NEW.id USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF OLD.effective_to IS NOT NULL
     OR (to_jsonb(NEW) - 'effective_to') IS DISTINCT FROM (to_jsonb(OLD) - 'effective_to') THEN
    RAISE EXCEPTION 'an approved rule set version only gets an end date; anything else is a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_rule_set_versions_guard BEFORE UPDATE OR DELETE ON allocation_rule_set_versions
  FOR EACH ROW EXECUTE FUNCTION allocation_rule_set_versions_guard();

-- A month's allocations, by generation. The current generation of a month is its highest number.
CREATE TABLE allocation_generations (
  id                    text PRIMARY KEY,
  month                 date NOT NULL CHECK (landledger_first_of_month(month)),
  number                integer NOT NULL CHECK (number >= 1),
  reason                text NOT NULL,
  rule_set_version_ids  text[] NOT NULL DEFAULT '{}',
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (month, number)
);

CREATE FUNCTION allocation_generations_open_month() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM periods WHERE month = NEW.month AND status <> 'open') THEN
    RAISE EXCEPTION 'period % is closing or locked: its allocations are final', to_char(NEW.month, 'YYYY-MM')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_generations_open_month BEFORE INSERT ON allocation_generations
  FOR EACH ROW EXECUTE FUNCTION allocation_generations_open_month();
CREATE TRIGGER allocation_generations_append_only BEFORE UPDATE OR DELETE ON allocation_generations
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER allocation_generations_no_truncate BEFORE TRUNCATE ON allocation_generations
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- The direct layer: every record exactly once, to its target, the shared pool (SHARED-POOL) or UNALLOCATED, naming the
-- rule and the rule set version that put it there. The spread layer is computed from these and the share rules
-- (libs/allocation), with coefficients over the whole day, so it never needs storing.
CREATE TABLE allocations (
  month                 date NOT NULL,
  generation_id         text NOT NULL REFERENCES allocation_generations (id),
  record_id             text NOT NULL,
  billing_period_start  timestamptz NOT NULL,
  charge_day            date NOT NULL,
  basis                 text NOT NULL CHECK (basis IN ('estimated','invoiced')),
  cost_center           text NOT NULL,
  team                  text,
  product               text,
  pl_class              text CHECK (pl_class IN ('cost_of_revenue','rnd','sm','ga')),
  capitalisable         boolean NOT NULL DEFAULT false,
  rule_id               text,
  rule_set_version_id   text REFERENCES allocation_rule_set_versions (id),
  amount_micros         bigint NOT NULL,
  currency              char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  PRIMARY KEY (month, generation_id, record_id),
  CHECK (month = (billing_period_start AT TIME ZONE 'UTC')::date)
) PARTITION BY RANGE (month);
CREATE INDEX allocations_generation ON allocations (generation_id);
CREATE TRIGGER allocations_append_only BEFORE UPDATE OR DELETE ON allocations
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();

CREATE FUNCTION ensure_allocations_partition(month date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  first date := date_trunc('month', month)::date;
  part text := 'allocations_' || to_char(first, 'YYYY_MM');
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF allocations FOR VALUES FROM (%L) TO (%L)',
      part, first, (first + interval '1 month')::date);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only()',
      part || '_no_truncate', part);
  END IF;
  RETURN part;
END $$;

SELECT ensure_allocations_partition(make_date(y, m, 1))
FROM generate_series(2025, 2027) AS y, generate_series(1, 12) AS m;
