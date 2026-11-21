-- 43b3: submit for review. review_requests and review_events already exist (001_core.sql: set_version, author_id, status incl. 'draft', checklist, reviewer_id,
-- CHECK reviewer <> author; review_events is append-only). This migration only adds what a submit needs: the hash of the version submitted and the time it was submitted.
-- The body is not copied: every version in element_sets is immutable, so a reviewer reads it from there. No patient data, no request text.
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
-- one open request per version
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_open_key ON review_requests (set_id, set_version) WHERE status IN ('submitted','in_review','changes_requested');
CREATE INDEX IF NOT EXISTS review_requests_status_idx ON review_requests (status, submitted_at);
-- Never DELETE. SELECT, INSERT and UPDATE (a request changes status when reviewed, 44a2); review_events stays INSERT and SELECT only (003_audit_grants.sql).
GRANT SELECT, INSERT, UPDATE ON review_requests TO emr_app;
