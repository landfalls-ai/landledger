-- 0005_four_eyes: four eyes that hold (review of wave 1, finding 4). A proposer is a user (a person, or a named system
-- actor such as the seed), every rate line records who added it, and an approval is refused to a system actor, to the
-- proposer and to anyone who added a line. Versions approved before this keep their approval, with a note saying what
-- was and wasn't checked. Shipped migrations are never edited: a change is a new file.

-- Who: people and named system actors. A system actor proposes and adds; it never approves.
ALTER TABLE users ADD COLUMN kind text NOT NULL DEFAULT 'person' CHECK (kind IN ('person','system'));
INSERT INTO users (id, issuer, subject, email, name, kind)
VALUES ('seed', 'landledger', 'seed', NULL, 'System seed (pnpm db:seed)', 'system'),
       ('cli', 'landledger', 'cli', NULL, 'Command line, before wave 1''s review (no person recorded)', 'system')
ON CONFLICT (id) DO NOTHING;

-- Proposers are users. The seed's proposals already say 'seed', the system user above.
ALTER TABLE rate_card_versions
  ADD CONSTRAINT rate_card_versions_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES users (id);
ALTER TABLE allocation_rule_set_versions
  ADD CONSTRAINT allocation_rule_set_versions_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES users (id);

-- Who added each rate line. Lines already there are attributed from the audit log: the cluster lines to the seed
-- (rate_card.version_proposed), the AI lines to the command line (rate_card.lines_imported, actor `cli`). This is the
-- one write to existing rate lines, by this migration, and it only fills the new column.
ALTER TABLE rate_lines ADD COLUMN added_by text REFERENCES users (id);
ALTER TABLE rate_lines DISABLE TRIGGER rate_lines_append_only;
UPDATE rate_lines SET added_by = CASE WHEN provider IS NULL THEN 'seed' ELSE 'cli' END;
ALTER TABLE rate_lines ENABLE TRIGGER rate_lines_append_only;
ALTER TABLE rate_lines ALTER COLUMN added_by SET NOT NULL;

-- The approver: a person, not the proposer, and not anyone who added a line.
CREATE OR REPLACE FUNCTION rate_card_versions_four_eyes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NULL AND NEW.approved_by IS NOT NULL THEN
    IF NEW.approved_by = NEW.proposed_by THEN
      RAISE EXCEPTION 'the person who proposed rate card version % cannot approve it', NEW.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM rate_lines WHERE version_id = NEW.id AND added_by = NEW.approved_by) THEN
      RAISE EXCEPTION 'a person who added lines to rate card version % cannot approve it', NEW.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.approved_by AND kind = 'person') THEN
      RAISE EXCEPTION 'rate card version % is approved by a person (a user of kind person), never a system actor or a key', NEW.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION allocation_rule_set_versions_four_eyes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NULL AND NEW.approved_by IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.approved_by AND kind = 'person') THEN
    RAISE EXCEPTION 'rule set version % is approved by a person (a user of kind person), never a system actor or a key', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_rule_set_versions_four_eyes BEFORE UPDATE ON allocation_rule_set_versions
  FOR EACH ROW EXECUTE FUNCTION allocation_rule_set_versions_four_eyes();

-- Notes on versions, append only: what was true of an approval that the record alone doesn't say.
CREATE TABLE version_notes (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_type  text NOT NULL CHECK (subject_type IN ('rate_card_version','allocation_rule_set_version')),
  subject_id    text NOT NULL,
  note          text NOT NULL CHECK (length(note) > 0),
  added_by      text NOT NULL REFERENCES users (id),
  added_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX version_notes_subject ON version_notes (subject_type, subject_id);
CREATE TRIGGER version_notes_append_only BEFORE UPDATE OR DELETE ON version_notes
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER version_notes_no_truncate BEFORE TRUNCATE ON version_notes
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();

-- Versions approved before this migration stay approved; their note says what the check then covered.
INSERT INTO version_notes (subject_type, subject_id, note, added_by)
SELECT 'rate_card_version', id,
       'Approved before the four-eyes fix of wave 1''s review (migration 0005): the proposer was ' ||
       CASE WHEN proposed_by = 'seed' THEN 'the system seed' ELSE proposed_by END ||
       ', and the approver was checked against the proposer only, not against who added the lines (the AI lines ' ||
       'were imported from the command line with no person recorded). The approval stands; the lines are unchanged.',
       'seed'
FROM rate_card_versions WHERE approved_at IS NOT NULL;
INSERT INTO version_notes (subject_type, subject_id, note, added_by)
SELECT 'allocation_rule_set_version', id,
       'Approved before the four-eyes fix of wave 1''s review (migration 0005): the proposer was ' ||
       CASE WHEN proposed_by = 'seed' THEN 'the system seed' ELSE proposed_by END ||
       ', recorded as free text. The approval stands; the rules are unchanged.',
       'seed'
FROM allocation_rule_set_versions WHERE approved_at IS NOT NULL;
