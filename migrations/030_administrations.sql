-- Task R5d: medication administration record (MAR), server side. A nurse or doctor records what happened at a dose of an existing medication order: given, held or refused.
-- Recording only: no schedule, no due-dose list, no alerts, no dose checks, no calculation. The dose given, the reason and the note are free text as typed; nothing is suggested or filled in.
-- Append-only: an administration is never edited or deleted. A wrong entry is marked entered in error (with a reason, final); the entry stays. Every move is kept in medication_administration_events.
-- The recorder and the error-marker come from the session. The moment must carry an offset and cannot be in the future, and cannot be before the order was made; an ended order only takes doses before it ended.

CREATE TABLE medication_administrations (
  id              serial PRIMARY KEY,
  patient_id      integer NOT NULL REFERENCES patients(id),
  order_id        integer NOT NULL REFERENCES medication_orders(id),
  outcome         text NOT NULL CHECK (outcome IN ('given','held','refused')),
  administered_at timestamptz NOT NULL,                                                      -- when the dose was given, or when it was held or refused, as the person stated it
  dose_text       text CHECK (dose_text IS NULL OR length(btrim(dose_text)) BETWEEN 1 AND 200),   -- dose actually given, as typed; never copied from the order
  reason_text     text CHECK (reason_text IS NULL OR length(btrim(reason_text)) BETWEEN 1 AND 500), -- why held or refused, as typed
  note_text       text CHECK (note_text IS NULL OR length(btrim(note_text)) BETWEEN 1 AND 500),
  status          text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','entered_in_error')),
  row_version     integer NOT NULL DEFAULT 1,
  recorded_by     integer NOT NULL REFERENCES users(id),                       -- from the session
  recorded_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  error_by        integer REFERENCES users(id),
  error_at        timestamptz,
  error_reason    text CHECK (error_reason IS NULL OR length(btrim(error_reason)) BETWEEN 1 AND 1000),
  CHECK (outcome = 'given' OR reason_text IS NOT NULL),                        -- held or refused needs a reason
  CHECK (outcome = 'given' OR dose_text IS NULL),                              -- a dose is only recorded for a dose that was given
  CHECK (status <> 'recorded' OR (error_by IS NULL AND error_at IS NULL AND error_reason IS NULL)),
  CHECK (status <> 'entered_in_error' OR (error_by IS NOT NULL AND error_at IS NOT NULL AND error_reason IS NOT NULL))
);
CREATE INDEX medication_administrations_patient_idx ON medication_administrations (patient_id, id);
CREATE INDEX medication_administrations_order_idx ON medication_administrations (order_id, administered_at);
CREATE UNIQUE INDEX medication_administrations_one_per_moment ON medication_administrations (order_id, administered_at) WHERE status = 'recorded';   -- a double click records once

-- A new administration: starts recorded; the order belongs to the same patient and is not entered in error; the moment is not in the future,
-- not before the order was made, and (for an order that was stopped or changed) before it ended.
CREATE FUNCTION medication_administration_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o medication_orders%ROWTYPE;
BEGIN
  IF NEW.status <> 'recorded' OR NEW.row_version <> 1 THEN RAISE EXCEPTION 'an administration starts as recorded'; END IF;
  IF NEW.administered_at > clock_timestamp() THEN RAISE EXCEPTION 'an administration cannot be in the future'; END IF;
  SELECT * INTO o FROM medication_orders WHERE id = NEW.order_id;
  IF o.patient_id IS DISTINCT FROM NEW.patient_id THEN RAISE EXCEPTION 'the order is not an order of this patient'; END IF;
  IF o.status = 'entered_in_error' THEN RAISE EXCEPTION 'an order entered in error takes no administrations'; END IF;
  IF NEW.administered_at < o.ordered_at THEN RAISE EXCEPTION 'an administration cannot be before the order was made'; END IF;
  IF o.status IN ('stopped','changed') AND NEW.administered_at >= o.ended_at THEN RAISE EXCEPTION 'the order had already ended'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER medication_administrations_insert_guard BEFORE INSERT ON medication_administrations FOR EACH ROW EXECUTE FUNCTION medication_administration_insert_guard();

-- Only one move changes a row: recorded -> entered_in_error (final). What was recorded, and who and when, never changes.
CREATE FUNCTION medication_administration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.administered_at IS DISTINCT FROM OLD.administered_at OR NEW.dose_text IS DISTINCT FROM OLD.dose_text OR NEW.reason_text IS DISTINCT FROM OLD.reason_text
     OR NEW.note_text IS DISTINCT FROM OLD.note_text OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'what was recorded, and who and when, cannot be changed';
  END IF;
  IF OLD.status = 'entered_in_error' THEN RAISE EXCEPTION 'an administration entered in error is final'; END IF;
  IF NEW.status <> 'entered_in_error' THEN RAISE EXCEPTION 'an administration can only move to entered in error'; END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER medication_administrations_guard BEFORE UPDATE ON medication_administrations FOR EACH ROW EXECUTE FUNCTION medication_administration_guard();

CREATE TABLE medication_administration_events (
  id              serial PRIMARY KEY,
  administration_id integer NOT NULL REFERENCES medication_administrations(id),
  seq             integer NOT NULL CHECK (seq >= 1),
  from_status     text CHECK (from_status IN ('recorded','entered_in_error')),
  to_status       text NOT NULL CHECK (to_status IN ('recorded','entered_in_error')),
  reason          text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
  by_user         integer NOT NULL REFERENCES users(id),                       -- from the session
  at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (administration_id, seq),
  CHECK ((seq = 1 AND from_status IS NULL AND to_status = 'recorded') OR (seq > 1 AND from_status IS NOT NULL AND to_status = 'entered_in_error' AND reason IS NOT NULL))
);
CREATE FUNCTION medication_administration_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM medication_administration_events WHERE administration_id = NEW.administration_id;
  IF NEW.seq <> n + 1 THEN RAISE EXCEPTION 'administration events are numbered one after the other'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER medication_administration_events_guard BEFORE INSERT ON medication_administration_events FOR EACH ROW EXECUTE FUNCTION medication_administration_event_guard();

CREATE TRIGGER medication_administrations_no_delete   BEFORE DELETE   ON medication_administrations FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER medication_administrations_no_truncate BEFORE TRUNCATE ON medication_administrations FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER medication_administration_events_no_change   BEFORE UPDATE OR DELETE ON medication_administration_events FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER medication_administration_events_no_truncate BEFORE TRUNCATE         ON medication_administration_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT ON medication_administrations, medication_administration_events TO emr_app;
GRANT UPDATE (status, row_version, error_by, error_at, error_reason) ON medication_administrations TO emr_app;
GRANT USAGE ON SEQUENCE medication_administrations_id_seq, medication_administration_events_id_seq TO emr_app;
