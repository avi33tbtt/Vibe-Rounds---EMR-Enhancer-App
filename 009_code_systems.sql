-- 009_code_systems.sql (Phase P, P1a): the list of code systems a field may use.
-- verified_codes.system had no CHECK, only text, so nothing is dropped; a foreign key is added instead.
-- No codes are added. Only the two systems the app already accepts are seeded, so existing and test rows keep working.
CREATE TABLE code_systems (
  id           text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_.-]{0,39}$'),
  uri          text NOT NULL UNIQUE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind         text NOT NULL CHECK (kind IN ('standard','local')),
  licence_note text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO code_systems (id, uri, name, kind) VALUES
  ('snomed', 'http://snomed.info/sct', 'SNOMED CT', 'standard'),
  ('loinc',  'http://loinc.org',       'LOINC',     'standard');

-- any other system already present in an upgraded database is kept as a local system, so the foreign key cannot fail
INSERT INTO code_systems (id, uri, name, kind)
  SELECT DISTINCT system, 'urn:local:' || system, system, 'local' FROM verified_codes
  WHERE system NOT IN (SELECT id FROM code_systems);

ALTER TABLE verified_codes
  ADD CONSTRAINT verified_codes_system_fk FOREIGN KEY (system) REFERENCES code_systems(id);

GRANT SELECT, INSERT, UPDATE, DELETE ON code_systems TO emr_app;
