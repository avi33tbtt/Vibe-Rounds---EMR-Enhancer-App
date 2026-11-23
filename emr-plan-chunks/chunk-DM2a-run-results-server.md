# Chunk DM2a-run-results-server: Import and acknowledge CCIS run records

_Needs: B5b. Uses CCIS row 1.4a schemas (done)._ **Core rules:** attach `01-core.md`.
**Read only:** `permissions.js`; `audit.js`; `test/safety-routes.test.js`; `contracts/` (add `run-record.schema.json` and `run-result.schema.json` from the CCIS repo); one CCIS fixture expected file.

**Build:**
1. Migration: `ccis_runs` (case_id, run_record jsonb, run_record_sha256, envelope_sha256, imported_by, imported_at) and `ccis_run_acks` (run_id, acknowledged_by, acknowledged_at, note). Both append-only, immutable, grants without UPDATE/DELETE/TRUNCATE.
2. Permissions: `ccis:import` (admin, doctor), `ccis:read` (admin, doctor, nurse, viewer), `ccis:ack` (admin, doctor).
3. Routes: `POST /api/cases/:id/ccis-runs` (body is a run record; validate against the vendored schema; reject unless its context hash equals a hash in `context_exports` for this case; importer from session), `GET /api/cases/:id/ccis-runs`, `POST /api/ccis-runs/:id/ack`.
4. A run record never modifies observations, notes or sets. Test that clinical tables are unchanged after import.
5. Update the permission matrix and audit scenarios on purpose.

**Done when:** a fixture run record imports only against a matching exported envelope; ack is recorded with the session user.
**Size guard:** 1 migration, 3 routes, tests. Page work is DM2b.
