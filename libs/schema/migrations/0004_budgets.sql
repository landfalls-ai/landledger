-- 0004_budgets: budgets per cost center and month, imported in versions (wave 1: from a CSV; Datarails in wave 4).
-- An import is a version; the budget for a cost center and month is the one in the newest version that names it.
-- Both tables are append-only: a change is a new import.

CREATE TABLE budget_imports (
  id           text PRIMARY KEY,
  version      integer NOT NULL UNIQUE CHECK (version >= 1),
  source       text NOT NULL CHECK (source IN ('csv','datarails','entered')),
  file_name    text,
  note         text NOT NULL DEFAULT '',
  origin       text NOT NULL DEFAULT 'entered' CHECK (origin IN ('entered','dev-seed')),
  row_count    integer NOT NULL CHECK (row_count >= 1),
  checksum     char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  imported_by  text NOT NULL,
  imported_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER budget_imports_append_only BEFORE UPDATE OR DELETE ON budget_imports
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER budget_imports_no_truncate BEFORE TRUNCATE ON budget_imports
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

CREATE TABLE budgets (
  import_id         text NOT NULL REFERENCES budget_imports (id),
  cost_center_code  text NOT NULL,
  month             date NOT NULL CHECK (landledger_first_of_month(month)),
  amount_micros     bigint NOT NULL CHECK (amount_micros >= 0),
  currency          char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  PRIMARY KEY (import_id, cost_center_code, month)
);
CREATE INDEX budgets_lookup ON budgets (cost_center_code, month);
CREATE TRIGGER budgets_append_only BEFORE UPDATE OR DELETE ON budgets
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER budgets_no_truncate BEFORE TRUNCATE ON budgets
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();
