-- Chunk 06c: restricted database role for the running server.
-- Migrations run as the owner connection (MIGRATE_DATABASE_URL); the server runs as emr_app,
-- which owns nothing, so it cannot DROP or ALTER anything, and has no DELETE or TRUNCATE on clinical tables.
-- The role is created without a login. An operator gives it one outside git:
--   ALTER ROLE emr_app LOGIN PASSWORD '...';   (see README)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    CREATE ROLE emr_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;

-- No DDL: nothing may be created in the schema by PUBLIC or the app role.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM emr_app;
GRANT USAGE ON SCHEMA public TO emr_app;

-- Start from nothing, then grant exactly what the app code uses.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM emr_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM emr_app;

GRANT SELECT                         ON users        TO emr_app;  -- accounts are created by the seed script (owner), not the app
GRANT SELECT, INSERT, DELETE         ON sessions     TO emr_app;  -- sign-in and sign-out; sessions are not clinical data
GRANT SELECT, INSERT                 ON audit_log    TO emr_app;  -- append-only
GRANT SELECT, INSERT, UPDATE         ON patients     TO emr_app;  -- archive and restore are UPDATEs
GRANT SELECT, INSERT, UPDATE         ON encounters   TO emr_app;  -- close is an UPDATE
GRANT SELECT, UPDATE                 ON ai_settings  TO emr_app;  -- the single settings row
GRANT USAGE ON SEQUENCE audit_log_id_seq, patients_id_seq, encounters_id_seq TO emr_app;
-- schema_migrations is deliberately not granted: only the owner connection migrates.

-- TRUNCATE is refused for everyone, owners included (the privilege revoke above only covers emr_app).
CREATE TRIGGER patients_no_truncate   BEFORE TRUNCATE ON patients   FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER encounters_no_truncate BEFORE TRUNCATE ON encounters FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
