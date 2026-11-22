# Chunk 06c: Restricted database role; no DELETE or TRUNCATE on clinical tables

_Part 2 of original chunk 06. Also closes known gap (c)._

**Core rules:** attach `01-core.md` too.

**Read only:** `migrations/*.sql` (list and skim 003), `docker-init/01-test-db.sql`, `db.js`, `migrate.js`, `env.txt`, `test/safety-data.test.js`, `test/safety-migrations.test.js`.

**Build:**
1. New migration (next free number; never edit applied ones) creating an app role with no DDL rights. Migrations run as a separate owner connection (for example `MIGRATE_DATABASE_URL`), the server runs as the app role.
2. On `patients`, `encounters`, `audit_log`: no DELETE and no TRUNCATE for the app role (revoke privileges and add a TRUNCATE trigger so it also holds for owners). Existing UPDATE needs (archive, close) must still work.
3. Turn the `test.todo` about TRUNCATE in `test/safety-data.test.js` into a real test. Add tests: as the app role, `DROP TABLE`, `ALTER TABLE`, `DELETE FROM patients`, `TRUNCATE patients` all fail.
4. Update README, `env.txt` and the CI workflow only as far as the new connection setting needs.

**Done when:** the app user cannot DROP or DELETE clinical rows; all 92 existing tests still pass.

**Size guard:** One migration, `db.js`/`migrate.js`/config, tests, README line. If CI or Render config needs more, list it for the user instead of doing it.

**Notes:** Risky for existing tests that connect to the DB; run the whole suite once.
