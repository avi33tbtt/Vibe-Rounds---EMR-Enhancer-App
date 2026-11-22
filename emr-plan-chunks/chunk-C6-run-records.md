# Chunk C6-run-records: Immutable run records and API

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Needs: C5c, B5._

**Core rules:** attach `01-core.md` too.

**Read only:** `app.js` pattern; `permissions.js`; `test/safety-routes.test.js`; `ccis-exec.js`.

**Build:**
1. Migration: `analytics_runs` (case_id, package id+version+checksum, engine version, schema version, input snapshot hash and snapshot, result json, trace json, run_by, run_at). Immutable by trigger; no DELETE/TRUNCATE; grants as above.
2. Routes in `ci.js`: `POST /api/ci/run` (case + package ref; permission `ci:run`), `GET /api/ci/runs/:id`, list by case (`ci:read`). Actor from session; audit count only.
3. Update the permission matrix and audit scenarios in `test/safety-routes.test.js` on purpose; a new route fails the build until you do.
4. Tests: result reproducible from the stored snapshot; stored run cannot be altered; unauthorised role refused.

**Done when:** a run is stored immutably with every artefact and engine version.

**Size guard:** 1 migration, 1 routes file, tests.
