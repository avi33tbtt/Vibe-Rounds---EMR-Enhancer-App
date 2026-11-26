# R5f-2: Follow-up after discharge, server (written 2026-11-26, docs for the row; built in the same session)

**Goal:** a clinician records what follow-up was planned when a patient was discharged. A plan only: no appointment booking, reminders, calendars or tasks, and no discharge medication.

**Context impact:** none. Follow-ups are not in the context envelope. No CCIS change.

**Rules (same pattern as procedures R4i and admissions R5a)**
- Tables `patient_followups` + `patient_followup_events` (migration 032, next free number). Append-only: no DELETE/TRUNCATE; only `status`, `row_version` and the cancel/error columns change, by trigger and by grant.
- A follow-up belongs to ONE admission of the same patient, and that admission must be `discharged` when the follow-up is added (route 409 `not_discharged`, and an insert trigger). Later changes to the admission do not touch it.
- Free text as typed, nothing suggested or checked: instruction (1..500, required), where (1..200, optional), date (optional real calendar date, 2000..2100; may be in the future, that is the point).
- Statuses active, cancelled, entered_in_error; each move needs a reason (1..1000) and the loaded `rowVersion` (stale gives 409); entered_in_error is final.
- Recorder, canceller and error-marker come from the session; a body naming one is refused (400 `unknown_field`).
- Routes: `GET /api/patients/:id/followups` (`?include=all`), `GET /api/followups/:id`, `POST /api/admissions/:id/followups`, `POST /api/followups/:id/cancel`, `POST /api/followups/:id/entered-in-error`. Permissions: reuse `orders:read` / `orders:write`.
- Audit keeps ids and lengths only (never instruction, place or reason text). Actions: `followup.add`, `followup.cancel`, `followup.error`, `followup.view`, `patient.followups_view`.
- Tests: `test/followups.test.js`; matrix and audit rows in `test/safety-routes.test.js`; table list and FK proof in `test/safety-data.test.js`.

**Out of scope:** the page (R5g), envelope (R5h).
