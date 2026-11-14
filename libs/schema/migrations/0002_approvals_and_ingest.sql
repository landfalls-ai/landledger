-- 0002_approvals_and_ingest: four eyes on rate card versions, and what ingest needs beyond 0001 (spec 002).
-- Shipped migrations are never edited: a change is a new file.

-- A rate card version is approved by a person who did not propose it (docs/plan.md principle 1). approved_by already
-- references users (a person); this adds requester ≠ approver in the database, for every role.
CREATE FUNCTION rate_card_versions_four_eyes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NULL AND NEW.approved_by IS NOT NULL AND NEW.approved_by = NEW.proposed_by THEN
    RAISE EXCEPTION 'the person who proposed rate card version % cannot approve it', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rate_card_versions_four_eyes BEFORE UPDATE ON rate_card_versions
  FOR EACH ROW EXECUTE FUNCTION rate_card_versions_four_eyes();

-- What a run observed, written once when it finishes: the source's first and last sample in the window. The forecast's
-- run rate divides by observed hours, so a day whose data starts at 15:15 isn't read as 24 hours.
ALTER TABLE ingest_runs ADD COLUMN observed_from timestamptz, ADD COLUMN observed_to timestamptz;

-- A run is still finished once; the observed window is one of the things finishing sets.
CREATE OR REPLACE FUNCTION ingest_runs_finish_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ingest runs are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.outcome <> 'running'
     OR (to_jsonb(NEW) - 'finished_at' - 'outcome' - 'read_count' - 'new_count' - 'corrected_count' - 'unchanged_count'
         - 'warnings' - 'error' - 'observed_from' - 'observed_to')
        IS DISTINCT FROM
        (to_jsonb(OLD) - 'finished_at' - 'outcome' - 'read_count' - 'new_count' - 'corrected_count' - 'unchanged_count'
         - 'warnings' - 'error' - 'observed_from' - 'observed_to') THEN
    RAISE EXCEPTION 'an ingest run is finished once; its source, day and parameters never change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- Reading a day of records quickly: live entries per source and charge day.
CREATE INDEX cost_records_source_day ON cost_records (source, charge_period_start);
