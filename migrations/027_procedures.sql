-- Task R4i-1: procedures on the server (a clinician records what was done to a patient). Procedures only: no scheduling, consent forms, billing or codes.
-- The procedure name and outcome note are free text as typed; nothing is suggested, matched or checked. The performed date-time must carry an offset and cannot be in the future.
-- Nothing is deleted. A procedure is cancelled (with a reason) or marked entered in error (with a reason); every move is kept in patient_procedure_events.

CREATE TABLE patient_procedures (
  id              serial PRIMARY KEY,
  patient_id      integer NOT NULL REFERENCES patients(id),
  origin_case_id  integer,
  procedure_text  text NOT NULL CHECK (length(btrim(procedure_text)) BETWEEN 1 AND 200),     -- what was done, as the clinician typed it; nothing is suggested or checked
  performed_at    timestamptz NOT NULL,                                                       -- when it was done, as the clinician stated it
  outcome_text    text CHECK (outcome_text IS NULL OR length(btrim(outcome_text)) BETWEEN 1 AND 500),   -- optional, as typed
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','entered_in_error')),
  row_version     integer NOT NULL DEFAULT 1,
  recorded_by     integer NOT NULL REFERENCES users(id),                       -- from the session
  recorded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_by    integer REFERENCES users(id),
  cancelled_at    timestamptz,
  cancel_reason   text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 1000),
  error_by        integer REFERENCES users(id),
  error_at        timestamptz,
  error_reason    text CHECK (error_reason IS NULL OR length(btrim(error_reason)) BETWEEN 1 AND 1000),
  FOREIGN KEY (origin_case_id, patient_id) REFERENCES clinical_cases (id, patient_id),
  CHECK (status <> 'active' OR (cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL AND error_by IS NULL AND error_at IS NULL AND error_reason IS NULL)),
  CHECK (status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL AND error_by IS NULL AND error_at IS NULL AND error_reason IS NULL)),
  CHECK (status <> 'entered_in_error' OR (error_by IS NOT NULL AND error_at IS NOT NULL AND error_reason IS NOT NULL))
);
CREATE INDEX patient_procedures_patient_idx ON patient_procedures (patient_id, id);

CREATE FUNCTION patient_procedure_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.row_version <> 1 THEN RAISE EXCEPTION 'a procedure starts as active'; END IF;
  IF NEW.performed_at > clock_timestamp() THEN RAISE EXCEPTION 'a procedure cannot be performed in the future'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_procedures_insert_guard BEFORE INSERT ON patient_procedures FOR EACH ROW EXECUTE FUNCTION patient_procedure_insert_guard();

-- Only the status move changes a row: active -> cancelled | entered_in_error; cancelled -> entered_in_error. entered_in_error is final.
CREATE FUNCTION patient_procedure_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.origin_case_id IS DISTINCT FROM OLD.origin_case_id
     OR NEW.procedure_text IS DISTINCT FROM OLD.procedure_text OR NEW.performed_at IS DISTINCT FROM OLD.performed_at OR NEW.outcome_text IS DISTINCT FROM OLD.outcome_text
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'what was recorded, and who and when, cannot be changed';
  END IF;
  IF OLD.status = 'entered_in_error' THEN RAISE EXCEPTION 'a procedure entered in error is final'; END IF;
  IF NOT ((OLD.status = 'active' AND NEW.status IN ('cancelled','entered_in_error')) OR (OLD.status = 'cancelled' AND NEW.status = 'entered_in_error')) THEN
    RAISE EXCEPTION 'a procedure cannot move from % to %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'cancelled' AND (NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason) THEN
    RAISE EXCEPTION 'the cancellation stays as it was recorded';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_procedures_guard BEFORE UPDATE ON patient_procedures FOR EACH ROW EXECUTE FUNCTION patient_procedure_guard();

CREATE TABLE patient_procedure_events (
  id          serial PRIMARY KEY,
  procedure_id    integer NOT NULL REFERENCES patient_procedures(id),
  seq         integer NOT NULL CHECK (seq >= 1),
  from_status text CHECK (from_status IN ('active','cancelled','entered_in_error')),
  to_status   text NOT NULL CHECK (to_status IN ('active','cancelled','entered_in_error')),
  reason      text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
  by_user     integer NOT NULL REFERENCES users(id),                           -- from the session
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (procedure_id, seq),
  CHECK ((seq = 1 AND from_status IS NULL AND to_status = 'active') OR (seq > 1 AND from_status IS NOT NULL AND to_status <> 'active' AND reason IS NOT NULL))
);
CREATE FUNCTION patient_procedure_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM patient_procedure_events WHERE procedure_id = NEW.procedure_id;
  IF NEW.seq <> n + 1 THEN RAISE EXCEPTION 'procedure events are numbered one after the other'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_procedure_events_guard BEFORE INSERT ON patient_procedure_events FOR EACH ROW EXECUTE FUNCTION patient_procedure_event_guard();

CREATE TRIGGER patient_procedures_no_delete   BEFORE DELETE   ON patient_procedures FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_procedures_no_truncate BEFORE TRUNCATE ON patient_procedures FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_procedure_events_no_change   BEFORE UPDATE OR DELETE ON patient_procedure_events FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_procedure_events_no_truncate BEFORE TRUNCATE         ON patient_procedure_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT ON patient_procedures, patient_procedure_events TO emr_app;
GRANT UPDATE (status, row_version, cancelled_by, cancelled_at, cancel_reason, error_by, error_at, error_reason) ON patient_procedures TO emr_app;
GRANT USAGE ON SEQUENCE patient_procedures_id_seq, patient_procedure_events_id_seq TO emr_app;
