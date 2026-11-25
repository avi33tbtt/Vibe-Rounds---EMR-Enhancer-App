# R5a-1: Admission record, server (written 2026-11-26, docs for the row; built in the same session)

**Goal:** a clinician records that a patient was admitted. Admission only: no beds, transfers, discharge, progress notes or medication administration (rows R5b to R5g).

**Context impact:** none. Admissions are not in the context envelope (only R5h adds the `administrations` section, after a CCIS schema bump). No CCIS change.

**Rules (same pattern as referrals R4h and procedures R4i)**
- Table `patient_admissions` + `patient_admission_events` (migration 028, next free number). Append-only: no DELETE/TRUNCATE; only `status`, `row_version` and the cancel/error columns can change, by trigger and by grant.
- Free text as typed, nothing suggested or checked: ward or unit (1..200), reason (1..500). Admission date-time needs an offset and cannot be in the future (route and trigger).
- At most ONE active admission per patient (partial unique index, plus a check under the patient row lock giving 409 `already_admitted`). Decided because two open admissions for one patient is never right; cancel with a reason first.
- Statuses active, cancelled, entered_in_error; each move needs a reason (1..1000) and the loaded `rowVersion` (stale gives 409); entered_in_error is final.
- Admitter, canceller and error-marker come from the session; a body naming one is refused (400 `unknown_field`).
- Routes: `GET /api/patients/:id/admissions` (`?include=all`), `GET /api/admissions/:id`, `POST /api/patients/:id/admissions`, `POST /api/admissions/:id/cancel`, `POST /api/admissions/:id/entered-in-error`. Permissions: reuse `orders:read` and `orders:write` (no new permission; revisit if an admissions clerk role is wanted).
- Audit keeps ids and lengths only (never ward, reason or move reason text). Actions: `admission.add`, `admission.cancel`, `admission.error`, `admission.view`, `patient.admissions_view`.
- Tests: `test/admissions.test.js`; matrix and audit rows in `test/safety-routes.test.js`; table list and FK proof in `test/safety-data.test.js`.

**Out of scope:** discharge (R5f closes an admission; it will need a new migration to allow a `discharged` status), the page (R5b).
