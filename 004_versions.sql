-- 004_versions.sql  (chunk 33b)
-- Old versions of a reading (case_rows) and of a saved value (case_values) are kept, never overwritten. Every edit or "entered in error" copies the version
-- it replaces into row_versions / value_versions in the SAME transaction as the change (api.js). Both tables are append-only.
-- Clinical records are also never deleted: DELETE is refused by trigger for everyone and not granted to the app role.

-- who/when wrote the CURRENT version of a row (NULL = never changed since entered_by / entered_at)
ALTER TABLE case_rows ADD COLUMN updated_by uuid REFERENCES users(id);
ALTER TABLE case_rows ADD COLUMN updated_at timestamptz;

CREATE TABLE row_versions (
  id           bigserial PRIMARY KEY,
  row_id       uuid NOT NULL REFERENCES case_rows(id),
  case_id      uuid NOT NULL REFERENCES cases(id),
  version      int  NOT NULL CHECK (version >= 1),      -- the version number this copy had
  row          jsonb NOT NULL,
  row_time     timestamptz,
  status       text NOT NULL CHECK (status IN ('active','entered_in_error')),
  error_reason text,
  written_by   uuid REFERENCES users(id),               -- who wrote this old version, and when
  written_at   timestamptz NOT NULL,
  replaced_by  uuid REFERENCES users(id),               -- who replaced it, when and why
  replaced_at  timestamptz NOT NULL DEFAULT now(),
  reason       text,                                    -- required when the row is marked entered in error; optional for an edit
  UNIQUE (row_id, version)
);
CREATE INDEX row_versions_case_ix ON row_versions (case_id, row_id);

CREATE TABLE value_versions (
  id           bigserial PRIMARY KEY,
  case_id      uuid NOT NULL REFERENCES cases(id),
  key          text NOT NULL,
  version      int  NOT NULL CHECK (version >= 1),
  value        jsonb NOT NULL,
  written_by   uuid REFERENCES users(id),
  written_at   timestamptz NOT NULL,
  replaced_by  uuid REFERENCES users(id),
  replaced_at  timestamptz NOT NULL DEFAULT now(),
  reason       text,
  UNIQUE (case_id, key, version)
);

-- statement-level, so they also refuse on an empty table and refuse TRUNCATE
CREATE TRIGGER row_versions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON row_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER value_versions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON value_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- clinical data is never deleted (rows are marked entered in error instead)
CREATE TRIGGER cases_no_delete BEFORE DELETE OR TRUNCATE ON cases FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_rows_no_delete BEFORE DELETE OR TRUNCATE ON case_rows FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_values_no_delete BEFORE DELETE OR TRUNCATE ON case_values FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_notes_no_delete BEFORE DELETE OR TRUNCATE ON case_notes FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- app role (see 003_audit_grants.sql): new tables get nothing until granted here
GRANT SELECT, INSERT ON row_versions, value_versions TO emr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO emr_app;
REVOKE DELETE, TRUNCATE ON cases, case_rows, case_values, case_notes FROM emr_app;
