# Chunk R6f-2: Bundle staging (server). Split into 2a, 2b, 2c

Context impact: none (no envelope change). Parser: `bundle-import.js` (R6f-1, pure, unchanged).

## Rules for all three sub-rows
- New permission `import:write` (admin, doctor). Every new route updates the permission matrix and audit tests on purpose.
- Use the next free migration number. Grants: SELECT, INSERT, and UPDATE only on the status columns. No DELETE or TRUNCATE (forbid_change triggers like 032).
- Store proposal fields only. Never the raw bundle, names, notes or identifiers; keep the bundle hash and the audit counts.
- Accept goes through the same validation as normal entry. The session user is the recorder, never a value from the file. Imported observations start `preliminary`, source `imported`.
- A proposal with blockers, or a MedicationRequest, can never be accepted. The chart is chosen by the person, not matched from the file.
- Accepting twice is refused (one proposal, one record).

## R6f-2a (stage, list, read, reject)
POST stage, GET list, GET one, POST reject (with reason). Audit the stage with the R6f-1 `audit` object.
Tests: permission matrix, audit rows, no DELETE/TRUNCATE (safety-data), migration test, patient isolation, oversized and invalid bundles refused.

## R6f-2b (accept Observation)
POST accept for kind Observation into a chosen patient chart. Tests: record created with recorder = session user, status preliminary, blocked refused, double accept refused.

## R6f-2c (accept Condition and AllergyIntolerance)
Same, through problems and allergies rules. Add a test that MedicationRequest accept is always refused.
