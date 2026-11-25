-- Task R4d-1: medication reconciliation records. A clinician looks at the recorded medication list (R3e) next to the active orders (R4b) and, for each
-- active history item, explicitly records one decision: continue (an active order covers it), stop, or not taken. No clinical checks are made here.
-- Append-only: a later decision for the same item is a new row (the latest one counts); nothing is changed or deleted. Who and when come from the session.

CREATE TABLE medication_reconciliations (
  id            serial PRIMARY KEY,
  patient_id    integer NOT NULL REFERENCES patients(id),
  medication_id integer NOT NULL REFERENCES patient_medications(id),
  order_id      integer REFERENCES medication_orders(id),
  decision      text NOT NULL CHECK (decision IN ('continue','stop','not_taken')),
  reason        text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  decided_by    integer NOT NULL REFERENCES users(id),                      -- from the session
  decided_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((decision = 'continue') = (order_id IS NOT NULL))                   -- continue needs the covering order; the others have none
);
CREATE INDEX medication_reconciliations_patient_idx ON medication_reconciliations (patient_id, medication_id, id);

CREATE FUNCTION medication_reconciliation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m record; o record;
BEGIN
  SELECT patient_id, status INTO m FROM patient_medications WHERE id = NEW.medication_id;
  IF m.patient_id IS DISTINCT FROM NEW.patient_id THEN RAISE EXCEPTION 'that medication is not of this patient'; END IF;
  IF m.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'only an active medication can be reconciled'; END IF;
  IF NEW.order_id IS NOT NULL THEN
    SELECT patient_id, status INTO o FROM medication_orders WHERE id = NEW.order_id;
    IF o.patient_id IS DISTINCT FROM NEW.patient_id OR o.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'the order must be an active order of this patient'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER medication_reconciliations_guard BEFORE INSERT ON medication_reconciliations FOR EACH ROW EXECUTE FUNCTION medication_reconciliation_guard();

CREATE TRIGGER medication_reconciliations_no_change   BEFORE UPDATE OR DELETE ON medication_reconciliations FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER medication_reconciliations_no_truncate BEFORE TRUNCATE         ON medication_reconciliations FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT ON medication_reconciliations TO emr_app;
GRANT USAGE ON SEQUENCE medication_reconciliations_id_seq TO emr_app;
