-- Task R4e: investigation orders on the server (a clinician asks for a test). Orders only: specimens and results come later (R4f).
-- The test name is free text as typed, or a PUBLISHED local term of category "test" (name only; its display is copied in). Free text is never treated as verified.
-- Nothing is deleted. An order is cancelled (with a reason) or marked entered in error (with a reason); every move is kept in investigation_order_events.

CREATE TABLE investigation_orders (
  id              serial PRIMARY KEY,
  patient_id      integer NOT NULL REFERENCES patients(id),
  origin_case_id  integer,
  term_id         integer REFERENCES local_terms(id),                          -- null = free text, never treated as verified
  test_name       text NOT NULL CHECK (length(btrim(test_name)) BETWEEN 1 AND 200),
  priority        text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent')),   -- chosen by the clinician; nothing decides it
  clinical_info   text CHECK (clinical_info IS NULL OR length(btrim(clinical_info)) BETWEEN 1 AND 500),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','entered_in_error')),
  row_version     integer NOT NULL DEFAULT 1,
  ordered_by      integer NOT NULL REFERENCES users(id),                       -- from the session
  ordered_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
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
CREATE INDEX investigation_orders_patient_idx ON investigation_orders (patient_id, id);

CREATE FUNCTION investigation_order_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  IF NEW.status <> 'active' OR NEW.row_version <> 1 THEN RAISE EXCEPTION 'an order starts as active'; END IF;
  IF NEW.term_id IS NOT NULL THEN
    SELECT status, category, display INTO t FROM local_terms WHERE id = NEW.term_id;
    IF t.status IS DISTINCT FROM 'published' OR t.category IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'an order can only name a published local test term'; END IF;
    IF NEW.test_name IS DISTINCT FROM t.display THEN RAISE EXCEPTION 'the test name must be the display of its local term'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER investigation_orders_insert_guard BEFORE INSERT ON investigation_orders FOR EACH ROW EXECUTE FUNCTION investigation_order_insert_guard();

-- Only the status move changes a row: active -> cancelled | entered_in_error; cancelled -> entered_in_error. entered_in_error is final.
CREATE FUNCTION investigation_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.origin_case_id IS DISTINCT FROM OLD.origin_case_id
     OR NEW.term_id IS DISTINCT FROM OLD.term_id OR NEW.test_name IS DISTINCT FROM OLD.test_name OR NEW.priority IS DISTINCT FROM OLD.priority
     OR NEW.clinical_info IS DISTINCT FROM OLD.clinical_info OR NEW.ordered_by IS DISTINCT FROM OLD.ordered_by OR NEW.ordered_at IS DISTINCT FROM OLD.ordered_at THEN
    RAISE EXCEPTION 'what was ordered, and who and when, cannot be changed';
  END IF;
  IF OLD.status = 'entered_in_error' THEN RAISE EXCEPTION 'an order entered in error is final'; END IF;
  IF NOT ((OLD.status = 'active' AND NEW.status IN ('cancelled','entered_in_error')) OR (OLD.status = 'cancelled' AND NEW.status = 'entered_in_error')) THEN
    RAISE EXCEPTION 'an order cannot move from % to %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'cancelled' AND (NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason) THEN
    RAISE EXCEPTION 'the cancellation stays as it was recorded';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER investigation_orders_guard BEFORE UPDATE ON investigation_orders FOR EACH ROW EXECUTE FUNCTION investigation_order_guard();

CREATE TABLE investigation_order_events (
  id          serial PRIMARY KEY,
  order_id    integer NOT NULL REFERENCES investigation_orders(id),
  seq         integer NOT NULL CHECK (seq >= 1),
  from_status text CHECK (from_status IN ('active','cancelled','entered_in_error')),
  to_status   text NOT NULL CHECK (to_status IN ('active','cancelled','entered_in_error')),
  reason      text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
  by_user     integer NOT NULL REFERENCES users(id),                           -- from the session
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (order_id, seq),
  CHECK ((seq = 1 AND from_status IS NULL AND to_status = 'active') OR (seq > 1 AND from_status IS NOT NULL AND to_status <> 'active' AND reason IS NOT NULL))
);
CREATE FUNCTION investigation_order_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM investigation_order_events WHERE order_id = NEW.order_id;
  IF NEW.seq <> n + 1 THEN RAISE EXCEPTION 'order events are numbered one after the other'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER investigation_order_events_guard BEFORE INSERT ON investigation_order_events FOR EACH ROW EXECUTE FUNCTION investigation_order_event_guard();

CREATE TRIGGER investigation_orders_no_delete   BEFORE DELETE   ON investigation_orders FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER investigation_orders_no_truncate BEFORE TRUNCATE ON investigation_orders FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER investigation_order_events_no_change   BEFORE UPDATE OR DELETE ON investigation_order_events FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER investigation_order_events_no_truncate BEFORE TRUNCATE         ON investigation_order_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT ON investigation_orders, investigation_order_events TO emr_app;
GRANT UPDATE (status, row_version, cancelled_by, cancelled_at, cancel_reason, error_by, error_at, error_reason) ON investigation_orders TO emr_app;
GRANT USAGE ON SEQUENCE investigation_orders_id_seq, investigation_order_events_id_seq TO emr_app;
