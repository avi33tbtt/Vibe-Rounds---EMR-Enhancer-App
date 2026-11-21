-- Patient registration and encounters. Clinical data is never hard-deleted:
-- patients are archived, encounters are closed.
CREATE TABLE patients (
  id          serial PRIMARY KEY,
  mrn         text NOT NULL,
  name        text NOT NULL,
  dob         date NOT NULL,
  sex         text NOT NULL CHECK (sex IN ('M','F','O','U')),
  archived    boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  archived_by integer REFERENCES users(id),
  created_by  integer NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX patients_mrn_uq ON patients (lower(mrn));
CREATE INDEX patients_dupe_idx ON patients (lower(btrim(name)), dob);

CREATE TABLE encounters (
  id         serial PRIMARY KEY,
  patient_id integer NOT NULL REFERENCES patients(id),
  bed        text NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by  integer NOT NULL REFERENCES users(id),
  opened_at  timestamptz NOT NULL DEFAULT now(),
  closed_by  integer REFERENCES users(id),
  closed_at  timestamptz
);
-- One open encounter per bed, and one open encounter per patient.
CREATE UNIQUE INDEX encounters_open_bed_uq     ON encounters (lower(bed)) WHERE status = 'open';
CREATE UNIQUE INDEX encounters_open_patient_uq ON encounters (patient_id) WHERE status = 'open';

CREATE TRIGGER patients_no_delete   BEFORE DELETE ON patients   FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER encounters_no_delete BEFORE DELETE ON encounters FOR EACH ROW EXECUTE FUNCTION forbid_change();
