-- 005_patients.sql (chunk 34a): real patients and encounters.
-- 001_core.sql made the two tables minimal; nothing wrote to them until now. This migration adds what the server needs to register a patient safely:
--   * an MRN sequence (the server builds MRN = 7 digits from the sequence + a Luhn check digit; never typed by a person)
--   * merge pointers (a duplicate record is never deleted: merged_into points at the record that is kept)
--   * versions, so two people editing the same patient or encounter get a 409 instead of overwriting each other
--   * one open encounter per ward and bed, so a bed cannot be given to two patients at once
--   * no DELETE or TRUNCATE for anyone: patients and encounters are records, they are merged, closed or cancelled, never removed

CREATE SEQUENCE patient_mrn_seq AS integer START 1000000 MINVALUE 1000000 MAXVALUE 9999999 NO CYCLE;   -- running out is an error, never a reused number

ALTER TABLE patients
  ADD COLUMN merged_into uuid REFERENCES patients(id),
  ADD COLUMN merged_at   timestamptz,
  ADD COLUMN merged_by   uuid REFERENCES users(id),
  ADD COLUMN created_by  uuid REFERENCES users(id),
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN version     int NOT NULL DEFAULT 1 CHECK (version >= 1);

-- a merged record is inactive, says when and by whom, and cannot point at itself
ALTER TABLE patients ADD CONSTRAINT patients_merge_shape
  CHECK (merged_into IS NULL OR (merged_into <> id AND active = false AND merged_at IS NOT NULL AND merged_by IS NOT NULL));

-- duplicate check and search use exactly these expressions (patients.js NORM and DIGITS), so the indexes are used
CREATE INDEX patients_name_dob_ix ON patients (lower(regexp_replace(btrim(name), '\s+', ' ', 'g')), date_of_birth);
CREATE INDEX patients_phone_ix    ON patients (regexp_replace(phone, '\D', '', 'g')) WHERE phone IS NOT NULL;
CREATE INDEX patients_merged_ix   ON patients (merged_into) WHERE merged_into IS NOT NULL;

ALTER TABLE encounters
  ADD COLUMN version       int NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD COLUMN created_by    uuid REFERENCES users(id),
  ADD COLUMN cancel_reason text,
  ADD COLUMN updated_at    timestamptz NOT NULL DEFAULT now();

ALTER TABLE encounters ADD CONSTRAINT encounters_status_shape
  CHECK ((status = 'open' AND end_at IS NULL) OR (status = 'closed' AND end_at IS NOT NULL) OR (status = 'cancelled' AND cancel_reason IS NOT NULL));
ALTER TABLE encounters ADD CONSTRAINT encounters_bed_needs_ward CHECK (bed IS NULL OR ward IS NOT NULL);

-- one OPEN encounter per ward + bed (ignoring case and spaces at the ends); a closed or cancelled encounter frees the bed
CREATE UNIQUE INDEX encounters_open_bed_uq ON encounters (lower(btrim(ward)), lower(btrim(bed)))
  WHERE status = 'open' AND ward IS NOT NULL AND bed IS NOT NULL;

CREATE TRIGGER patients_no_delete   BEFORE DELETE OR TRUNCATE ON patients   FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER encounters_no_delete BEFORE DELETE OR TRUNCATE ON encounters FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- app role (003_audit_grants.sql): the new sequence needs USAGE; DELETE and TRUNCATE are taken back from the two tables
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO emr_app;
REVOKE DELETE, TRUNCATE ON patients, encounters FROM emr_app;
