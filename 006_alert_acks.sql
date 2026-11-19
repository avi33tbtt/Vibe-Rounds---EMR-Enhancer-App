-- 006_alert_acks.sql (chunk 35b): alert acknowledgements become server records.
-- Until now an acknowledgement lived inside cases.alert_log (a JSON list a client could overwrite). Now each one is its own row:
--   * who acknowledged is the signed-in user, stamped by the server (user_id), never typed
--   * sig is built by the client from the rule's content (operator, threshold, unit) and the reading time of the value that fired it, so an
--     edited rule or a newer reading gives a different sig and the old acknowledgement no longer applies (nothing is deleted, it is just not matched)
--   * append-only: no UPDATE, no DELETE, for the app role and by trigger
--   * acknowledgements carried over from the old list or from a browser import are marked source = 'imported' and have no user

-- 001_core.sql reserved the table (nothing has written to it); this migration finishes its shape.
ALTER TABLE alert_acks
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN source text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'imported')),
  ADD CONSTRAINT alert_acks_user_shape CHECK (source = 'imported' OR user_id IS NOT NULL),
  ADD CONSTRAINT alert_acks_ids_shape  CHECK (set_id ~ '^[A-Za-z0-9_.-]{1,100}$' AND rule_id ~ '^[A-Za-z0-9_.-]{1,100}$'),
  ADD CONSTRAINT alert_acks_sig_len    CHECK (length(sig) <= 500);
CREATE INDEX alert_acks_time_ix ON alert_acks (case_id, acked_at);

CREATE TRIGGER alert_acks_append_only BEFORE UPDATE OR DELETE ON alert_acks FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- carry over what the old list holds (entries without a valid rule id and set id could never match an alert, so they are left behind)
INSERT INTO alert_acks (case_id, set_id, rule_id, sig, source, acked_at)
SELECT c.id, a->>'setId', a->>'ruleId', left(coalesce(a->>'sig', ''), 500), 'imported',
       CASE WHEN a->>'ackedAt' ~ '^\d{4}-\d\d-\d\dT[0-9:.]+(Z|[+-]\d\d:\d\d)$' THEN (a->>'ackedAt')::timestamptz ELSE c.updated_at END
FROM cases c, jsonb_array_elements(c.alert_log) a
WHERE jsonb_typeof(a) = 'object'
  AND coalesce(a->>'ruleId', '') ~ '^[A-Za-z0-9_.-]{1,100}$' AND coalesce(a->>'setId', '') ~ '^[A-Za-z0-9_.-]{1,100}$';

-- app role (003_audit_grants.sql): only SELECT and INSERT
REVOKE ALL ON alert_acks FROM emr_app;                      -- 003 granted everything on the tables that existed then; take it back, give back only what is allowed
GRANT SELECT, INSERT ON alert_acks TO emr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO emr_app;   -- the bigserial id
