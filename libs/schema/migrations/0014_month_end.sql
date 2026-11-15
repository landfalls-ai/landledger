-- 0014_month_end: wave 4, "Month-end" (specs 012–019). The close checklist's explanations, the four-eyes lock and its
-- anchored audit entry, reopening a locked month by request; accrual proposals and their acceptance; the frozen close
-- snapshot; the stored daily forecast; variance notes (versions and decisions); the Datarails connector's budget pulls
-- and uploads; the `notes:draft` scope. Every table is append only: a state moves forward by a new row, never an edit.
-- Shipped migrations are never edited: a change is a new file.

-- The notes:draft scope (spec 015) ---------------------------------------------------------------------------------
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_known;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_known
  CHECK (scopes <@ ARRAY['read','requests:write','reservations:write','decisions:relay','webhooks:write','ingest',
                         'admin','notes:draft']::text[]);

-- 012 The close -----------------------------------------------------------------------------------------------------

-- A red step a person explained (never step 4, no_dev_rows, or step 10, locked). Step 2 explains one row.
CREATE TABLE close_explanations (
  id           text PRIMARY KEY,
  month        date NOT NULL CHECK (landledger_first_of_month(month)),
  round        integer NOT NULL DEFAULT 0 CHECK (round >= 0),
  step         text NOT NULL CHECK (step IN ('usage_ingested','reconciled','unallocated','no_open_anomalies',
                                             'no_outstanding_revokes','accrual_accepted','notes_accepted',
                                             'datarails_uploaded')),
  row_key      text,
  note         text NOT NULL CHECK (length(note) >= 3),
  explained_by text NOT NULL REFERENCES users (id),
  explained_at timestamptz NOT NULL DEFAULT now(),
  CHECK (row_key IS NULL OR step = 'reconciled')
);
CREATE INDEX close_explanations_month ON close_explanations (month, round);

-- A signature on a month's lock: two people, a controller and the CFO, per round.
CREATE TABLE close_signoffs (
  month      date NOT NULL CHECK (landledger_first_of_month(month)),
  round      integer NOT NULL DEFAULT 0 CHECK (round >= 0),
  person_id  text NOT NULL REFERENCES users (id),
  role       text NOT NULL CHECK (role IN ('controller','cfo')),
  note       text NOT NULL DEFAULT '',
  signed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, round, person_id),
  UNIQUE (month, round, role)
);

-- Each round's lock: both signatures, the gates as they stood, the snapshot, the audit entry and its anchor.
CREATE TABLE close_locks (
  month         date NOT NULL CHECK (landledger_first_of_month(month)),
  round         integer NOT NULL CHECK (round >= 0),
  locked_at     timestamptz NOT NULL DEFAULT now(),
  signoffs      jsonb NOT NULL,
  gates         jsonb NOT NULL,
  snapshot_id   text,
  audit_seq     bigint NOT NULL,
  audit_hash    char(64) NOT NULL,
  PRIMARY KEY (month, round)
);

-- A locked month reopened by an approved period_reopen request (the CFO's). The ledger stays closed to inserts.
CREATE TABLE period_reopens (
  month        date NOT NULL CHECK (landledger_first_of_month(month)),
  round        integer NOT NULL CHECK (round >= 1),
  request_id   text NOT NULL UNIQUE REFERENCES requests (id),
  reason       text NOT NULL,
  requested_by text NOT NULL REFERENCES users (id),
  approved_by  text NOT NULL REFERENCES users (id),
  reopened_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, round),
  CHECK (requested_by <> approved_by)
);

ALTER TABLE requests DROP CONSTRAINT requests_kind_check;
ALTER TABLE requests ADD CONSTRAINT requests_kind_check CHECK (kind IN ('infra_change','ai_budget','tool_or_seat',
  'rate_card_change','rule_set_change','policy_change','other','contract','period_reopen'));
ALTER TABLE policies DROP CONSTRAINT policies_kind_check;
ALTER TABLE policies ADD CONSTRAINT policies_kind_check CHECK (kind IN ('infra_change','ai_budget','tool_or_seat',
  'rate_card_change','rule_set_change','policy_change','other','contract','period_reopen'));

-- A period_reopen request carries its change ({ type: 'period_reopen', month }) as the self-applied kinds do. The
-- constraint was created unnamed (0010); it is found by its definition.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO STRICT c FROM pg_constraint
  WHERE conrelid = 'requests'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%(change IS NULL) = (kind <> ALL%';
  EXECUTE format('ALTER TABLE requests DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE requests ADD CONSTRAINT requests_change_kind CHECK ((change IS NULL) = (kind NOT IN
  ('rate_card_change','rule_set_change','policy_change','period_reopen')));

-- Reopening a locked month: never automatic, the CFO alone (and never the controller who asked).
INSERT INTO policies (id, kind, version, definition, note, origin, status, proposed_by, approved_at)
VALUES ('pol_period_reopen_1', 'period_reopen', 1, jsonb_build_object('automaticBelow', NULL, 'steps', jsonb_build_array(
  '{"key":"cfo","label":"CFO","approvers":{"groups":["Finance CFO"],"costCenterOwner":false},"when":{"always":true}}'::jsonb)),
  'Reopening a locked month needs the CFO (wave 4, spec 012). Corrections still post to the open month.',
  'decision', 'approved', 'seed', '2026-11-15T00:00:00Z');

-- 016 The frozen close snapshot ---------------------------------------------------------------------------------------
CREATE TABLE close_snapshots (
  id            text PRIMARY KEY,
  month         date NOT NULL CHECK (landledger_first_of_month(month)),
  version       integer NOT NULL CHECK (version >= 1),
  figures       jsonb NOT NULL,
  sha256        char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- The ledger part alone (totals, cost centers with budgets, P&L classes, providers, reconciliation): what "the
  -- figures still are the snapshot's" compares.
  ledger_sha256 char(64) NOT NULL CHECK (ledger_sha256 ~ '^[0-9a-f]{64}$'),
  accrual_id    text,
  frozen_by     text NOT NULL REFERENCES users (id),
  frozen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (month, version)
);

-- 013 Accruals ----------------------------------------------------------------------------------------------------------
CREATE TABLE accruals (
  id          text PRIMARY KEY,
  month       date NOT NULL CHECK (landledger_first_of_month(month)),
  version     integer NOT NULL CHECK (version >= 1),
  sha256      char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  total_micros bigint NOT NULL,
  note        text NOT NULL DEFAULT '',
  proposed_by text NOT NULL REFERENCES users (id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (month, version)
);
CREATE TABLE accrual_lines (
  accrual_id    text NOT NULL REFERENCES accruals (id),
  line          integer NOT NULL CHECK (line >= 1),
  kind          text NOT NULL CHECK (kind IN ('usage','contract')),
  provider      text NOT NULL,
  item          text NOT NULL,
  provider_key  text NOT NULL,
  cost_center   text NOT NULL,
  pl_class      text NOT NULL,
  amount_micros bigint NOT NULL,
  currency      char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  estimate_keys text[] NOT NULL DEFAULT '{}',
  contract_id   text,
  PRIMARY KEY (accrual_id, line),
  CHECK ((kind = 'contract') = (contract_id IS NOT NULL))
);
-- Accepted (by a controller, freezing the snapshot) or superseded (by a newer proposal): once each.
CREATE TABLE accrual_decisions (
  accrual_id  text PRIMARY KEY REFERENCES accruals (id),
  outcome     text NOT NULL CHECK (outcome IN ('accepted','superseded')),
  decided_by  text NOT NULL REFERENCES users (id),
  decided_at  timestamptz NOT NULL DEFAULT now(),
  note        text NOT NULL DEFAULT '',
  snapshot_id text REFERENCES close_snapshots (id),
  CHECK ((outcome = 'accepted') = (snapshot_id IS NOT NULL))
);

-- 014 Forecast history ------------------------------------------------------------------------------------------------
CREATE TABLE forecast_history (
  day          date NOT NULL,
  month        date NOT NULL CHECK (landledger_first_of_month(month)),
  cost_center  text NOT NULL,
  p10_micros   bigint,
  p50_micros   bigint,
  p90_micros   bigint,
  actual_micros bigint NOT NULL,
  status       text NOT NULL CHECK (status IN ('ok','insufficient')),
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, cost_center),
  CHECK (status = 'insufficient' OR (p10_micros IS NOT NULL AND p50_micros IS NOT NULL AND p90_micros IS NOT NULL)),
  CHECK (p10_micros IS NULL OR (p10_micros <= p50_micros AND p50_micros <= p90_micros))
);

-- 015 Variance notes ----------------------------------------------------------------------------------------------------
CREATE TABLE variance_notes (
  id          text PRIMARY KEY,
  month       date NOT NULL CHECK (landledger_first_of_month(month)),
  cost_center text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (month, cost_center)
);
CREATE TABLE variance_note_versions (
  note_id         text NOT NULL REFERENCES variance_notes (id),
  version         integer NOT NULL CHECK (version >= 1),
  snapshot_id     text NOT NULL REFERENCES close_snapshots (id),
  kind            text NOT NULL CHECK (kind IN ('draft','template','edit')),
  body            text NOT NULL,
  cites           jsonb NOT NULL DEFAULT '[]',
  written_by      text NOT NULL,
  written_by_kind text NOT NULL CHECK (written_by_kind IN ('person','key','system')),
  written_by_name text NOT NULL,
  agent           jsonb,
  sponsor_id      text REFERENCES users (id),
  requested_by    text REFERENCES users (id),
  run_id          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, version)
);
CREATE TABLE variance_note_decisions (
  note_id     text NOT NULL,
  version     integer NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('accepted','rejected')),
  decided_by  text NOT NULL REFERENCES users (id),
  comment     text NOT NULL DEFAULT '',
  decided_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, version),
  FOREIGN KEY (note_id, version) REFERENCES variance_note_versions (note_id, version)
);
-- notes.draft_requested, once per snapshot.
CREATE TABLE notes_requests (
  snapshot_id text PRIMARY KEY REFERENCES close_snapshots (id),
  month       date NOT NULL CHECK (landledger_first_of_month(month)),
  sent_at     timestamptz NOT NULL DEFAULT now()
);

-- 017 Datarails ---------------------------------------------------------------------------------------------------------
CREATE TABLE datarails_pulls (
  id          text PRIMARY KEY,
  data_model  text NOT NULL,
  rows        jsonb NOT NULL,
  row_count   integer NOT NULL CHECK (row_count >= 1),
  sha256      char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  source_url  text NOT NULL,
  note        text NOT NULL DEFAULT '',
  pulled_by   text NOT NULL REFERENCES users (id),
  pulled_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE datarails_pull_decisions (
  pull_id          text PRIMARY KEY REFERENCES datarails_pulls (id),
  outcome          text NOT NULL CHECK (outcome IN ('accepted','rejected')),
  decided_by       text NOT NULL REFERENCES users (id),
  decided_at       timestamptz NOT NULL DEFAULT now(),
  reason           text NOT NULL DEFAULT '',
  budget_import_id text REFERENCES budget_imports (id),
  CHECK ((outcome = 'accepted') = (budget_import_id IS NOT NULL))
);
CREATE TABLE datarails_uploads (
  id            text PRIMARY KEY,
  month         date NOT NULL CHECK (landledger_first_of_month(month)),
  snapshot_id   text NOT NULL REFERENCES close_snapshots (id),
  snapshot_sha  char(64) NOT NULL,
  files         jsonb NOT NULL,
  ok            boolean NOT NULL,
  status        integer NOT NULL,
  response      jsonb NOT NULL,
  target_url    text NOT NULL,
  uploaded_by   text NOT NULL REFERENCES users (id),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

-- Append only, every one --------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['close_explanations','close_signoffs','close_locks','period_reopens','close_snapshots',
    'accruals','accrual_lines','accrual_decisions','forecast_history','variance_notes','variance_note_versions',
    'variance_note_decisions','notes_requests','datarails_pulls','datarails_pull_decisions','datarails_uploads']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION landledger_append_only()',
                   t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only()',
                   t || '_no_truncate', t);
  END LOOP;
END $$;

-- The app ---------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON close_explanations, close_signoffs, close_locks, period_reopens, close_snapshots, accruals,
  accrual_lines, accrual_decisions, forecast_history, variance_notes, variance_note_versions, variance_note_decisions,
  notes_requests, datarails_pulls, datarails_pull_decisions, datarails_uploads TO landledger_app;
