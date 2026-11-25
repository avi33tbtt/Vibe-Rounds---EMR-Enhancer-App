-- Task R3e: the patient medication list, on the server (recorded list only, no codes checked here).
-- A medication belongs to the PATIENT, so it outlives any one case; origin_case_id (optional) must be a case of the same patient.
-- Nothing is ever deleted. A medication is stopped (with a reason) or marked entered in error (with a reason); every move is kept in patient_medication_events.
-- The rules below are enforced by the database, not only by the routes.

CREATE TABLE patient_medications (
  id              serial PRIMARY KEY,
  patient_id      integer NOT NULL REFERENCES patients(id),
  origin_case_id  integer,
  medication       text NOT NULL CHECK (length(btrim(medication)) BETWEEN 1 AND 200),   -- the clinician's words
  dose_text       text CHECK (dose_text IS NULL OR length(btrim(dose_text)) BETWEEN 1 AND 200),   -- null = not recorded; free text as recorded, never suggested
  frequency_text  text CHECK (frequency_text IS NULL OR length(btrim(frequency_text)) BETWEEN 1 AND 200),   -- null = not recorded; free text as the clinician wrote it, never suggested
  start_date      date,                                                                -- null = unknown
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','entered_in_error')),
  row_version     integer NOT NULL DEFAULT 1,
  recorded_by     integer NOT NULL REFERENCES users(id),                               -- from the session
  recorded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_by     integer REFERENCES users(id),
  stopped_at     timestamptz,
  stop_reason text CHECK (stop_reason IS NULL OR length(btrim(stop_reason)) BETWEEN 1 AND 1000),
  error_by        integer REFERENCES users(id),
  error_at        timestamptz,
  error_reason    text CHECK (error_reason IS NULL OR length(btrim(error_reason)) BETWEEN 1 AND 1000),
  FOREIGN KEY (origin_case_id, patient_id) REFERENCES clinical_cases (id, patient_id),
  CHECK (status <> 'active' OR (stopped_by IS NULL AND stopped_at IS NULL AND stop_reason IS NULL AND error_by IS NULL AND error_at IS NULL AND error_reason IS NULL)),
  CHECK (status <> 'stopped' OR (stopped_by IS NOT NULL AND stopped_at IS NOT NULL AND stop_reason IS NOT NULL AND error_by IS NULL AND error_at IS NULL AND error_reason IS NULL)),
  CHECK (status <> 'entered_in_error' OR (error_by IS NOT NULL AND error_at IS NOT NULL AND error_reason IS NOT NULL))
);
CREATE INDEX patient_medications_patient_idx ON patient_medications (patient_id, id);

CREATE FUNCTION patient_medication_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.row_version <> 1 THEN RAISE EXCEPTION 'a medication starts as active'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_medications_insert_guard BEFORE INSERT ON patient_medications
  FOR EACH ROW EXECUTE FUNCTION patient_medication_insert_guard();

-- Only the status move changes a row: active -> stopped, active -> entered_in_error, stopped -> entered_in_error. entered_in_error is final.
-- The medication, dose, frequency, patient, origin case, start date and who/when it was recorded never change (correct a mistake by marking it in error and adding a new one).
CREATE FUNCTION patient_medication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.origin_case_id IS DISTINCT FROM OLD.origin_case_id
     OR NEW.medication IS DISTINCT FROM OLD.medication OR NEW.dose_text IS DISTINCT FROM OLD.dose_text OR NEW.frequency_text IS DISTINCT FROM OLD.frequency_text
     OR NEW.start_date IS DISTINCT FROM OLD.start_date
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'the medication, dose, frequency, patient, origin case, start and recording of a medication cannot be changed';
  END IF;
  IF OLD.status = 'entered_in_error' THEN RAISE EXCEPTION 'a medication entered in error is final'; END IF;
  IF NOT ((OLD.status = 'active' AND NEW.status IN ('stopped','entered_in_error')) OR (OLD.status = 'stopped' AND NEW.status = 'entered_in_error')) THEN
    RAISE EXCEPTION 'a medication cannot move from % to %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'entered_in_error' AND OLD.status = 'stopped'
     AND (NEW.stopped_by IS DISTINCT FROM OLD.stopped_by OR NEW.stopped_at IS DISTINCT FROM OLD.stopped_at OR NEW.stop_reason IS DISTINCT FROM OLD.stop_reason) THEN
    RAISE EXCEPTION 'the resolution stays as it was recorded';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_medications_guard BEFORE UPDATE ON patient_medications
  FOR EACH ROW EXECUTE FUNCTION patient_medication_guard();

/* ---------- patient_medication_events: append-only history of every status move ---------- */
CREATE TABLE patient_medication_events (
  id          serial PRIMARY KEY,
  medication_id  integer NOT NULL REFERENCES patient_medications(id),
  seq         integer NOT NULL CHECK (seq >= 1),
  from_status text CHECK (from_status IN ('active','stopped','entered_in_error')),
  to_status   text NOT NULL CHECK (to_status IN ('active','stopped','entered_in_error')),
  reason      text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
  by_user     integer NOT NULL REFERENCES users(id),                                   -- from the session
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (medication_id, seq),
  CHECK ((seq = 1 AND from_status IS NULL AND to_status = 'active') OR (seq > 1 AND from_status IS NOT NULL AND to_status <> 'active' AND reason IS NOT NULL))
);

CREATE FUNCTION patient_medication_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM patient_medication_events WHERE medication_id = NEW.medication_id;
  IF NEW.seq <> n + 1 THEN RAISE EXCEPTION 'medication events are numbered one after the other'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_medication_events_guard BEFORE INSERT ON patient_medication_events
  FOR EACH ROW EXECUTE FUNCTION patient_medication_event_guard();

/* ---------- no hard delete, no truncate, for anyone ---------- */
CREATE TRIGGER patient_medications_no_delete   BEFORE DELETE   ON patient_medications FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_medications_no_truncate BEFORE TRUNCATE ON patient_medications FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_medication_events_no_change   BEFORE UPDATE OR DELETE ON patient_medication_events FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_medication_events_no_truncate BEFORE TRUNCATE         ON patient_medication_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

/* ---------- grants for emr_app: no DELETE, no TRUNCATE; UPDATE only on the status columns ---------- */
GRANT SELECT, INSERT ON patient_medications, patient_medication_events TO emr_app;
GRANT UPDATE (status, row_version, stopped_by, stopped_at, stop_reason, error_by, error_at, error_reason) ON patient_medications TO emr_app;
GRANT USAGE ON SEQUENCE patient_medications_id_seq, patient_medication_events_id_seq TO emr_app;
