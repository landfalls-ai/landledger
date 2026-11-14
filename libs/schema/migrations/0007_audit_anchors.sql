-- 0007_audit_anchors: the audit chain's head, sent outside the database (review of wave 1, finding 6). A chain proves
-- that no entry was changed, but not that the newest ones weren't cut off: whoever can delete the tail can make a
-- shorter chain that verifies. So the head (seq and hash) is sent out on a schedule, to Clickland as a log record and
-- span attribute and to webhooks as `audit.anchor`, and recorded here; verify compares the chain with the last anchor.
-- Shipped migrations are never edited: a change is a new file.

CREATE TABLE audit_anchors (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seq          bigint NOT NULL CHECK (seq >= 1),
  hash         char(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  anchored_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Where it went: `log` (OTLP to Clickland), `webhook` (with the number of deliveries queued).
  sinks        jsonb NOT NULL CHECK (jsonb_typeof(sinks) = 'object')
);
CREATE INDEX audit_anchors_seq ON audit_anchors (seq DESC);
CREATE TRIGGER audit_anchors_append_only BEFORE UPDATE OR DELETE ON audit_anchors
  FOR EACH ROW EXECUTE FUNCTION landledger_append_only();
CREATE TRIGGER audit_anchors_no_truncate BEFORE TRUNCATE ON audit_anchors
  FOR EACH STATEMENT EXECUTE FUNCTION landledger_append_only();
