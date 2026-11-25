-- Task R3a-1: the patient problem list, on the server (recorded list only, no codes checked here).
-- A problem belongs to the PATIENT, so it outlives any one case; origin_case_id (optional) must be a case of the same patient.
-- Nothing is ever deleted. A problem is resolved (with a reason) or marked entered in error (with a reason); every move is kept in patient_problem_events.
-- The rules below are enforced by the database, not only by the routes.

CREATE TABLE patient_problems (
  id              serial PRIMARY KEY,
  patient_id      integer NOT NULL REFERENCES patients(id),
  origin_case_id  integer,
  label           text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),     -- the clinician's words
  onset_date      date,                                                              -- null = unknown
  local_term_code text CHECK (local_term_code IS NULL OR length(local_term_code) BETWEEN 1 AND 100),   -- reserved for a later row; the routes do not set it
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','entered_in_error')),
  row_version     integer NOT NULL DEFAULT 1,
  recorded_by     integer NOT NULL REFERENCES users(id),                             -- from the session
  recorded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_by     integer REFERENCES users(id),
  resolved_at     timestamptz,
  resolution_reason text CHECK (resolution_reason IS NULL OR length(btrim(resolution_reason)) BETWEEN 1 AND 1000),
  error_by        integer REFERENCES users(id),
  error_at        timestamptz,
  error_reason    text CHECK (error_reason IS NULL OR length(btrim(error_reason)) BETWEEN 1 AND 1000),
  FOREIGN KEY (origin_case_id, patient_id) REFERENCES clinical_cases (id, patient_id),
  CHECK (status <> 'active' OR (resolved_by IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL AND error_by IS NULL AND error_at IS NULL AND error_reason IS NULL)),
  CHECK (status <> 'resolved' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL AND error_by IS NULL AND error_at IS NULL AND error_reason IS NULL)),
  CHECK (status <> 'entered_in_error' OR (error_by IS NOT NULL AND error_at IS NOT NULL AND error_reason IS NOT NULL))
);
CREATE INDEX patient_problems_patient_idx ON patient_problems (patient_id, id);

CREATE FUNCTION patient_problem_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.row_version <> 1 THEN RAISE EXCEPTION 'a problem starts as active'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_problems_insert_guard BEFORE INSERT ON patient_problems
  FOR EACH ROW EXECUTE FUNCTION patient_problem_insert_guard();

-- Only the status move changes a row: active -> resolved, active -> entered_in_error, resolved -> entered_in_error. entered_in_error is final.
-- The label, patient, origin case, onset date and who/when it was recorded never change.
CREATE FUNCTION patient_problem_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.origin_case_id IS DISTINCT FROM OLD.origin_case_id
     OR NEW.label IS DISTINCT FROM OLD.label OR NEW.onset_date IS DISTINCT FROM OLD.onset_date OR NEW.local_term_code IS DISTINCT FROM OLD.local_term_code
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'the label, patient, origin case, onset and recording of a problem cannot be changed';
  END IF;
  IF OLD.status = 'entered_in_error' THEN RAISE EXCEPTION 'a problem entered in error is final'; END IF;
  IF NOT ((OLD.status = 'active' AND NEW.status IN ('resolved','entered_in_error')) OR (OLD.status = 'resolved' AND NEW.status = 'entered_in_error')) THEN
    RAISE EXCEPTION 'a problem cannot move from % to %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'entered_in_error' AND OLD.status = 'resolved'
     AND (NEW.resolved_by IS DISTINCT FROM OLD.resolved_by OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at OR NEW.resolution_reason IS DISTINCT FROM OLD.resolution_reason) THEN
    RAISE EXCEPTION 'the resolution stays as it was recorded';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_problems_guard BEFORE UPDATE ON patient_problems
  FOR EACH ROW EXECUTE FUNCTION patient_problem_guard();

/* ---------- patient_problem_events: append-only history of every status move ---------- */
CREATE TABLE patient_problem_events (
  id          serial PRIMARY KEY,
  problem_id  integer NOT NULL REFERENCES patient_problems(id),
  seq         integer NOT NULL CHECK (seq >= 1),
  from_status text CHECK (from_status IN ('active','resolved','entered_in_error')),
  to_status   text NOT NULL CHECK (to_status IN ('active','resolved','entered_in_error')),
  reason      text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
  by_user     integer NOT NULL REFERENCES users(id),                                  -- from the session
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (problem_id, seq),
  CHECK ((seq = 1 AND from_status IS NULL AND to_status = 'active') OR (seq > 1 AND from_status IS NOT NULL AND to_status <> 'active' AND reason IS NOT NULL))
);

CREATE FUNCTION patient_problem_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM patient_problem_events WHERE problem_id = NEW.problem_id;
  IF NEW.seq <> n + 1 THEN RAISE EXCEPTION 'problem events are numbered one after the other'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_problem_events_guard BEFORE INSERT ON patient_problem_events
  FOR EACH ROW EXECUTE FUNCTION patient_problem_event_guard();

/* ---------- no hard delete, no truncate, for anyone ---------- */
CREATE TRIGGER patient_problems_no_delete   BEFORE DELETE   ON patient_problems FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_problems_no_truncate BEFORE TRUNCATE ON patient_problems FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_problem_events_no_change   BEFORE UPDATE OR DELETE ON patient_problem_events FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_problem_events_no_truncate BEFORE TRUNCATE         ON patient_problem_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

/* ---------- grants for emr_app: no DELETE, no TRUNCATE; UPDATE only on the status columns ---------- */
GRANT SELECT, INSERT ON patient_problems, patient_problem_events TO emr_app;
GRANT UPDATE (status, row_version, resolved_by, resolved_at, resolution_reason, error_by, error_at, error_reason) ON patient_problems TO emr_app;
GRANT USAGE ON SEQUENCE patient_problems_id_seq, patient_problem_events_id_seq TO emr_app;
