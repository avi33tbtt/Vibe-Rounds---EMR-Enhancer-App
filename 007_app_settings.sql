-- 007_app_settings.sql (chunk 36a): small server-wide settings, starting with the AI switch.
-- A missing 'ai' row means AI is OFF. Only an admin changes it (PUT /admin/ai), and every change is audited.
-- The AI key is never stored here: it lives in the server environment only (LLM_API_KEY).
CREATE TABLE app_settings (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{0,59}$'),
  value       jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- app role (003_audit_grants.sql): a new table gets no rights until its own migration grants them
REVOKE ALL ON app_settings FROM emr_app;
GRANT SELECT, INSERT, UPDATE ON app_settings TO emr_app;
