-- 0008_app_role: the API connects as `landledger_app`, not as the owner (review of wave 1, finding 5). The owner runs
-- migrations; the app gets what it uses and no more: INSERT and SELECT on the ledger, audit, allocation and version
-- tables (no UPDATE, DELETE or TRUNCATE, and it can't disable a trigger, which only the owner can), UPDATE on the
-- columns a workflow moves forward, DELETE only where rows are working state (sessions, sign-ins in flight,
-- provisional usage). The role is created without a password here; `pnpm db:migrate` gives it LOGIN and the password
-- in LANDLEDGER_APP_PG_PASSWORD (development: landledger-app-dev). A new table grants the app in its own migration
-- (a test checks that every table does). Shipped migrations are never edited: a change is a new file.

DO $$
BEGIN
  CREATE ROLE landledger_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL; -- roles are per server: another database on it made it already
END $$;

GRANT USAGE ON SCHEMA public TO landledger_app;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO landledger_app', current_database()); END $$;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO landledger_app;

-- Append only: read and add.
GRANT SELECT, INSERT ON
  cost_records, provisional_usage, audit_log, audit_anchors, allocations, allocation_generations,
  allocation_rule_sets, rate_cards, rate_lines, fx_rates, budget_imports, budgets, version_notes,
  invoice_estimate_links, cost_center_codes, cost_centers, teams, products
TO landledger_app;
GRANT SELECT ON cost_record_keys, _migrations TO landledger_app;

-- Versions: proposed (insert), then approved and end-dated (those columns only).
GRANT SELECT, INSERT ON rate_card_versions, allocation_rule_set_versions TO landledger_app;
GRANT UPDATE (approved_by, approved_at, effective_to) ON rate_card_versions TO landledger_app;
GRANT UPDATE (approved_by, approved_at, effective_to) ON allocation_rule_set_versions TO landledger_app;

-- Months: created open, moved forward.
GRANT SELECT, INSERT ON periods TO landledger_app;
GRANT UPDATE (status, closing_by, closing_at, locked_by, locked_at) ON periods TO landledger_app;

-- Ingest runs: started, then finished once.
GRANT SELECT, INSERT ON ingest_runs TO landledger_app;
GRANT UPDATE (finished_at, outcome, read_count, new_count, corrected_count, unchanged_count, warnings, error,
              observed_from, observed_to) ON ingest_runs TO landledger_app;

-- People and access.
GRANT SELECT, INSERT ON users, groups, api_keys, webhooks TO landledger_app;
GRANT UPDATE (email, name, roles, groups, last_seen_at) ON users TO landledger_app;
GRANT UPDATE (role, last_seen_at) ON groups TO landledger_app;
GRANT UPDATE (revoked_at, last_used_at) ON api_keys TO landledger_app;
GRANT UPDATE (disabled_at, secret) ON webhooks TO landledger_app;
GRANT SELECT, INSERT, UPDATE ON outbox TO landledger_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO landledger_app;
GRANT SELECT, INSERT, DELETE ON auth_requests TO landledger_app;
GRANT DELETE ON provisional_usage TO landledger_app;

-- Entering a record touches what the app may not change itself: it locks and adds to cost_record_keys and opens a
-- month. The trigger runs as the owner, with a fixed search path, so the app needs no UPDATE there.
ALTER FUNCTION cost_records_enter() SECURITY DEFINER SET search_path = public, pg_temp;
