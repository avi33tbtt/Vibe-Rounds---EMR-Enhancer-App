-- 003_audit_grants.sql  (chunk 33a)
-- The application connects as emr_app. It can read and write the working tables, but on audit_log and review_events it can only INSERT and SELECT,
-- so even a bug or a stolen app credential cannot edit or erase the trail. (The append-only trigger in 001_core.sql is a second, independent guard.)
--
-- HOW THE SERVER USES IT
--   Migrations run as the database OWNER (DATABASE_URL), which keeps full rights. The running server connects as emr_app (APP_DATABASE_URL).
--   The role is created NOLOGIN so no default password exists anywhere. Once, as a database admin, give it a login and a password you generate:
--       ALTER ROLE emr_app LOGIN PASSWORD '<long random value>';
--   then set APP_DATABASE_URL=postgres://emr_app:<that password>@host:5432/dbname in the server's environment (see .env.example).
--   If APP_DATABASE_URL is not set the server falls back to DATABASE_URL (owner rights): fine for local development only, NOT for production.
--
-- RULE FOR EVERY LATER MIGRATION: a new table gets no rights for emr_app until its own migration grants them, which is deliberate (fail closed).
-- Add the GRANT for it in that migration, and never grant UPDATE, DELETE or TRUNCATE on an append-only table.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN
    CREATE ROLE emr_app NOLOGIN;
  END IF;
EXCEPTION WHEN OTHERS THEN                       -- two databases migrating at once can race to create the (cluster-wide) role: fine if it exists now
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN RAISE; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO emr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO emr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO emr_app;

-- the append-only tables and the migration bookkeeping: take everything back, then give back only what is allowed
REVOKE ALL ON audit_log, review_events, schema_migrations FROM emr_app;
GRANT SELECT, INSERT ON audit_log, review_events TO emr_app;
