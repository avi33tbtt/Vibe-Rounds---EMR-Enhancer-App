-- Task R6f-2a: staging of FHIR Bundle imports on the server. A staged bundle is a list of PROPOSALS for a person to look at; nothing here is a clinical record.
-- Stored: the bundle hash, the audit counts and the parser's own proposals (label, value, dates, blockers, warnings). NEVER the raw bundle, names, notes or identifiers.
-- No patient is chosen here: the person picks the chart when a later step accepts one proposal (R6f-2b, R6f-2c).
-- Nothing is deleted. A proposal moves staged -> rejected (with a reason) or staged -> accepted (only a READY proposal that is not a MedicationRequest). Both are final.

CREATE TABLE import_bundles (
  id           serial PRIMARY KEY,
  bundle_hash  text NOT NULL UNIQUE CHECK (bundle_hash ~ '^[0-9a-f]{64}$'),               -- sha256 of the canonical bundle; the same bundle is staged once
  bundle_type  text NOT NULL CHECK (bundle_type IN ('transaction','collection')),
  summary      jsonb NOT NULL,                                                           -- counts only (entries, proposals, ready, blocked, rejected, skippedInError, patients, codingsDropped, notesDropped, byType)
  warnings     jsonb NOT NULL DEFAULT '[]'::jsonb,                                       -- the parser's own warning sentences
  rejected     jsonb NOT NULL DEFAULT '[]'::jsonb,                                       -- entries the parser did not read: index and reason
  staged_by    integer NOT NULL REFERENCES users(id),                                    -- from the session
  staged_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(summary) = 'object' AND jsonb_typeof(warnings) = 'array' AND jsonb_typeof(rejected) = 'array')
);

CREATE TABLE import_proposals (
  id               serial PRIMARY KEY,
  bundle_id        integer NOT NULL REFERENCES import_bundles(id),
  key              text NOT NULL CHECK (length(key) BETWEEN 3 AND 60),                   -- e.g. Observation#3 (kind and entry index)
  kind             text NOT NULL CHECK (kind IN ('Observation','Condition','AllergyIntolerance','MedicationRequest')),
  entry_index      integer NOT NULL CHECK (entry_index >= 0),
  fields           jsonb NOT NULL,                                                       -- proposal fields as the parser made them
  blockers         jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings         jsonb NOT NULL DEFAULT '[]'::jsonb,
  ready            boolean NOT NULL,
  source_status    text CHECK (source_status IS NULL OR length(source_status) <= 60),
  starts_as        text CHECK (starts_as IS NULL OR starts_as IN ('preliminary','active','none')),
  status           text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','rejected','accepted')),
  row_version      integer NOT NULL DEFAULT 1,
  rejected_by      integer REFERENCES users(id),
  rejected_at      timestamptz,
  reject_reason    text CHECK (reject_reason IS NULL OR length(btrim(reject_reason)) BETWEEN 1 AND 1000),
  accepted_by      integer REFERENCES users(id),                                         -- set by R6f-2b and R6f-2c, from the session
  accepted_at      timestamptz,
  accepted_patient_id integer REFERENCES patients(id),                                   -- the chart a person chose
  accepted_record_type text CHECK (accepted_record_type IS NULL OR accepted_record_type IN ('observation','problem','allergy')),
  accepted_record_id   integer,
  UNIQUE (bundle_id, key),
  CHECK (jsonb_typeof(fields) = 'object' AND jsonb_typeof(blockers) = 'array' AND jsonb_typeof(warnings) = 'array'),
  CHECK (ready = (jsonb_array_length(blockers) = 0)),
  CHECK (kind <> 'MedicationRequest' OR ready = false),                                  -- an imported bundle never creates an order
  CHECK (status <> 'staged' OR (rejected_by IS NULL AND rejected_at IS NULL AND reject_reason IS NULL AND accepted_by IS NULL AND accepted_at IS NULL AND accepted_patient_id IS NULL AND accepted_record_type IS NULL AND accepted_record_id IS NULL)),
  CHECK (status <> 'rejected' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND reject_reason IS NOT NULL AND accepted_by IS NULL AND accepted_at IS NULL AND accepted_patient_id IS NULL AND accepted_record_type IS NULL AND accepted_record_id IS NULL)),
  CHECK (status <> 'accepted' OR (ready AND kind <> 'MedicationRequest' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND accepted_patient_id IS NOT NULL AND accepted_record_type IS NOT NULL AND accepted_record_id IS NOT NULL AND rejected_by IS NULL AND rejected_at IS NULL AND reject_reason IS NULL))
);
CREATE INDEX import_proposals_bundle_idx ON import_proposals (bundle_id, id);

CREATE FUNCTION import_proposal_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'staged' OR NEW.row_version <> 1 THEN RAISE EXCEPTION 'a proposal starts as staged'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_proposals_insert_guard BEFORE INSERT ON import_proposals FOR EACH ROW EXECUTE FUNCTION import_proposal_insert_guard();

-- Only the status move changes a row: staged -> rejected | accepted. Both are final. What was staged never changes.
CREATE FUNCTION import_proposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.bundle_id IS DISTINCT FROM OLD.bundle_id OR NEW.key IS DISTINCT FROM OLD.key OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.entry_index IS DISTINCT FROM OLD.entry_index OR NEW.fields IS DISTINCT FROM OLD.fields OR NEW.blockers IS DISTINCT FROM OLD.blockers
     OR NEW.warnings IS DISTINCT FROM OLD.warnings OR NEW.ready IS DISTINCT FROM OLD.ready OR NEW.source_status IS DISTINCT FROM OLD.source_status
     OR NEW.starts_as IS DISTINCT FROM OLD.starts_as THEN
    RAISE EXCEPTION 'what was staged cannot be changed';
  END IF;
  IF OLD.status <> 'staged' THEN RAISE EXCEPTION 'a proposal that was % is final', OLD.status; END IF;
  IF NEW.status NOT IN ('rejected','accepted') THEN RAISE EXCEPTION 'a staged proposal is rejected or accepted'; END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN RAISE EXCEPTION 'row_version must advance by one'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_proposals_guard BEFORE UPDATE ON import_proposals FOR EACH ROW EXECUTE FUNCTION import_proposal_guard();

CREATE TRIGGER import_bundles_no_change     BEFORE UPDATE OR DELETE ON import_bundles   FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER import_bundles_no_truncate   BEFORE TRUNCATE         ON import_bundles   FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER import_proposals_no_delete   BEFORE DELETE           ON import_proposals FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER import_proposals_no_truncate BEFORE TRUNCATE         ON import_proposals FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

GRANT SELECT, INSERT ON import_bundles, import_proposals TO emr_app;
GRANT UPDATE (status, row_version, rejected_by, rejected_at, reject_reason, accepted_by, accepted_at, accepted_patient_id, accepted_record_type, accepted_record_id) ON import_proposals TO emr_app;
GRANT USAGE ON SEQUENCE import_bundles_id_seq, import_proposals_id_seq TO emr_app;
