-- Task DM2a: CCIS run records imported against ONE case, and acknowledgements of them.
-- A run record is a result file made by CCIS from an exported envelope. It is kept exactly as received and never changes:
-- no update, no delete, no truncate, for anyone (same triggers as the audit log). It never touches clinical tables.
-- An acknowledgement says a clinician has seen the run. It is not approval of the result.

CREATE TABLE ccis_runs (
  id                bigserial PRIMARY KEY,
  case_id           integer NOT NULL REFERENCES clinical_cases(id),
  run_record        jsonb   NOT NULL CHECK (jsonb_typeof(run_record) = 'object'),
  run_record_sha256 text    NOT NULL CHECK (run_record_sha256 ~ '^[0-9a-f]{64}$'),   -- SHA-256 of the record as canonical JSON (keys sorted)
  envelope_sha256   text    NOT NULL CHECK (envelope_sha256 ~ '^[0-9a-f]{64}$'),     -- the exported envelope the record says it was made from
  imported_by       integer NOT NULL REFERENCES users(id),                           -- from the session, never from the request
  imported_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (case_id, run_record_sha256)
);
CREATE INDEX ccis_runs_case_idx ON ccis_runs (case_id, id DESC);

CREATE TABLE ccis_run_acks (
  id              bigserial PRIMARY KEY,
  run_id          bigint  NOT NULL REFERENCES ccis_runs(id),
  acknowledged_by integer NOT NULL REFERENCES users(id),                             -- from the session, never from the request
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  note            text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  UNIQUE (run_id, acknowledged_by)
);

-- The database itself refuses a record whose envelope was never exported for that case (the route checks too).
CREATE FUNCTION ccis_runs_require_export() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM context_exports WHERE case_id = NEW.case_id AND envelope_sha256 = NEW.envelope_sha256) THEN
    RAISE EXCEPTION 'ccis_runs: envelope % was never exported for case %', NEW.envelope_sha256, NEW.case_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ccis_runs_need_export BEFORE INSERT ON ccis_runs FOR EACH ROW EXECUTE FUNCTION ccis_runs_require_export();

CREATE TRIGGER ccis_runs_no_change        BEFORE UPDATE OR DELETE ON ccis_runs     FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ccis_runs_no_truncate      BEFORE TRUNCATE         ON ccis_runs     FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ccis_run_acks_no_change    BEFORE UPDATE OR DELETE ON ccis_run_acks FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ccis_run_acks_no_truncate  BEFORE TRUNCATE         ON ccis_run_acks FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT ON ccis_runs, ccis_run_acks TO emr_app;
GRANT USAGE ON SEQUENCE ccis_runs_id_seq, ccis_run_acks_id_seq TO emr_app;
