-- 006_alert_acks.sql (chunk 35b): alert acknowledgements become server records.
-- Until now an acknowledgement lived inside the case (cases.alert_log) and was saved as part of the case. From now on each one is a row in alert_acks:
-- who acknowledged (the signed-in user, stamped by the server), when, and the sig of the alert. sig changes when the rule is edited or a new reading arrives,
-- so an old acknowledgement stops counting; the row itself is never changed or removed.
--   * one row per (case, rule, set, sig): a second person acknowledging the same alert finds the first acknowledgement, and sees who made it
--   * 'imported' marks acknowledgements brought in from a browser (chunk 31 import); they are attributed to the admin who ran the import
--   * append-only: a trigger refuses UPDATE and DELETE, and the app role loses those rights
-- cases.alert_log stays in the table, no longer read or written (a column is never dropped silently); new cases keep '[]'.
ALTER TABLE alert_acks ADD COLUMN imported boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX alert_acks_once_uq ON alert_acks (case_id, rule_id, set_id, sig);
CREATE TRIGGER alert_acks_append_only BEFORE UPDATE OR DELETE ON alert_acks FOR EACH ROW EXECUTE FUNCTION forbid_change();
REVOKE UPDATE, DELETE, TRUNCATE ON alert_acks FROM emr_app;
