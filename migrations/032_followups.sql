-- Task R5f-2: follow-up after discharge on the server (a clinician records what follow-up was planned). A plan only: no booking, reminders or tasks.
-- Instruction, place and date are as the clinician typed them; nothing is suggested, matched or checked. A follow-up belongs to a DISCHARGED admission of the same patient.
-- Nothing is deleted. A follow-up is cancelled (with a reason) or marked entered in error (with a reason); every move is kept in patient_followup_events.

CREATE TABLE patient_followups (
  id               serial PRIMARY KEY,
  patient_id       integer NOT NULL REFERENCES patients(id),
  admission_id     integer NOT NULL REFERENCES patient_admissions(id),
  instruction_text text NOT NULL CHECK (length(btrim(instruction_text)) BETWEEN 1 AND 500),   -- what the follow-up is, as typed
  where_text       text CHECK (where_text IS NULL OR length(btrim(where_text)) BETWEEN 1 AND 200),   -- where or with whom, as typed (optional)
  follow_up_on     date CHECK (follow_up_on IS NULL OR follow_up_on BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),   -- planned day (optional); may be in the future
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','entered_in_error')),
  row_version      integer NOT NULL DEFAULT 1,
  recorded_by      integer NOT NULL REFERENCES users(id),                       -- from the session
  recorded_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_by     integer REFERENCES users(id),
  cancelled_at     timestamptz,
  cancel_reason    text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 1000),
  error_by         integer REFERENCES users(id),
  error_at         timestamptz,
  error_reason     text CHECK (error_reason IS NULL OR length(btrim(error_reason)) BETWEEN 1 AND 1000),
  CHECK (status <> 'active' OR (cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL AND error_by IS NULL AND error_at IS NULL AND error_reason IS NULL)),
  CHECK (status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL AND error_by IS NULL AND error_at IS NULL AND error_reason IS NULL)),
  CHECK (status <> 'entered_in_error' OR (error_by IS NOT NULL AND error_at IS NOT NULL AND error_reason IS NOT NULL))
);
CREATE INDEX patient_followups_patient_idx ON patient_followups (patient_id, id);
CREATE INDEX patient_followups_admission_idx ON patient_followups (admission_id, id);

CREATE FUNCTION patient_followup_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  IF NEW.status <> 'active' OR NEW.row_version <> 1 THEN RAISE EXCEPTION 'a follow-up starts as active'; END IF;
  SELECT patient_id, status INTO a FROM patient_admissions WHERE id = NEW.admission_id;
  IF NOT FOUND OR a.patient_id <> NEW.patient_id THEN RAISE EXCEPTION 'a follow-up belongs to an admission of the same patient'; END IF;
  IF a.status <> 'discharged' THEN RAISE EXCEPTION 'a follow-up is planned for a discharged admission'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_followups_insert_guard BEFORE INSERT ON patient_followups FOR EACH ROW EXECUTE FUNCTION patient_followup_insert_guard();

-- Only the status move changes a row: active -> cancelled | entered_in_error; cancelled -> entered_in_error. entered_in_error is final.
CREATE FUNCTION patient_followup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.admission_id IS DISTINCT FROM OLD.admission_id
     OR NEW.instruction_text IS DISTINCT FROM OLD.instruction_text OR NEW.where_text IS DISTINCT FROM OLD.where_text OR NEW.follow_up_on IS DISTINCT FROM OLD.follow_up_on
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'what was recorded, and who and when, cannot be changed';
  END IF;
  IF OLD.status = 'entered_in_error' THEN RAISE EXCEPTION 'a follow-up entered in error is final'; END IF;
  IF NOT ((OLD.status = 'active' AND NEW.status IN ('cancelled','entered_in_error')) OR (OLD.status = 'cancelled' AND NEW.status = 'entered_in_error')) THEN
    RAISE EXCEPTION 'a follow-up cannot move from % to %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'cancelled' AND (NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason) THEN
    RAISE EXCEPTION 'the cancellation stays as it was recorded';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_followups_guard BEFORE UPDATE ON patient_followups FOR EACH ROW EXECUTE FUNCTION patient_followup_guard();

CREATE TABLE patient_followup_events (
  id          serial PRIMARY KEY,
  followup_id integer NOT NULL REFERENCES patient_followups(id),
  seq         integer NOT NULL CHECK (seq >= 1),
  from_status text CHECK (from_status IN ('active','cancelled','entered_in_error')),
  to_status   text NOT NULL CHECK (to_status IN ('active','cancelled','entered_in_error')),
  reason      text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
  by_user     integer NOT NULL REFERENCES users(id),                           -- from the session
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (followup_id, seq),
  CHECK ((seq = 1 AND from_status IS NULL AND to_status = 'active') OR (seq > 1 AND from_status IS NOT NULL AND to_status <> 'active' AND reason IS NOT NULL))
);
CREATE FUNCTION patient_followup_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM patient_followup_events WHERE followup_id = NEW.followup_id;
  IF NEW.seq <> n + 1 THEN RAISE EXCEPTION 'follow-up events are numbered one after the other'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_followup_events_guard BEFORE INSERT ON patient_followup_events FOR EACH ROW EXECUTE FUNCTION patient_followup_event_guard();

CREATE TRIGGER patient_followups_no_delete   BEFORE DELETE   ON patient_followups FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_followups_no_truncate BEFORE TRUNCATE ON patient_followups FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_followup_events_no_change   BEFORE UPDATE OR DELETE ON patient_followup_events FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_followup_events_no_truncate BEFORE TRUNCATE         ON patient_followup_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT ON patient_followups, patient_followup_events TO emr_app;
GRANT UPDATE (status, row_version, cancelled_by, cancelled_at, cancel_reason, error_by, error_at, error_reason) ON patient_followups TO emr_app;
GRANT USAGE ON SEQUENCE patient_followups_id_seq, patient_followup_events_id_seq TO emr_app;
