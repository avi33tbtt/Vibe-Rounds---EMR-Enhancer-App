-- Task B1a: persistent cases. A case belongs to ONE patient and can span several encounters (case_encounters).
-- Clinical data is never hard-deleted: cases are archived, links and narrative entries are append-only.

-- Lets a link row prove, in the database, that the encounter and the case belong to the same patient.
ALTER TABLE encounters ADD CONSTRAINT encounters_id_patient_uq UNIQUE (id, patient_id);

CREATE TABLE clinical_cases (
  id          serial PRIMARY KEY,
  patient_id  integer NOT NULL REFERENCES patients(id),
  case_key    text GENERATED ALWAYS AS ('CASE-' || lpad(id::text, 6, '0')) STORED,
  title       text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','closed','archived')),
  opened_at   timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  archived_at timestamptz,
  archived_by integer REFERENCES users(id),
  created_by  integer NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  UNIQUE (case_key),
  UNIQUE (id, patient_id)
);
CREATE INDEX clinical_cases_patient_idx ON clinical_cases (patient_id, id);

CREATE TABLE case_encounters (
  id            serial PRIMARY KEY,
  case_id       integer NOT NULL,
  encounter_id  integer NOT NULL,
  patient_id    integer NOT NULL,
  relation_type text NOT NULL DEFAULT 'related' CHECK (relation_type IN ('opened','reviewed','follow_up','related')),
  linked_at     timestamptz NOT NULL DEFAULT now(),
  linked_by     integer NOT NULL REFERENCES users(id),
  UNIQUE (case_id, encounter_id),
  FOREIGN KEY (case_id, patient_id)      REFERENCES clinical_cases (id, patient_id),
  FOREIGN KEY (encounter_id, patient_id) REFERENCES encounters (id, patient_id)
);

CREATE TABLE case_narrative_entries (
  id         serial PRIMARY KEY,
  case_id    integer NOT NULL REFERENCES clinical_cases(id),
  body       text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  author_id  integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_narrative_case_idx ON case_narrative_entries (case_id, id DESC);

-- No hard delete, no truncate, for anyone. Links and narrative entries also refuse UPDATE (append-only).
CREATE TRIGGER clinical_cases_no_delete   BEFORE DELETE   ON clinical_cases         FOR EACH ROW       EXECUTE FUNCTION forbid_change();
CREATE TRIGGER clinical_cases_no_truncate BEFORE TRUNCATE ON clinical_cases         FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_encounters_no_change  BEFORE UPDATE OR DELETE ON case_encounters FOR EACH ROW     EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_encounters_no_truncate BEFORE TRUNCATE ON case_encounters       FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_narrative_no_change   BEFORE UPDATE OR DELETE ON case_narrative_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER case_narrative_no_truncate BEFORE TRUNCATE ON case_narrative_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Grants for emr_app: exactly what cases.js uses. No DELETE, no TRUNCATE.
-- UPDATE on clinical_cases is limited to the columns a case edit changes: patient_id, created_by and created_at cannot be rewritten.
GRANT SELECT, INSERT ON clinical_cases, case_encounters, case_narrative_entries TO emr_app;
GRANT UPDATE (title, status, closed_at, archived_at, archived_by, updated_at, row_version) ON clinical_cases TO emr_app;
GRANT USAGE ON SEQUENCE clinical_cases_id_seq, case_encounters_id_seq, case_narrative_entries_id_seq TO emr_app;
