-- Task R4g-1: acknowledgement of abnormal results. A person (doctor or admin) explicitly acknowledges that they have seen a result whose flag was typed as "abnormal".
-- Append-only, one acknowledgement per result; a corrected result is a NEW result and needs its own acknowledgement. Nothing computes or decides what is abnormal.

CREATE TABLE investigation_result_acks (
  id              serial PRIMARY KEY,
  result_id       integer NOT NULL UNIQUE REFERENCES investigation_results(id),
  patient_id      integer NOT NULL REFERENCES patients(id),
  note            text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  acknowledged_by integer NOT NULL REFERENCES users(id),                  -- from the session
  acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX investigation_result_acks_patient_idx ON investigation_result_acks (patient_id, id);

CREATE FUNCTION investigation_result_ack_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  SELECT patient_id, flag, EXISTS (SELECT 1 FROM investigation_results n WHERE n.replaces_result_id = NEW.result_id) AS replaced INTO r FROM investigation_results WHERE id = NEW.result_id;
  IF r.patient_id IS DISTINCT FROM NEW.patient_id THEN RAISE EXCEPTION 'that result is not of this patient'; END IF;
  IF r.flag IS DISTINCT FROM 'abnormal' THEN RAISE EXCEPTION 'only a result flagged abnormal is acknowledged'; END IF;
  IF r.replaced THEN RAISE EXCEPTION 'a replaced result is not acknowledged; acknowledge the newest result'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER investigation_result_acks_guard BEFORE INSERT ON investigation_result_acks FOR EACH ROW EXECUTE FUNCTION investigation_result_ack_guard();
CREATE TRIGGER investigation_result_acks_no_change   BEFORE UPDATE OR DELETE ON investigation_result_acks FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER investigation_result_acks_no_truncate BEFORE TRUNCATE         ON investigation_result_acks FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT ON investigation_result_acks TO emr_app;
GRANT USAGE ON SEQUENCE investigation_result_acks_id_seq TO emr_app;
