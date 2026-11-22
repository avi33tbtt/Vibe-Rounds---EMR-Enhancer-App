# Chunk B1a-cases-server: Persistent cases: migration, API, permissions (server)

_Ch5 slice B1, server half. Needs: B0 reviewed._

**Core rules:** attach `01-core.md` too.

**Read only:** `CLINICAL_CONTEXT_MODEL.md`; `app.js` (patients/encounters routes as the pattern); `permissions.js`; `audit.js`; `migrations/005_app_role.sql`; `test/helpers.js`; `test/safety-routes.test.js` (matrix).

**Build:**
1. One numbered migration: `clinical_cases` (patient_id required, case_key, title, status active|resolved|closed|archived, opened_at, closed_at, created_by, created_at, updated_at, row_version) and `case_encounters` (case_id, encounter_id, relation_type opened|reviewed|follow_up|related, linked_at, linked_by, UNIQUE). Narrative stored as append-only `case_narrative_entries` (author from session). No hard delete; `forbid_change()` triggers. In the same migration grant `emr_app` only what the code uses (no DELETE/TRUNCATE; add `forbid_change()` triggers on clinical tables); the grants test must still pass.
2. Routes in a new file (`cases.js`, not `app.js`): create, list by patient, read, update title/status with `row_version` (409 on conflict), archive/restore, link encounter. New permissions `cases:read`, `cases:write` (roles as for patients/encounters). Author/actor only from the session; body keys that try to set them are rejected. Every write audited in the same transaction.
3. Update the permission matrix and audit scenarios in `test/safety-routes.test.js` on purpose; a new route fails the build until you do.
4. Tests: case cannot reference a missing patient; one case links to two encounters; stale `row_version` gives 409; archive not delete; forged `created_by` rejected; audit row present; emr_app cannot DELETE/TRUNCATE.

**Done when:** API tests pass; matrix and audit coverage tests include the new routes.

**Size guard:** 1 migration, 1 routes file, permissions, tests. No page changes (B1b).
