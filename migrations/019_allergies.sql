-- Task R3c: the patient allergy list, on the server (recorded list only, no codes checked here).
-- An allergy belongs to the PATIENT, so it outlives any one case; origin_case_id (optional) must be a case of the same patient.
-- Nothing is ever deleted. An allergy is resolved (with a reason) or marked entered in error (with a reason); every move is kept in patient_allergy_events.
-- The rules below are enforced by the database, not only by the routes.

CREATE TABLE patient_allergies (
  id              serial PRIMARY KEY,
  patient_id      integer NOT NULL REFERENCES patients(id),
  origin_case_id  integer,
  substance       text NOT NULL CHECK (length(btrim(substance)) BETWEEN 1 AND 200),   -- the clinician's words
  reaction        text CHECK (reaction IS NULL OR length(btrim(reaction)) BETWEEN 1 AND 500),   -- null = not recorded
  severity        text CHECK (severity IS NULL OR severity IN ('mild','moderate','severe')),     -- null = not recorded
  onset_date      date,                                                                -- null = unknown
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','entered_in_error')),
  row_version     integer NOT NULL DEFAULT 1,
  recorded_by     integer NOT NULL REFERENCES users(id),                               -- from the session
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
CREATE INDEX patient_allergies_patient_idx ON patient_allergies (patient_id, id);

CREATE FUNCTION patient_allergy_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.row_version <> 1 THEN RAISE EXCEPTION 'an allergy starts as active'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_allergies_insert_guard BEFORE INSERT ON patient_allergies
  FOR EACH ROW EXECUTE FUNCTION patient_allergy_insert_guard();

-- Only the status move changes a row: active -> resolved, active -> entered_in_error, resolved -> entered_in_error. entered_in_error is final.
-- The substance, reaction, severity, patient, origin case, onset date and who/when it was recorded never change (correct a mistake by marking it in error and adding a new one).
CREATE FUNCTION patient_allergy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.origin_case_id IS DISTINCT FROM OLD.origin_case_id
     OR NEW.substance IS DISTINCT FROM OLD.substance OR NEW.reaction IS DISTINCT FROM OLD.reaction OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.onset_date IS DISTINCT FROM OLD.onset_date
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'the substance, reaction, severity, patient, origin case, onset and recording of an allergy cannot be changed';
  END IF;
  IF OLD.status = 'entered_in_error' THEN RAISE EXCEPTION 'an allergy entered in error is final'; END IF;
  IF NOT ((OLD.status = 'active' AND NEW.status IN ('resolved','entered_in_error')) OR (OLD.status = 'resolved' AND NEW.status = 'entered_in_error')) THEN
    RAISE EXCEPTION 'an allergy cannot move from % to %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'entered_in_error' AND OLD.status = 'resolved'
     AND (NEW.resolved_by IS DISTINCT FROM OLD.resolved_by OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at OR NEW.resolution_reason IS DISTINCT FROM OLD.resolution_reason) THEN
    RAISE EXCEPTION 'the resolution stays as it was recorded';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_allergies_guard BEFORE UPDATE ON patient_allergies
  FOR EACH ROW EXECUTE FUNCTION patient_allergy_guard();

/* ---------- patient_allergy_events: append-only history of every status move ---------- */
CREATE TABLE patient_allergy_events (
  id          serial PRIMARY KEY,
  allergy_id  integer NOT NULL REFERENCES patient_allergies(id),
  seq         integer NOT NULL CHECK (seq >= 1),
  from_status text CHECK (from_status IN ('active','resolved','entered_in_error')),
  to_status   text NOT NULL CHECK (to_status IN ('active','resolved','entered_in_error')),
  reason      text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
  by_user     integer NOT NULL REFERENCES users(id),                                   -- from the session
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (allergy_id, seq),
  CHECK ((seq = 1 AND from_status IS NULL AND to_status = 'active') OR (seq > 1 AND from_status IS NOT NULL AND to_status <> 'active' AND reason IS NOT NULL))
);

CREATE FUNCTION patient_allergy_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM patient_allergy_events WHERE allergy_id = NEW.allergy_id;
  IF NEW.seq <> n + 1 THEN RAISE EXCEPTION 'allergy events are numbered one after the other'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_allergy_events_guard BEFORE INSERT ON patient_allergy_events
  FOR EACH ROW EXECUTE FUNCTION patient_allergy_event_guard();

/* ---------- no hard delete, no truncate, for anyone ---------- */
CREATE TRIGGER patient_allergies_no_delete   BEFORE DELETE   ON patient_allergies FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_allergies_no_truncate BEFORE TRUNCATE ON patient_allergies FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_allergy_events_no_change   BEFORE UPDATE OR DELETE ON patient_allergy_events FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER patient_allergy_events_no_truncate BEFORE TRUNCATE         ON patient_allergy_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

/* ---------- grants for emr_app: no DELETE, no TRUNCATE; UPDATE only on the status columns ---------- */
GRANT SELECT, INSERT ON patient_allergies, patient_allergy_events TO emr_app;
GRANT UPDATE (status, row_version, resolved_by, resolved_at, resolution_reason, error_by, error_at, error_reason) ON patient_allergies TO emr_app;
GRANT USAGE ON SEQUENCE patient_allergies_id_seq, patient_allergy_events_id_seq TO emr_app;
