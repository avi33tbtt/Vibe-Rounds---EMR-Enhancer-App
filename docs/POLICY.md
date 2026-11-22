# EMR Enhancer: retention, subject-access and consent notes

**Status: draft notes, not a legal document. Synthetic data only. Not for clinical use.**
Nothing here is legal or regulatory advice, and no statement claims compliance with any law or standard. Rules that need a legal or regulatory view are marked as decisions, not answered.

## How to read the labels

| Label | Meaning |
|-------|---------|
| **BUILT** | The code does this today (checked against the repo on 2026-11-22). |
| **DECISION (you)** | A product or clinical-governance choice for the project owner. |
| **DECISION (adviser)** | Needs a legal, privacy or regulatory adviser. Left open on purpose. |
| **PLACEHOLDER** | Text to be replaced before any real use. Do not rely on it. |

---

## 1. Retention

- **BUILT:** Clinical data is never hard-deleted. The restricted database role `emr_app` has no `DELETE` or `TRUNCATE` on `patients`, `encounters` or `audit_log`, and `TRUNCATE` on those tables is also refused by trigger, even for the owner (migration 005).
- **BUILT:** "Archive" means `patients.archived = true`, with `archived_at` and `archived_by` recorded. The record stays in the database and can be restored by an admin or doctor (`patient.archive` / `patient.restore`, both audited). A patient with an open encounter cannot be archived. Archived patients are hidden from the default list and shown with the archived filter.
- **BUILT:** The audit log is append-only (updates and deletes are rejected by trigger) and has no purge feature. Patient views and searches, registrations, archive/restore, encounter open/close and AI actions are logged. Known gap: listing a patient's encounters is not audited.
- **BUILT:** Login sessions expire after 12 hours.
- **BUILT (limit):** Cases, element sets, observations and notes are not yet stored on the server (planned in Track B). Retention of that content cannot be described until then. In the file demo it lives only in the browser.
- **DECISION (you):** How long archived records are kept before any other handling, and who may approve it. Today the answer is "indefinitely; nothing deletes them".
- **DECISION (adviser):** The minimum and maximum retention periods that apply, whether any erasure or anonymisation right applies, and how that fits with a no-delete design.
- **PLACEHOLDER:** Retention period: `[to be set]`. Audit-log retention period: `[to be set]`.

## 2. Subject access (one patient's data)

- **BUILT:** Who can read patient data: admin, doctor, nurse and viewer (`patients:read`). Every view is audited.
- **BUILT:** There is no per-patient export route or screen. A subject-access request cannot be answered from the app today.
- **DECISION (you):** Who may export one patient's data (suggested starting point: admin only), and in what format (own JSON, FHIR R4 export, or a printed summary).
- **Requirements if it is built (a future row, not yet planned):** server-enforced permission; one patient per request; export audited with who, when and which patient; archived patients included; no other patient's data in the output.
- **DECISION (adviser):** Whether and when a person has a right of access, the response deadline, identity checks, what may be withheld, and who is the responsible controller.
- **PLACEHOLDER:** Request handling contact and deadline: `[to be set]`.

## 3. Consent notes

- **BUILT:** The app holds no consent records and no consent screen.
- **Rule today (project rule, `01-core.md`):** synthetic data only until the go-live gate. Do not enter real patient data, even for testing.
- **Before any real patient is entered, these must be agreed and written down:**
  1. **DECISION (adviser):** The legal basis for processing and whether patient consent or notice is needed.
  2. **DECISION (adviser):** Whether this software counts as a regulated medical device, and which health-data rules apply where it is used.
  3. **DECISION (adviser):** Terminology licence checks for any code system used (also a go-live gate item in the tracker).
  4. **DECISION (you):** Where consent or notice status would be recorded, and who may change it.
  5. **DECISION (you):** Whether AI use needs separate patient information. AI is off by default; its request is de-identified by a safety net that is not a guarantee.
  6. **DECISION (you):** Who owns the go-live decision and signs it off.
- **PLACEHOLDER:** Patient notice text: `[to be written by the adviser]`.

---

## Header-scan result template

The scan needs a deployed URL, so it is done by you after chunk 7a. Copy this table for each scan and keep the filled copies in this file or in `docs/`.

| Field | Value |
|-------|-------|
| URL scanned | |
| Date (YYYY-MM-DD) | |
| Scanner used (name and version/URL) | |
| Grade | |
| Missing or weak headers | |
| Action taken / follow-up row | |
| Scanned by | |

Headers the app is meant to send (from chunks 6b and 6d-1, to compare against the scan): a per-response CSP nonce with `script-src-attr 'none'`, and a `Secure` session cookie when `HTTPS=1`.
