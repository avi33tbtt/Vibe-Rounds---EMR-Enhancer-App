-- Task B5b: a log of context-envelope exports. One row per export: who, which case, when (server time), and the SHA-256 of the exact bytes sent.
-- It holds no content, name or reference. Append-only: no update, no delete, no truncate, for anyone (same triggers as the audit log).
CREATE TABLE context_exports (
  id               bigserial PRIMARY KEY,
  case_id          integer NOT NULL REFERENCES clinical_cases(id),
  envelope_sha256  text NOT NULL CHECK (envelope_sha256 ~ '^[0-9a-f]{64}$'),
  envelope_version text NOT NULL CHECK (envelope_version ~ '^\d+\.\d+\.\d+$'),
  observations     integer NOT NULL CHECK (observations >= 0),
  exported_by      integer NOT NULL REFERENCES users(id),   -- from the session, never from the request
  exported_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX context_exports_case_idx ON context_exports (case_id, id DESC);

CREATE TRIGGER context_exports_no_change   BEFORE UPDATE OR DELETE ON context_exports FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER context_exports_no_truncate BEFORE TRUNCATE         ON context_exports FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT ON context_exports TO emr_app;
GRANT USAGE ON SEQUENCE context_exports_id_seq TO emr_app;
