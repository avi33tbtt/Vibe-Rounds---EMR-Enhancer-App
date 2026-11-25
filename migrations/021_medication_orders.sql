-- Task R4b: (1) a "drug" category for local terms; (2) medication ORDERS on the server.
-- An order is written by a clinician. Name, dose, route and frequency are free text as typed (never suggested, never checked against anything).
-- The name may instead come from a PUBLISHED local term of category "drug" (names only; the term's display is copied into the order).
-- Nothing is deleted. An order is stopped, changed (a NEW order replaces it, with a reason) or marked entered in error. Every move is kept in medication_order_events.

ALTER TABLE local_terms DROP CONSTRAINT local_terms_category_check;
ALTER TABLE local_terms ADD CONSTRAINT local_terms_category_check CHECK (category IN ('finding','condition','test','procedure','observation','drug','other'));

CREATE TABLE medication_orders (
  id               serial PRIMARY KEY,
  patient_id       integer NOT NULL REFERENCES patients(id),
  origin_case_id   integer,
  term_id          integer REFERENCES local_terms(id),                         -- null = free text, never treated as verified
  medication       text NOT NULL CHECK (length(btrim(medication)) BETWEEN 1 AND 200),
  dose_text        text NOT NULL CHECK (length(btrim(dose_text)) BETWEEN 1 AND 200),
  route_text       text NOT NULL CHECK (length(btrim(route_text)) BETWEEN 1 AND 200),
  frequency_text   text NOT NULL CHECK (length(btrim(frequency_text)) BETWEEN 1 AND 200),
  indication_text  text CHECK (indication_text IS NULL OR length(btrim(indication_text)) BETWEEN 1 AND 500),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','changed','entered_in_error')),
  replaces_order_id integer UNIQUE REFERENCES medication_orders(id),           -- set on the new order of a change
  row_version      integer NOT NULL DEFAULT 1,
  ordered_by       integer NOT NULL REFERENCES users(id),                      -- from the session
  ordered_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_by         integer REFERENCES users(id),                               -- stopped or changed
  ended_at         timestamptz,
  end_reason       text CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 1 AND 1000),
  error_by         integer REFERENCES users(id),
  error_at         timestamptz,
  error_reason     text CHECK (error_reason IS NULL OR length(btrim(error_reason)) BETWEEN 1 AND 1000),
  FOREIGN KEY (origin_case_id, patient_id) REFERENCES clinical_cases (id, patient_id),
  CHECK (status <> 'active' OR (ended_by IS NULL AND ended_at IS NULL AND end_reason IS NULL AND error_by IS NULL AND error_at IS NULL AND error_reason IS NULL)),
  CHECK (status NOT IN ('stopped','changed') OR (ended_by IS NOT NULL AND ended_at IS NOT NULL AND end_reason IS NOT NULL AND error_by IS NULL AND error_at IS NULL AND error_reason IS NULL)),
  CHECK (status <> 'entered_in_error' OR (error_by IS NOT NULL AND error_at IS NOT NULL AND error_reason IS NOT NULL))
);
CREATE INDEX medication_orders_patient_idx ON medication_orders (patient_id, id);

-- A new order: starts active; a term must be published, of category drug, and the name must be the term's display; a replacement must replace an order of the same patient that is already marked changed.
CREATE FUNCTION medication_order_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record; o record;
BEGIN
  IF NEW.status <> 'active' OR NEW.row_version <> 1 THEN RAISE EXCEPTION 'an order starts as active'; END IF;
  IF NEW.term_id IS NOT NULL THEN
    SELECT status, category, display INTO t FROM local_terms WHERE id = NEW.term_id;
    IF t.status IS DISTINCT FROM 'published' OR t.category IS DISTINCT FROM 'drug' THEN RAISE EXCEPTION 'an order can only name a published local drug term'; END IF;
    IF NEW.medication IS DISTINCT FROM t.display THEN RAISE EXCEPTION 'the medication must be the display of its local term'; END IF;
  END IF;
  IF NEW.replaces_order_id IS NOT NULL THEN
    SELECT patient_id, status INTO o FROM medication_orders WHERE id = NEW.replaces_order_id;
    IF o.patient_id IS DISTINCT FROM NEW.patient_id OR o.status IS DISTINCT FROM 'changed' THEN RAISE EXCEPTION 'a replacement must replace a changed order of the same patient'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER medication_orders_insert_guard BEFORE INSERT ON medication_orders FOR EACH ROW EXECUTE FUNCTION medication_order_insert_guard();

-- Only the status move changes a row: active -> stopped | changed | entered_in_error; stopped | changed -> entered_in_error. entered_in_error is final.
-- What was ordered, for whom and by whom never changes (a change is a NEW order).
CREATE FUNCTION medication_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.origin_case_id IS DISTINCT FROM OLD.origin_case_id
     OR NEW.term_id IS DISTINCT FROM OLD.term_id OR NEW.medication IS DISTINCT FROM OLD.medication OR NEW.dose_text IS DISTINCT FROM OLD.dose_text
     OR NEW.route_text IS DISTINCT FROM OLD.route_text OR NEW.frequency_text IS DISTINCT FROM OLD.frequency_text OR NEW.indication_text IS DISTINCT FROM OLD.indication_text
     OR NEW.replaces_order_id IS DISTINCT FROM OLD.replaces_order_id OR NEW.ordered_by IS DISTINCT FROM OLD.ordered_by OR NEW.ordered_at IS DISTINCT FROM OLD.ordered_at THEN
    RAISE EXCEPTION 'what was ordered, and who and when, cannot be changed';
  END IF;
  IF OLD.status = 'entered_in_error' THEN RAISE EXCEPTION 'an order entered in error is final'; END IF;
  IF NOT ((OLD.status = 'active' AND NEW.status IN ('stopped','changed','entered_in_error')) OR (OLD.status IN ('stopped','changed') AND NEW.status = 'entered_in_error')) THEN
    RAISE EXCEPTION 'an order cannot move from % to %', OLD.status, NEW.status;
  END IF;
  IF OLD.status IN ('stopped','changed') AND (NEW.ended_by IS DISTINCT FROM OLD.ended_by OR NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.end_reason IS DISTINCT FROM OLD.end_reason) THEN
    RAISE EXCEPTION 'the ending stays as it was recorded';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER medication_orders_guard BEFORE UPDATE ON medication_orders FOR EACH ROW EXECUTE FUNCTION medication_order_guard();

/* ---------- medication_order_events: append-only history of every status move ---------- */
CREATE TABLE medication_order_events (
  id          serial PRIMARY KEY,
  order_id    integer NOT NULL REFERENCES medication_orders(id),
  seq         integer NOT NULL CHECK (seq >= 1),
  from_status text CHECK (from_status IN ('active','stopped','changed','entered_in_error')),
  to_status   text NOT NULL CHECK (to_status IN ('active','stopped','changed','entered_in_error')),
  reason      text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
  by_user     integer NOT NULL REFERENCES users(id),                           -- from the session
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (order_id, seq),
  CHECK ((seq = 1 AND from_status IS NULL AND to_status = 'active') OR (seq > 1 AND from_status IS NOT NULL AND to_status <> 'active' AND reason IS NOT NULL))
);

CREATE FUNCTION medication_order_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM medication_order_events WHERE order_id = NEW.order_id;
  IF NEW.seq <> n + 1 THEN RAISE EXCEPTION 'order events are numbered one after the other'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER medication_order_events_guard BEFORE INSERT ON medication_order_events FOR EACH ROW EXECUTE FUNCTION medication_order_event_guard();

/* ---------- no hard delete, no truncate, for anyone ---------- */
CREATE TRIGGER medication_orders_no_delete   BEFORE DELETE   ON medication_orders FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER medication_orders_no_truncate BEFORE TRUNCATE ON medication_orders FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER medication_order_events_no_change   BEFORE UPDATE OR DELETE ON medication_order_events FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER medication_order_events_no_truncate BEFORE TRUNCATE         ON medication_order_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

/* ---------- grants for emr_app: no DELETE, no TRUNCATE; UPDATE only on the status columns ---------- */
GRANT SELECT, INSERT ON medication_orders, medication_order_events TO emr_app;
GRANT UPDATE (status, row_version, ended_by, ended_at, end_reason, error_by, error_at, error_reason) ON medication_orders TO emr_app;
GRANT USAGE ON SEQUENCE medication_orders_id_seq, medication_order_events_id_seq TO emr_app;
