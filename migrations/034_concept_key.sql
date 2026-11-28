-- Task D3: the shared meaning of a recorded value (ED-9, ED-78).
-- concept_key is a plain key in the implicit `local` code system, copied at write time from the pinned element field.
-- Existing rows stay NULL: observation_guard (011) forbids changing any column but status and error_*, so there is no back-fill.
-- The column is immutable like every other: the guard compares the whole row. emr_app already has table-level INSERT; no grant change.
ALTER TABLE observations ADD COLUMN concept_key text
  CHECK (concept_key IS NULL OR concept_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$');
CREATE INDEX observations_concept_idx ON observations (case_id, concept_key, effective_at, id) WHERE concept_key IS NOT NULL;
