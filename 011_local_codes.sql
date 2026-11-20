-- P4a: local code lists. A local code system is a row of code_systems with kind 'local'. Its codes are typed in here and are NOT in verified_codes
-- until a person verifies them (POST /code-systems/:id/codes/:code/verify). No content is pre-filled.
ALTER TABLE code_systems ADD CONSTRAINT code_systems_id_kind_key UNIQUE (id, kind);

CREATE TABLE IF NOT EXISTS local_codes (
  system_id  text NOT NULL,
  kind       text NOT NULL DEFAULT 'local' CHECK (kind = 'local'),
  code       text NOT NULL,
  display    text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system_id, code),
  FOREIGN KEY (system_id, kind) REFERENCES code_systems (id, kind)
);
GRANT SELECT, INSERT ON local_codes TO emr_app;
