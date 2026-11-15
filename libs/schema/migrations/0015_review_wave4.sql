-- 0015_review_wave4: the review of wave 4 ("Month-end"). The minter of a notes key; what each signature is on and
-- when its signer was shown it; explanations bound to the problems they explained; a snapshot frozen at the lock;
-- the stored, hashed package per lock round; contracts' billing terms and prepaid amortisation; the frozen journal and
-- the chart-of-accounts mapping, changed by a request. Every new table is append only.
-- Shipped migrations are never edited: a change is a new file.

-- B3: the person who minted a draft's key, always barred from deciding it (a declared sponsor is barred as well).
ALTER TABLE variance_note_versions ADD COLUMN minter_id text REFERENCES users (id);

-- Should-fix 1: a signature is on one snapshot (its sha256), and the signer was shown that snapshot (seen_at). Only
-- signatures on the current snapshot count, so a signer can sign again in the same round once the snapshot changed.
ALTER TABLE close_signoffs ADD COLUMN snapshot_sha256 char(64)
  CHECK (snapshot_sha256 IS NULL OR snapshot_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE close_signoffs ADD COLUMN seen_at timestamptz;
ALTER TABLE close_signoffs DROP CONSTRAINT close_signoffs_pkey;
ALTER TABLE close_signoffs DROP CONSTRAINT close_signoffs_month_round_role_key;
ALTER TABLE close_signoffs ADD CONSTRAINT close_signoffs_person_once
  UNIQUE NULLS NOT DISTINCT (month, round, person_id, snapshot_sha256);
ALTER TABLE close_signoffs ADD CONSTRAINT close_signoffs_role_once
  UNIQUE NULLS NOT DISTINCT (month, round, role, snapshot_sha256);

-- Each time a person was served a month's snapshot (the close view, the snapshot, the package): the evidence that a
-- signer saw the snapshot they signed.
CREATE TABLE close_snapshot_views (
  id          text PRIMARY KEY,
  month       date NOT NULL CHECK (landledger_first_of_month(month)),
  snapshot_id text NOT NULL REFERENCES close_snapshots (id),
  person_id   text NOT NULL REFERENCES users (id),
  served_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX close_snapshot_views_person ON close_snapshot_views (person_id, snapshot_id, served_at DESC);

-- Segregation of duties: a reopened round is started like the first (by a controller, the CFO or FP&A), and its
-- starter is one of the people the duties rule counts (start, accrual acceptance, the controller's signature: at least
-- two different people, besides the CFO).
CREATE TABLE close_round_starts (
  month      date NOT NULL CHECK (landledger_first_of_month(month)),
  round      integer NOT NULL CHECK (round >= 1),
  started_by text NOT NULL REFERENCES users (id),
  note       text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, round)
);

-- Should-fix 3: what an explanation explained (the step's problems then, and their sha256). A changed list turns the
-- step red again.
ALTER TABLE close_explanations ADD COLUMN problems jsonb;
ALTER TABLE close_explanations ADD COLUMN problems_sha256 char(64)
  CHECK (problems_sha256 IS NULL OR problems_sha256 ~ '^[0-9a-f]{64}$');

-- Should-fix 2: a snapshot is frozen at the lock when no accrual froze one (steps 7–9 explained).
ALTER TABLE close_snapshots ADD COLUMN reason text NOT NULL DEFAULT 'accrual' CHECK (reason IN ('accrual','lock'));

-- Should-fix 5: each lock round's package, stored: every file's body and sha256, and the manifest's sha256 (in
-- close_locks and the period.locked audit entry).
CREATE TABLE close_packages (
  month       date NOT NULL CHECK (landledger_first_of_month(month)),
  round       integer NOT NULL CHECK (round >= 0),
  files       jsonb NOT NULL,
  manifest    text NOT NULL,
  sha256      char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  built_by    text NOT NULL REFERENCES users (id),
  built_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, round)
);
ALTER TABLE close_locks ADD COLUMN package_sha256 char(64)
  CHECK (package_sha256 IS NULL OR package_sha256 ~ '^[0-9a-f]{64}$');

-- Should-fix 12: a contract's billing terms (a default to confirm). Only monthly in arrears accrues; a prepaid annual
-- contract amortises as a prepaid expense line; monthly in advance is invoiced before the month and accrues nothing.
ALTER TABLE contract_versions ADD COLUMN billing text NOT NULL DEFAULT 'monthly_in_arrears'
  CHECK (billing IN ('prepaid_annual','monthly_in_arrears','monthly_in_advance'));

-- An accrual proposal's prepaid amortisation lines, reported apart from the accrued liability.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'accrual_lines'::regclass AND contype = 'c'
             AND (pg_get_constraintdef(oid) LIKE '%kind = ANY%' OR pg_get_constraintdef(oid) LIKE '%contract_id IS NOT NULL%')
  LOOP
    EXECUTE format('ALTER TABLE accrual_lines DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE accrual_lines ADD CONSTRAINT accrual_lines_kind CHECK (kind IN ('usage','contract','prepaid'));
ALTER TABLE accrual_lines ADD CONSTRAINT accrual_lines_contract
  CHECK ((kind IN ('contract','prepaid')) = (contract_id IS NOT NULL));

-- The chart-of-accounts mapping: Landledger's placeholder accounts to the general ledger's. A version is proposed by a
-- controller and decided as a `coa_mapping_change` request (never by its proposer). Version 1 is the default.
CREATE TABLE coa_mapping_versions (
  id          text PRIMARY KEY,
  version     integer NOT NULL UNIQUE CHECK (version >= 1),
  mapping     jsonb NOT NULL,
  sha256      char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  note        text NOT NULL DEFAULT '',
  proposed_by text NOT NULL REFERENCES users (id),
  proposed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE coa_mapping_decisions (
  version_id  text PRIMARY KEY REFERENCES coa_mapping_versions (id),
  outcome     text NOT NULL CHECK (outcome IN ('approved','rejected')),
  decided_by  text NOT NULL REFERENCES users (id),
  request_id  text REFERENCES requests (id),
  decided_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO coa_mapping_versions (id, version, mapping, sha256, note, proposed_by)
SELECT 'coa_1', 1, m, encode(sha256(convert_to(m::text, 'UTF8')), 'hex'),
       'The default mapping (review of wave 4): a placeholder for the controller to replace with the real chart.', 'seed'
FROM (SELECT jsonb_build_object(
  'LIAB-ACCRUED', jsonb_build_object('gl', '2150', 'name', 'Accrued liabilities: technology'),
  'ASSET-PREPAID', jsonb_build_object('gl', '1450', 'name', 'Prepaid expenses: technology'),
  'EXP-COST-OF-REVENUE', jsonb_build_object('gl', '5100', 'name', 'Cost of revenue: technology'),
  'EXP-RND', jsonb_build_object('gl', '6100', 'name', 'R&D: technology'),
  'EXP-SM', jsonb_build_object('gl', '6300', 'name', 'Sales and marketing: technology'),
  'EXP-GA', jsonb_build_object('gl', '6500', 'name', 'G&A: technology'),
  'EXP-SHARED', jsonb_build_object('gl', '6590', 'name', 'Shared technology (to allocate)'),
  'EXP-UNCLASSIFIED', jsonb_build_object('gl', '6599', 'name', 'Technology: not classified')) AS m) x;
INSERT INTO coa_mapping_decisions (version_id, outcome, decided_by) VALUES ('coa_1', 'approved', 'seed');

ALTER TABLE requests DROP CONSTRAINT requests_kind_check;
ALTER TABLE requests ADD CONSTRAINT requests_kind_check CHECK (kind IN ('infra_change','ai_budget','tool_or_seat',
  'rate_card_change','rule_set_change','policy_change','other','contract','period_reopen','coa_mapping_change'));
ALTER TABLE policies DROP CONSTRAINT policies_kind_check;
ALTER TABLE policies ADD CONSTRAINT policies_kind_check CHECK (kind IN ('infra_change','ai_budget','tool_or_seat',
  'rate_card_change','rule_set_change','policy_change','other','contract','period_reopen','coa_mapping_change'));
ALTER TABLE requests DROP CONSTRAINT requests_change_kind;
ALTER TABLE requests ADD CONSTRAINT requests_change_kind CHECK ((change IS NULL) = (kind NOT IN
  ('rate_card_change','rule_set_change','policy_change','period_reopen','coa_mapping_change')));

-- B4: a step only the CFO decides never escalates; with nobody eligible it waits, its note and deadline renewed at each
-- alert. A pending step may now be updated without escalating (its note and deadline), and still escalates only once.
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
  IF OLD.status = 'pending' AND NEW.status = 'pending' THEN
    IF NEW.escalated_at IS DISTINCT FROM OLD.escalated_at THEN
      IF OLD.escalated_at IS NOT NULL OR NEW.escalated_at IS NULL THEN
        RAISE EXCEPTION 'a pending step escalates once' USING ERRCODE = 'restrict_violation';
      END IF;
    ELSIF NEW.escalated_to IS DISTINCT FROM OLD.escalated_to OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      RAISE EXCEPTION 'a pending step escalates once' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.status IN ('approved','rejected') AND NOT EXISTS (
       SELECT 1 FROM decisions d WHERE d.request_id = NEW.request_id AND d.step = NEW.position
         AND d.outcome = CASE NEW.status WHEN 'approved' THEN 'approve' ELSE 'reject' END) THEN
    RAISE EXCEPTION 'step % of request % is decided by a person''s decision', NEW.position, NEW.request_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- A mapping change: a controller or the CFO decides, never the one who proposed it.
INSERT INTO policies (id, kind, version, definition, note, origin, status, proposed_by, approved_at)
VALUES ('pol_coa_mapping_1', 'coa_mapping_change', 1, jsonb_build_object('automaticBelow', NULL, 'steps', jsonb_build_array(
  '{"key":"finance","label":"Finance","approvers":{"groups":["Finance Controllers","Finance CFO"],"costCenterOwner":false},"when":{"always":true}}'::jsonb)),
  'A chart-of-accounts mapping change needs a controller or the CFO who did not propose it (review of wave 4).',
  'decision', 'approved', 'seed', '2026-11-15T00:00:00Z');

-- Should-fix 11: the journal, frozen when a controller accepts a month's accrual. Entry ids, the placeholder account
-- and the general ledger's (by the mapping version in force), at the minor unit. An accepted version that a later one
-- replaces is reversed by its own entry (`supersede`); reversals booked in the month are frozen with it.
CREATE TABLE journal_lines (
  entry_id      text NOT NULL,
  line          integer NOT NULL CHECK (line >= 1),
  month         date NOT NULL CHECK (landledger_first_of_month(month)),
  journal_date  date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('accrual','reversal','supersede','prepaid')),
  accrual_id    text REFERENCES accruals (id),
  accrual_line  integer,
  accrual_month date,
  account       text NOT NULL,
  account_name  text NOT NULL,
  gl_account    text NOT NULL,
  gl_name       text NOT NULL,
  coa_version   integer NOT NULL,
  debit_micros  bigint NOT NULL DEFAULT 0 CHECK (debit_micros >= 0),
  credit_micros bigint NOT NULL DEFAULT 0 CHECK (credit_micros >= 0),
  currency      char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  cost_center   text NOT NULL,
  pl_class      text NOT NULL,
  memo          text NOT NULL,
  frozen_by     text NOT NULL REFERENCES users (id),
  frozen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, line),
  CHECK ((debit_micros = 0) <> (credit_micros = 0))
);
CREATE INDEX journal_lines_month ON journal_lines (month);
CREATE INDEX journal_lines_accrual ON journal_lines (accrual_id, accrual_line);

-- Append only, every one -------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['close_snapshot_views','close_round_starts','close_packages','coa_mapping_versions',
    'coa_mapping_decisions','journal_lines']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION landledger_append_only()',
                   t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only()',
                   t || '_no_truncate', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON close_snapshot_views, close_round_starts, close_packages, coa_mapping_versions, coa_mapping_decisions,
  journal_lines TO landledger_app;
