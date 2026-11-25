# R3a: problems on the server (docs, written before the build; split into R3a-1 and R3a-2)

Goal: a patient-level problem list that outlives any one case. Recorded list only: no codes needed, no AI, no thresholds. A problem is never deleted.

## Model (decided here; mention in DECISIONS.md when built)
- Problems belong to the PATIENT (`patient_id`), with an optional `case_id` of origin (must be a case of the same patient, enforced by a composite foreign key as in B1a). One list across cases is what R3g, R3i and R9 need.
- Table `patient_problems`: id, patient_id, origin_case_id (nullable), label (text 1..200, clinician's words), onset_date (date, nullable, "unknown" = null), status `active | resolved | entered_in_error`, row_version, recorded_by (session), recorded_at, resolved_by/resolved_at/resolution_reason, error_by/error_at/error_reason. Optional `local_term_code` (text, nullable; verified only through R2f-4a rules later, not checked in R3a).
- Append-only status history: `patient_problem_events` (problem_id, seq, from_status, to_status, reason, by_user, at). Insert only.
- DB guards (do not rest on route code): no DELETE/TRUNCATE; `label`, `patient_id`, `recorded_by`, `recorded_at` never change; status moves only active -> resolved, active -> entered_in_error, resolved -> entered_in_error; entered_in_error is final; a move needs its who/when/reason columns; row_version advances by one. Grants: SELECT, INSERT, and UPDATE only on the status columns for `emr_app`.

## Split
- **R3a-1** (this chunk, first build): migration (next free number, now 018) with both tables and all guards; routes `GET /api/patients/:id/problems` (list, entered-in-error hidden unless `?include=all`), `GET /api/problems/:id` (with events), `POST /api/patients/:id/problems` (add). Permissions `problems:read` (admin, doctor, nurse, viewer), `problems:write` (admin, doctor, nurse). Audit `problem.add` (no label in the audit detail). Matrix and audit tests on purpose. Event row seq 1 written on add (to_status active).
- **R3a-2**: `POST /api/problems/:id/resolve` and `/entered-in-error`, both need a reason (1..1000), stale `row_version` gives 409, already final gives 409; audit `problem.resolve`, `problem.error`. Tests for the DB guards (direct UPDATE of label, delete, truncate refused; error is final).

## Tests for R3a-1
Add as nurse and doctor; viewer refused; other patient's case as origin refused; list hides nothing active; missing label 400; label over 200 chars 400; audit row exists with no label text; direct DELETE and TRUNCATE refused; direct UPDATE of label refused.

Context impact: none (envelope sections come in R3i). Browser: none.
