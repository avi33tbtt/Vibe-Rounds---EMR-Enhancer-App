-- Task R5f-1: discharge on the server. A discharge closes an active admission: the admission becomes 'discharged' and a discharge record is kept in admission_discharges.
-- Discharge only: no follow-up (R5f-2), no beds or transfers, no discharge medication. Time, summary and condition are free text / a stated moment, nothing suggested or checked.
-- A discharge row is never changed or deleted. A wrong discharge cannot be undone: the admission can be marked entered in error (final, with a reason) and a new admission recorded.

ALTER TABLE patient_admissions DROP CONSTRAINT patient_admissions_status_check;
ALTER TABLE patient_admissions ADD CONSTRAINT patient_admissions_status_check CHECK (status IN ('active','cancelled','discharged','entered_in_error'));
ALTER TABLE patient_admissions ADD CONSTRAINT patient_admissions_discharged_check CHECK (status <> 'discharged' OR (cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL AND error_by IS NULL AND error_at IS NULL AND error_reason IS NULL));

ALTER TABLE patient_admission_events DROP CONSTRAINT patient_admission_events_from_status_check;
ALTER TABLE patient_admission_events DROP CONSTRAINT patient_admission_events_to_status_check;
ALTER TABLE patient_admission_events DROP CONSTRAINT patient_admission_events_check;
ALTER TABLE patient_admission_events ADD CONSTRAINT patient_admission_events_from_status_check CHECK (from_status IN ('active','cancelled','discharged','entered_in_error'));
ALTER TABLE patient_admission_events ADD CONSTRAINT patient_admission_events_to_status_check CHECK (to_status IN ('active','cancelled','discharged','entered_in_error'));
ALTER TABLE patient_admission_events ADD CONSTRAINT patient_admission_events_check
  CHECK ((seq = 1 AND from_status IS NULL AND to_status = 'active') OR (seq > 1 AND from_status IS NOT NULL AND to_status <> 'active' AND (reason IS NOT NULL OR to_status = 'discharged')));   -- a discharge keeps its text in admission_discharges

CREATE TABLE admission_discharges (
  id             serial PRIMARY KEY,
  admission_id   integer NOT NULL UNIQUE REFERENCES patient_admissions(id),    -- one discharge per admission
  patient_id     integer NOT NULL REFERENCES patients(id),
  discharged_at  timestamptz NOT NULL,                                          -- when the patient left, as the clinician stated it
  summary_text   text NOT NULL CHECK (length(btrim(summary_text)) BETWEEN 1 AND 2000),   -- discharge summary, as typed
  condition_text text CHECK (condition_text IS NULL OR length(btrim(condition_text)) BETWEEN 1 AND 500),   -- condition at discharge, as typed (optional)
  recorded_by    integer NOT NULL REFERENCES users(id),                         -- from the session
  recorded_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX admission_discharges_patient_idx ON admission_discharges (patient_id, id);

CREATE FUNCTION admission_discharge_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  SELECT patient_id, status, admitted_at INTO a FROM patient_admissions WHERE id = NEW.admission_id;
  IF NOT FOUND OR a.patient_id <> NEW.patient_id THEN RAISE EXCEPTION 'a discharge belongs to an admission of the same patient'; END IF;
  IF a.status <> 'active' THEN RAISE EXCEPTION 'only an active admission can be discharged'; END IF;
  IF NEW.discharged_at > clock_timestamp() THEN RAISE EXCEPTION 'a discharge cannot be in the future'; END IF;
  IF NEW.discharged_at < a.admitted_at THEN RAISE EXCEPTION 'a discharge cannot be before the admission'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admission_discharges_insert_guard BEFORE INSERT ON admission_discharges FOR EACH ROW EXECUTE FUNCTION admission_discharge_insert_guard();

CREATE TRIGGER admission_discharges_no_change   BEFORE UPDATE OR DELETE ON admission_discharges FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER admission_discharges_no_truncate BEFORE TRUNCATE         ON admission_discharges FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Status moves: active -> cancelled | discharged | entered_in_error; cancelled -> entered_in_error; discharged -> entered_in_error. entered_in_error is final. A discharge needs its discharge row first.
CREATE OR REPLACE FUNCTION patient_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.origin_case_id IS DISTINCT FROM OLD.origin_case_id
     OR NEW.ward_text IS DISTINCT FROM OLD.ward_text OR NEW.admitted_at IS DISTINCT FROM OLD.admitted_at OR NEW.reason_text IS DISTINCT FROM OLD.reason_text
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'what was recorded, and who and when, cannot be changed';
  END IF;
  IF OLD.status = 'entered_in_error' THEN RAISE EXCEPTION 'an admission entered in error is final'; END IF;
  IF NOT ((OLD.status = 'active' AND NEW.status IN ('cancelled','discharged','entered_in_error')) OR (OLD.status IN ('cancelled','discharged') AND NEW.status = 'entered_in_error')) THEN
    RAISE EXCEPTION 'an admission cannot move from % to %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'discharged' AND NOT EXISTS (SELECT 1 FROM admission_discharges WHERE admission_id = NEW.id) THEN
    RAISE EXCEPTION 'an admission is discharged by recording its discharge';
  END IF;
  IF OLD.status = 'cancelled' AND (NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason) THEN
    RAISE EXCEPTION 'the cancellation stays as it was recorded';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  RETURN NEW;
END $$;

GRANT SELECT, INSERT ON admission_discharges TO emr_app;
GRANT USAGE ON SEQUENCE admission_discharges_id_seq TO emr_app;
