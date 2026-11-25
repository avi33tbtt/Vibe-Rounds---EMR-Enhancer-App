-- Task R4f: specimens and results for investigation orders (R4e). Append-only: a row is never changed or deleted.
-- A result is typed as reported (value, unit, reference range as text; the flag normal/abnormal is chosen by the person, never computed here).
-- A mistake is corrected by a NEW result that replaces the old one (with a reason); the old row stays. Specimens and results are accepted only while the order is active.

CREATE TABLE investigation_specimens (
  id            serial PRIMARY KEY,
  order_id      integer NOT NULL REFERENCES investigation_orders(id),
  patient_id    integer NOT NULL REFERENCES patients(id),
  specimen_type text NOT NULL CHECK (length(btrim(specimen_type)) BETWEEN 1 AND 200),
  collected_at  timestamptz NOT NULL,
  recorded_by   integer NOT NULL REFERENCES users(id),                -- from the session
  recorded_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, order_id)
);
CREATE INDEX investigation_specimens_order_idx ON investigation_specimens (order_id, id);

CREATE TABLE investigation_results (
  id                  serial PRIMARY KEY,
  order_id            integer NOT NULL REFERENCES investigation_orders(id),
  patient_id          integer NOT NULL REFERENCES patients(id),
  specimen_id         integer,
  value_text          text NOT NULL CHECK (length(btrim(value_text)) BETWEEN 1 AND 500),
  unit_text           text CHECK (unit_text IS NULL OR length(btrim(unit_text)) BETWEEN 1 AND 100),
  reference_text      text CHECK (reference_text IS NULL OR length(btrim(reference_text)) BETWEEN 1 AND 200),
  flag                text NOT NULL DEFAULT 'not_stated' CHECK (flag IN ('not_stated','normal','abnormal')),   -- chosen by the person who enters it
  replaces_result_id  integer UNIQUE REFERENCES investigation_results(id),                                    -- set on a correction; one correction per result
  correction_reason   text CHECK (correction_reason IS NULL OR length(btrim(correction_reason)) BETWEEN 1 AND 1000),
  recorded_by         integer NOT NULL REFERENCES users(id),          -- from the session
  recorded_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (specimen_id, order_id) REFERENCES investigation_specimens (id, order_id),
  CHECK ((replaces_result_id IS NULL) = (correction_reason IS NULL))
);
CREATE INDEX investigation_results_order_idx ON investigation_results (order_id, id);

CREATE FUNCTION investigation_specimen_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o record;
BEGIN
  SELECT patient_id, status INTO o FROM investigation_orders WHERE id = NEW.order_id;
  IF o.patient_id IS DISTINCT FROM NEW.patient_id THEN RAISE EXCEPTION 'that order is not of this patient'; END IF;
  IF o.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'a specimen can only be recorded for an active order'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER investigation_specimens_guard BEFORE INSERT ON investigation_specimens FOR EACH ROW EXECUTE FUNCTION investigation_specimen_guard();

CREATE FUNCTION investigation_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o record; r record;
BEGIN
  SELECT patient_id, status INTO o FROM investigation_orders WHERE id = NEW.order_id;
  IF o.patient_id IS DISTINCT FROM NEW.patient_id THEN RAISE EXCEPTION 'that order is not of this patient'; END IF;
  IF o.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'a result can only be recorded for an active order'; END IF;
  IF NEW.replaces_result_id IS NOT NULL THEN
    SELECT order_id INTO r FROM investigation_results WHERE id = NEW.replaces_result_id;
    IF r.order_id IS DISTINCT FROM NEW.order_id THEN RAISE EXCEPTION 'a correction must replace a result of the same order'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER investigation_results_guard BEFORE INSERT ON investigation_results FOR EACH ROW EXECUTE FUNCTION investigation_result_guard();

CREATE TRIGGER investigation_specimens_no_change   BEFORE UPDATE OR DELETE ON investigation_specimens FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER investigation_specimens_no_truncate BEFORE TRUNCATE         ON investigation_specimens FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER investigation_results_no_change   BEFORE UPDATE OR DELETE ON investigation_results FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER investigation_results_no_truncate BEFORE TRUNCATE         ON investigation_results FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT ON investigation_specimens, investigation_results TO emr_app;
GRANT USAGE ON SEQUENCE investigation_specimens_id_seq, investigation_results_id_seq TO emr_app;
