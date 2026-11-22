# Chunk B3a-observations-server: Applied sets, observations and events (server)

_Ch5 slice B3, server half. Needs: B2a._

**Core rules:** attach `01-core.md` too.

**Read only:** `CLINICAL_CONTEXT_MODEL.md` (observation semantics); `cases.js`, `sets.js`; `test/safety-data.test.js`.

**Build:**
1. Migration: `case_applied_sets` (version pin, applied_by, state active|superseded|withdrawn, supersedes_id), `observations` (case_id, applied_set_id, field_key, value_json, value_type, unit_code, unit_display, effective_at, recorded_at, source_type patient|clinician|imported|device|derived|ai_proposed, source_ref, status preliminary|final|amended|entered_in_error, recorded_by, corrects_id), `clinical_events` (case_id, encounter_id, event_type, occurred_at, actor). Append-only: no UPDATE of value columns by a trigger; corrections add a row with `corrects_id`. In the same migration grant `emr_app` only what the code uses (no DELETE/TRUNCATE; add `forbid_change()` triggers on clinical tables); the grants test must still pass.
2. Routes: apply a set version, add observation(s), correct, mark entered-in-error, list timeline ordered by `effective_at` (with `recorded_at` available). Validation: unknown field_key, wrong type or invalid unit is rejected or stored as explicitly unknown, never coerced. Actor from session.
3. Update the permission matrix and audit scenarios in `test/safety-routes.test.js` on purpose; a new route fails the build until you do.
4. Tests: original timestamps kept after correction; entered-in-error hides but keeps the row; source_type values stay distinguishable; two concurrent writers both succeed without loss.

**Done when:** timeline reproduces values and their origins; corrections preserve history.

**Size guard:** 1 migration, 1 routes file, tests. Notes are B3c, page is B3b.
