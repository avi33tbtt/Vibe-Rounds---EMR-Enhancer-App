# EMR Enhancer: Remaining Build Plan

*Updated 19 Nov 2026. Repo: github.com/avi33tbtt/Vibe-Rounds---EMR-Enhancer-App*

A standalone, context-aware, trajectory-aware, pathway-aware EMR. This file keeps only the work still ahead (chunks 34b1 to 52d) plus the rules, decisions and contracts those chunks depend on. Built chunks 1-34a are summarised, not repeated.

## Contents
1. [Where the project stands](#1-where-the-project-stands)
2. [How to work: one chunk per chat](#2-how-to-work-one-chunk-per-chat)
3. [Permanent rules](#3-permanent-rules)
4. [What the built server already gives you](#4-what-the-built-server-already-gives-you)
5. [Open decisions to confirm](#5-open-decisions-to-confirm)
6. [Phase 5 (cont.): standalone EMR, chunks 34b1-41c](#6-phase-5-cont-standalone-emr)
7. [Phase 6: content lifecycle and marketplace, chunks 42a1-47b](#7-phase-6-content-lifecycle-and-marketplace)
8. [Phase 7: operational context components, chunks 48a-52d](#8-phase-7-operational-context-components)
9. [Reference: data contracts v5, v6, v7](#9-reference-data-contracts)

---

## 1. Where the project stands

**Built (chunks 1-34a, 34b1-34b3, 34c, 34d):**
- Single-file prototype `enhancer.html`: quick bar, fever chart, insulin grid, flowsheets, notes (draft/sign/amend), pathways, rules and alerts, EMR shell, FHIR export.
- Server in the repo root: PostgreSQL schema, REST API, `store.js` cache-first client layer, import from browser, conflict screen, login and sessions, roles and permissions, CSRF, users screen, forced password change, audit log with admin screen and CSV export, entered-in-error history drawer, sign-in audit events, patients/encounters/merge/duplicate-check API (`patients.js`).
- **212 tests pass** on PostgreSQL 16 (`npm test`): the server tests, the store tests (52 in `store.test.js`), and the 34c and 34d tests.
- 34b3 filled in `onPatientChosen`: list open encounters or start one (type, ward, bed), create the chart, link it with `Store.patients.link`, open Summary; the case picker shows name and MRN. The chart's typed `patient` fields are a display copy of the real patient until 34c reads the real record.
- 34b2 added the Find or register a patient dialog (`#ptFind`) in `enhancer.html`, opened by + New patient in server mode; it ends at `onPatientChosen(patient)`, which 34b3 fills in. Demo mode keeps the typed flow.
- 34b1 added `Store.patients` (search, get, create, update, encounters, link) to `store.js`; server mode only, nothing cached, Demo mode rejects with `demo_mode`.

- 34c: the case now carries read-only `patientRecord` and `encounterRecord` (real patient and open encounter, merged duplicates shown as the kept record, none for an informatician). `patientView(c)` in `enhancer.html` is the one place the banner, Patients rows and case pickers read from; in server mode the Edit patient popover is hidden, Demo mode is unchanged. `POST /admin/migrate-demo-patients` (admin, idempotent, audited per case, `dryRun`) turns typed demo patients into real ones.

- 34d: `GET /cases/:id/export` (admin, doctor) returns the real FHIR Patient (MRN, name, gender, birthDate) and Encounter and writes one audit row per export (ids only); `Store.patients.exportCase`; `bundle()` in `enhancer.html` uses them in server mode, Demo mode keeps the placeholder. An unlinked chart is refused (`case_not_linked`).

**Next up:** 35a onward in the order below.

**Manual work that is not a chunk (do soon, needs two real browsers):**
- [ ] (a) Force a conflict on one row and confirm the side-by-side screen appears.
- [ ] (b) Let a session idle out with an unsent reading, sign in as the same user, confirm it is sent.
- [ ] (c) As admin run *Settings > Import from this browser*, then confirm a doctor does not see it.
- [ ] `git rm env.example` (keep `.env.example`).

**Phase order:** Phase 5 (34b1-41c) comes first. Phase 6 (42-47) follows; chunk 42 can be built early because it needs only the prototype. The registry repo (45) needs neither the server nor the app. Phase 7 (48-52) comes last and reuses the repeating-row engine.

---

## 2. How to work: one chunk per chat

1. Open a **new** Claude chat.
2. Paste the chunk's prompt (the code block) and only the files or functions named on its **Paste** line. Never upload this plan file.
3. Ask for **edits only**. Keep each chunk to about 300 new lines; if it does not fit, stop and carry the rest to the next chunk.
4. Run `npm test`. A chunk is not done until the suite passes and its **Done when** items hold.
5. Commit, then tick the box here.

**Standing rule appended to every prompt** (already stated here once, so it is not repeated in each block):

> Return edits only; keep new code under about 300 lines; if more is needed, stop and list what is left for the next chunk. Keep the "Not for clinical use" banner. No pre-filled doses, thresholds or bands.

**Layout rule:** all application files live in the repository root. No `server/`, `src/`, `components/`, `utils/` or `public/` folders. Extend `enhancer.html`, `element-sets.js`, `cds-rules.js`, `store.js`, `api.js` where possible; add a new root file only when a real technical need requires it. No build tooling or bundlers without explicit approval. Translate any later prompt that proposes nested folders to root-level equivalents.

---

## 3. Permanent rules

**Clinical safety**
- No pre-filled clinical thresholds, doses or bands, anywhere. Charts show data only until a clinician types a value.
- Doses are free text exactly as given: never calculated, suggested, summed, converted or auto-filled.
- The AI may draft, never decide. It never approves a rule, never sees patient values, never supplies a dose, band or threshold the clinician did not type.
- Unapproved rules never fire. Approver and verifier are the signed-in user, stamped by the server; only doctor or admin approve; editing an approved rule resets approval.
- Alerts are decision support, not orders ("Review potassium before insulin"), with acknowledge and timestamp.
- Summary and ward views show data presence, latest value and its age. They never judge adequacy of care.
- Corrections are amendments with a reason. Nothing is silently overwritten or hard-deleted. Discontinued orders keep their row.
- Billing codes never change clinical notes or trigger alerts; unverified codes are left out of exports.

**Data and security**
- Every write carries the version last seen; conflicts return 409 with `current`, never last-write-wins.
- Every write also writes an audit row in the same transaction. If the audit insert fails, the write fails.
- The audit log is append-only and never stores passwords, hashes, national id or AI content.
- Server enforces permissions; hiding controls in the UI is only a mirror.
- AI stays off by default, goes through the server, is de-identified, and is logged without content. Identifiable data must not reach an external model provider without a data processing agreement.
- FHIR R4 and SNOMED/LOINC are **export only**. Nothing is read from or written to another EMR.

**Release gates**
- Keep the "Not for clinical use, synthetic data only" banner until the safety sign-off is complete.
- No real patients until a named clinician signs the safety review **and** the restore test (41b) has passed.
- Verify every SNOMED, LOINC, ICD-10 and CPT code yourself. Models invent plausible codes. Unverified codes are flagged, never trusted.
- Software that raises clinical alerts or distributes decision-support rules may count as medical-device software. Check local rules before real use or a public release.
- Check health-data law and SNOMED CT / LOINC licence terms where this will run and before codes go in a public repository.

---

## 4. What the built server already gives you

Facts the remaining chunks rely on, so each new chat can be told them briefly.

- **Stack:** Express + PostgreSQL 16, files in the repo root, numbered migrations `001_core.sql` to `005_patients.sql`, tests with `node:test` + supertest. `API.md` lists every route with its action and role.
- **Permissions:** one table in `permissions.js` (`can(user, action)`, `ROUTE_ACTIONS`). A route registered without an action stops the server starting. A role x route matrix test and a CSRF test pick up new routes automatically.
- **Roles:** viewer reads; nurse adds readings and amends her own, acknowledges alerts; doctor also writes notes and values, applies sets and pathways, creates and approves rules and protocols; informatician authors sets, pathways and codes (no charting, cannot open patients); admin holds every action and is the only role that imports.
- **Auth:** scrypt hashes, httpOnly cookie sessions (idle 30 min, absolute 12 h), lockout after 5 failures, CSRF token in `X-CSRF-Token` on every write, forced password change, last-admin protection.
- **Audit:** `audit.js` with `auditOnce` for throttled view rows and `auditAuth` for sign-in events; `audit_log` refuses UPDATE and DELETE. New write routes must be added to the audit-coverage test (exactly one audit row each).
- **Patients:** MRN is server-made (7 digits plus Luhn check digit). Duplicate check answers `409 possible_duplicate` with candidates until the caller resends with `confirmDifferent: true`. Merge moves and deletes nothing: the duplicate points at the kept record via `mergedInto`, so **every screen and query must follow `mergedInto`**. One open encounter per ward and bed. A case cannot move between patients. National id never enters the audit log.
- **Store (`store.js`):** `window.Store` with synchronous reads from an in-memory cache, ordered write queue diffed against server-confirmed data, per-entity `expectedVersion`, save-status text, conflict hooks (`conflictInfo`, `conflictReview`, `resolveConflict`), `Store.who()`, `Store.can(action)`, `Store.users`, `Store.login/logout/resume`. Demo mode (localStorage, synthetic data) hides nothing and never calls the server.
- **Rows:** repeat groups live in `case_rows` (append, patch with version, entered-in-error with reason, max 500 per group). `getSet(id, entry)` returns the version recorded on a case's applied or pathway entry; analytics and the patient list still use the latest version.
- **Rules and protocols:** saved unverified; server stamps approval; typed verifier names are dropped; imports clear all approvals.

---

## 5. Open decisions to confirm

Earlier chunks recorded these as "decisions to confirm". Answer them before the chunk that touches them, or accept the defaults.

| # | Decision (current default) | Matters for |
|---|---|---|
| 1 | Locked-account sign-in attempts are **not** logged (only the lock itself). Log with a rate cap? | 40b |
| 2 | Admin may chart, approve and sign. Keep? | 35, 39a |
| 3 | An informatician cannot search or open patients. Keep? | 44, 46 |
| 4 | A nurse may register and correct patients. Keep? | 34b-34c |
| 5 | Attending must be a doctor or admin. Keep? | 34b3 |
| 6 | Patient searches are not audited; opening a record is. Keep? | 34b2, 40c |
| 7 | A nurse cannot apply sets or pathways, so a doctor must apply a flowsheet before a nurse can chart in it. Keep? | 37b |
| 8 | The audit CSV omits before/after contents; viewing the Audit screen is not logged, only exports. Keep? | 40c |
| 9 | Reference-data conflicts (sets, rules, protocols, codes) only offer "Reload the app", no side-by-side screen. Acceptable? | 37a |
| 10 | Package rules and bands arrive disabled; two reviewers for packages with rules is recommended. Require it? | 44, 47b |

---


## 6. Phase 5 (cont.): standalone EMR

Turns the prototype into a real multi-user system. Each chunk assumes the earlier ones. Server halves come before client halves.

| Chunks | What they add |
|---|---|
| 34b-34d | Patient search/registration screens, banner and list on real data, FHIR Patient/Encounter export |
| 35 | Rule approval, alert acknowledgements and a "Rules in force" screen as server records |
| 36 | AI on the server: de-identified, admin-switched, off by default |
| 37 | Several staff at once: live refresh, intake/output, ward board, handover |
| 38 | Shared analytics with small-count masking |
| 39 | Automated tests and a safety test pack |
| 40-41 | Security hardening; deployment, encrypted backups, tested restore, go-live |


### [x] 34b1. Patients 2a: Store.patients in store.js (no screen)

**Goal:** Browser data layer for patients and encounters. Server mode only, tests included.

```text
store.js and store.test.js only. Add Store.patients with search(q), get(id), create(body) (a 409 possible_duplicate carries candidates; the caller resends the same body with confirmDifferent:true only after the user confirms), update(id, body with expectedVersion and reason), encounters(patientId), createEncounter(patientId, body), updateEncounter, closeEncounter, cancelEncounter and link(caseId, {expectedVersion, patientId, encounterId}), over the routes in API.md section 'Patients, encounters and linking a case'. Server mode only; never cached in localStorage; in Demo mode these methods report 'not available in demo mode' and the typed demo fields stay as they are. Tests with the simulated browser: search, create, duplicate 409 then confirmDifferent resend, update with a version conflict, link. Do not touch enhancer.html.
```

**Paste:** Store public API list, the request helper in store.js, the 34a section of API.md

**Done when:** `npm test` passes including the new Store tests; no change to `enhancer.html`; Demo mode methods report 'not available in demo mode'.


### [x] 34b2. Patients 2b: search, duplicate check and picking a patient

**Goal:** Screen part 1 in enhancer.html: find or register a patient. Ends with a chosen patient.

```text
enhancer.html only (uses Store.patients from 34b1). Rework the New patient flow in two steps; this chunk does step one. (1) Search box for name or MRN; list of matches with name, age, sex, MRN. (2) 'Register new patient' form; if the server answers possible_duplicate, show the candidates and let the user either pick an existing patient or tick 'this is a different person' and save (resend with confirmDifferent:true). (3) If a patient answers mergedInto, open that record instead and say so. (4) Plain messages for patient_merged and patient_locked. (5) When a patient is chosen, call onPatientChosen(patient); for now it only shows the chosen patient's name and MRN (34b3 fills it in). Demo mode keeps the old typed fields. Do not change the banner or the Patients list.
```

**Paste:** New patient function from 25F, Store.patients method list from 34b1

**Done when:** New patient flow works in server mode against the real server; duplicate candidates shown; merged patient opens the kept record; Demo mode unchanged.


### [x] 34b3. Patients 2c: start an encounter, link the case, open Summary

**Goal:** Screen part 2: pick or start an encounter, attach the case, show name and MRN in the case picker.

```text
enhancer.html only. Fill in onPatientChosen(patient): list the patient's open encounters, or start one (type, ward, bed); then link the case with Store.patients.link using expectedVersion and open it on Summary. Plain messages for bed_occupied and for a version conflict on link. The case picker shows patient name and MRN. Keep Demo mode unchanged. Do not change the banner or the Patients list (34c does that).
```

**Paste:** onPatientChosen stub and New patient code from 34b2, Store.patients.link and createEncounter signatures

**Done when:** A chosen patient plus encounter is linked to the case and Summary opens; a bed conflict gives a plain message.


### [x] 34c. Patients 3: banner and Patients screen use real data; migrate demo_patient

**Goal:** Replace free-typed banner fields with patient and encounter data.

```text
(1) Patient banner and Patients landing rows read the real patient and encounter (name, age from DOB, sex, MRN, ward, bed). Remove the free-typed case.patient edit popover in server mode (keep in Demo mode). (2) Server: one-time endpoint (admin) that turns cases.demo_patient into patients and encounters, linked and audited, idempotent. (3) Tests for the migration. Keep the row renderer in one function.
```

**Paste:** banner render function, Patients row renderer, demo_patient columns

**Done when:** Banner and Patients list show real patient and encounter data in server mode; migration is idempotent and audited; Demo mode keeps typed fields.


### [x] 34d. Patients 4: real FHIR Patient/Encounter in an audited export

**Goal:** buildBundle uses real Patient and Encounter; export is a server endpoint that writes an audit row.

```text
(1) buildBundle(case) uses the real Patient (identifier MRN, name, gender, birthDate) and Encounter. (2) Export becomes GET /api/cases/:id/export that audits 'export' with the user and returns the bundle. FHIR stays EXPORT ONLY. (3) Analytics and any shared export never include names. (4) Tests: export audited; bundle has Patient with MRN; no protocol bands or thresholds in the bundle.
```

**Paste:** buildBundle, export UI, audit.js

**Done when:** FHIR Patient/Encounter export works and writes an audit row; national id is not in the audit log.


### [ ] 35a. Server rules 1: approve rules and protocols on the server

**Goal:** Approval is a server action: role check, stamp user and time, audit.

```text
Server plus small client change. (1) POST /api/rules/:id/approve and /api/protocols/:id/approve: doctor or admin only, stamps verified_by and verified_at, audits. The client can no longer set them. (2) Editing a rule or protocol resets approval on the server. (3) Client: Approve buttons call these routes. (4) Tests: nurse cannot approve; edit resets approval. Unapproved rules never run; no thresholds pre-filled.
```

**Paste:** rules/protocol routes, cds-rules.js approve code, permissions.js

**Done when:** Approval comes only from the session user; typed names are ignored; tests cover nurse refusal.


### [ ] 35b. Server rules 2: alert acknowledgements as server records

**Goal:** alert_acks table replaces case.alertLog; edits make old acks irrelevant.

```text
(1) Server: alert_acks (rule_id, set_id, sig, user_id, acked_at) with POST and list per case. sig = hash of rule content plus field value time, so an edited rule's old acks are ignored. (2) Client: the alert banner and Alerts tab read acks from the Store cache and acknowledge through it. evalRules stays a pure client function. (3) Migrate old alertLog entries during import (chunk 31 path) as 'imported'. (4) Tests for ack and for sig change ignoring old acks.
```

**Paste:** alert acknowledge functions, evalRules signature, alert_acks table

**Done when:** Acknowledgements are server records with user and time; an alert acknowledged by one user shows as acknowledged to others.


### [ ] 35c. Server rules 3: 'Rules in force' admin screen

**Goal:** Admin list of every approved rule and protocol with approver and date, plus CSV.

```text
Tools > Rules in force (admin and doctor). Lists approved rules and protocols: plain-language sentence, set, approver, date, source. Server route returns them; CSV export is audited and formula-safe. Filter by set and by source. Tests for access and CSV.
```

**Paste:** rule sentence function from cds-rules.js, permissions.js, Tools menu code

**Done when:** Admin sees every rule in force with approver and time; screen is read-only.


### [ ] 36a. AI proxy 1: server routes, admin switch, limits, audit

**Goal:** /api/llm/* routes with the key in the server environment; off by default.

```text
Server only. (1) Routes /api/llm/schema, /api/llm/suggest, /api/llm/rule-draft; each accepts only its existing inputs (validated). Key in an environment variable only. (2) AI is OFF unless an admin enables it (setting stored in the database); when off return 403 'AI disabled'. (3) Per-user rate limit and size cap. (4) Audit row per call (purpose, user, patient if any, byte count, no content). (5) Output validation as today (ids in registry, no doses, whitelisted operators, thresholds appear in the typed sentence). Tests with a mocked provider.
```

**Paste:** current client prompt strings and validators from enhancer.html/cds-rules.js, server.js, audit.js

**Done when:** AI is off by default; admin switch, limits and audit rows work; no content is logged.


### [ ] 36b. AI proxy 2: de-identification, confirm dialog, buttons follow the switch

**Goal:** Strip identifiers before sending narratives; show exactly what will be sent; hide buttons when AI is off.

```text
(1) Server: de-identify narrative inputs (remove name, MRN, phone, national id, addresses, exact birth date; age only). (2) Client: re-enable the AI buttons through the server routes; show the exact text to be sent with 'Send' and 'Cancel'; nothing is saved without a clinician click. (3) Hide AI buttons when /api/me says AI is off. (4) Admin note in Settings: an external provider receives the data and needs a data processing agreement. Tests: identifiers removed; rule drafting never receives patient values.
```

**Paste:** AI button handlers, generateSchema/suggestSets/generateRuleDraft client code, llm routes

**Done when:** No identifiers leave the server; confirm dialog appears; AI buttons follow the admin switch.


### [ ] 37a. Ward 1: live refresh via /changes

**Goal:** Polling endpoint and a merge that never overwrites what someone is typing.

```text
(1) Server: GET /api/cases/:id/changes?since= returning rows, values and notes changed after the given version or time. (2) Client: while a case is open poll every 10-15 s, merge new rows into the cache, never overwrite a field the person is editing, show 'updated by <name> at <time>'. Stop polling when the tab is hidden. (3) Tests for the endpoint and a merge unit test.
```

**Paste:** GET case route, Store cache merge code

**Done when:** Two browsers see each other's new rows within one poll; typing is never overwritten; polling stops when the tab is hidden.


### [ ] 37b. Ward 2: intake/output set and entered-by initials

**Goal:** Seed care.intake_output with no targets; show initials of the person who entered each row.

```text
(1) Check element-sets.js and add care.intake_output if missing: group io_time, io_type (Intake oral, Intake IV, Urine, Drain, Stool, Other), io_volume (mL), io_note; no targets or limits; direct:true. (2) Show entered_by initials in the Flowsheets table (the reserved column from 25C). (3) Test that the seed set has zero rules and thresholds.
```

**Paste:** element-sets.js care.* entries (just one example), Flowsheets row renderer


### [ ] 37c. Ward 3: shift fluid summary and ward board

**Goal:** Plain sum of entered rows per type for a window, and the ward board columns.

```text
(1) Shift summary on the I/O flowsheet: plain sum of entered rows per type for a chosen window, labelled 'sum of entered rows', never compared to a target; doses are never summed. (2) Extend the Patients screen into a ward board: patients of a ward with latest value and age for each pinned direct set; 'no reading for N minutes' only where an approved minutes_since_gt rule exists. Keep the row renderer in one function.
```

**Paste:** Patients row renderer, flowsheet renderer, ageTxt, evalRules signature

**Done when:** Ward board and shift summary show totals as recorded data only, with no adequacy judgement.


### [ ] 37d. Ward 4: print-friendly handover view

**Goal:** One page per patient for handover.

```text
Handover view per patient: narrative, active pathways, latest values with age, alerts acknowledged in the last 24 h, rows entered since the last handover (the 'last handover' time is a button press stored per user). Print CSS for A4, no interactive controls when printing. Display only; no judgement of care.
```

**Paste:** Summary helpers, notes functions, ageTxt


### [ ] 38a. Analytics 1: server aggregate endpoints with filters

**Goal:** Move ana() to server aggregates for one scope at a time.

```text
Server plus client wiring. Aggregate endpoints for the chosen scope (one disease, pathway or care set) keeping every existing card's numbers; date-range and ward filters; aggregates only, patient lists need doctor or admin. Client ana() calls the endpoints; synthetic-case buttons stay in Demo mode only. Tests that results match the old computations on a fixture.
```

**Paste:** ana() and its helpers, one example card, API.md


### [ ] 38b. Analytics 2: small-count masking and de-identified export

**Goal:** Cells under 5 show '<5'; de-identified CSV/FHIR export, audited.

```text
(1) Mask any cell under 5 cases as '<5' on the server (and complementary cells where needed). (2) De-identified CSV and FHIR export: no name, MRN, phone, national id or exact dates (days since encounter start); every export audited with its filter. (3) Tests for masking and for no identifiers in the export.
```

**Paste:** aggregate endpoints, audit.js


### [ ] 39a. Tests 1: permission matrix, concurrency, audit

**Goal:** Consolidate and extend the server tests.

```text
Create or extend tests: (1) permission matrix from permissions.js (every role x every route); (2) parallel row appends all succeed, conflicting edits give one 409; (3) no change without an audit row; (4) npm script test:server. List gaps found, do not rewrite code.
```

**Paste:** permissions.js, route list, existing test file names and sizes

**Done when:** Matrix, concurrency and audit tests run in `npm test`.


### [ ] 39b. Tests 2: safety test file and migration test

**Goal:** Scripted clinical-safety assertions and migration checks.

```text
(1) safety.test.js: seed sets contain zero rules, thresholds and bands; unapproved or unit-mismatched rules never fire (use cds-rules.js in a vm); bundle never contains protocol bands or fever thresholds; doses never summed; entered-in-error rows hidden but present. (2) migration.test.js: fresh database, and upgrade from the previous migration. (3) npm script test:safety.
```

**Paste:** cds-rules.js evalRules, buildBundle, migration runner


### [ ] 39c. Tests 3: Playwright smoke test and CI workflow

**Goal:** Browser smoke test and a GitHub Actions file.

```text
(1) smoke.test.js with Playwright: login, new patient, add a vitals row, trigger a conflict and see the conflict screen. (2) .github/workflows/ci.yml running test:server, test:safety and the smoke test with a PostgreSQL service. (3) npm script test:all. Keep files minimal.
```

**Paste:** package.json, login and new-patient UI element ids

**Done when:** CI runs the unit tests and the Playwright smoke test on every push.


### [ ] 40a. Security 1: Content-Security-Policy and output escaping

**Goal:** Move inline scripts out or use nonces; check every user string rendered to HTML.

```text
(1) Review enhancer.html for every place a user string is put into HTML (narrative, notes, set titles, rule text, patient names, error messages) and list or fix unescaped ones with one esc() helper. (2) Prepare a strict CSP: either move inline script and style to files (root files, no folders) or serve nonces from server.js. Provide the header. Test that the app still runs. List what you could not verify.
```

**Paste:** enhancer.html sections that use innerHTML (ask me for them by function name if needed), server.js static serving

**Done when:** Strict CSP in place; injected script in any text field stays inert.


### [ ] 40b. Security 2: DB roles, headers, limits, cookies

**Goal:** Separate DB roles and server hardening.

```text
Server only. HTTPS-only with HSTS (behind the proxy), helmet-style headers, body size limits, parameterised-SQL review of every query, separate roles (migration role with DDL, app role without DDL, audit without UPDATE/DELETE), cookie flags and session fixation check, npm audit. Return changes and a short list of risks.
```

**Paste:** server.js, auth.js, one example of each query style in api.js


### [ ] 40c. Security 3: retention, subject access, consent, regulatory checklist

**Goal:** Retention setting, subject-access export, consent field, encrypted backups note, and the checklist.

```text
(1) Retention setting (document only, no automatic deletion of clinical data). (2) Subject-access export of one patient's data (admin, audited). (3) Optional consent field on patients where local law needs it. (4) Checklist of what to confirm under health-data, medical-device-software and national digital health rules where this runs, and the top 10 risks. No rewrite.
```

**Paste:** patients routes, audit.js


### [ ] 41a. Deploy 1: Dockerfile, compose, TLS proxy, environment list

**Goal:** Container deploy files.

```text
Produce Dockerfile, docker-compose.prod.yml (app + PostgreSQL, no ports exposed except the proxy), a reverse proxy config with TLS (Caddy or nginx), the environment variable list in .env.example, and the migration procedure. Root-level files only, minimal. No clinical changes.
```

**Paste:** package.json, server.js config section, docker-compose.yml


### [ ] 41b. Deploy 2: encrypted backups and a tested restore

**Goal:** Nightly encrypted backup, retention, restore script and a restore test.

```text
Produce backup.sh (pg_dump, encrypt, retention), restore.sh, and a step-by-step RESTORE TEST document that must pass before go-live (restore to a clean database, run the safety tests, compare row counts). Add a health check and an uptime alert suggestion and log rotation.
```

**Paste:** docker-compose.prod.yml

**Done when:** A backup is restored onto a clean database and the app reads it correctly. This is a release gate.


### [ ] 41c. Deploy 3: downtime procedure and go-live checklist

**Goal:** One-page downtime procedure and the clinical sign-off checklist.

```text
Write DOWNTIME.md (paper forms for vitals, I/O and medication; back-entry records both the original time and the entry time) and GOLIVE.md: named clinician safety review, user training, pilot on one ward with synthetic data, limited real use, and removal of the 'Not for clinical use' banner only after sign-off. No code changes.
```

**Paste:** nothing, or the chunk 41a files list

**Done when:** Downtime procedure and go-live checklist exist and are signed by a named clinician.


---

## 7. Phase 6: content lifecycle and marketplace

The engine is stable; clinical content (element sets, pathways, rules) changes often and differs by place. Content gets a controlled life in three gates:

| Gate | Who | What happens | Chunks |
|---|---|---|---|
| 1. Request and draft | Clinician | Describes a need in plain words; AI drafts a form, flowsheet, pathway skeleton or rule as an unapproved local draft | 43 |
| 2. Review | Informatician (new role), never the author | Automatic lint, then a human checklist; approval, reviewer and time stamped by the server | 42, 44 |
| 3. Marketplace | Any facility | Approved content published as versioned, hash-pinned, signed packages in a public GitHub registry; facilities browse, preview and install read-only | 45, 46 |

**Four content rules:** (1) local content is free to create and edit; (2) marketplace content can be fetched and used; (3) installed marketplace content is read-only and replaced only by a newer published version, enforced by the server; (4) it is extended only by composition (other components added next to it), never by editing it.

**Badges** appear on set cards, notes, the Pathway tab and in FHIR Provenance:

| Tier | Meaning | Editable? |
|---|---|---|
| Marketplace-verified | Installed from the registry; hash and signature checked at install | No (fork instead) |
| Local reviewed | Approved by an informatician here, version frozen | Editing creates a new draft version |
| Local draft | Anything else, including AI drafts and forks | Yes |

"Verified" means peer-reviewed, not approved by a regulator.

**Trust does not come from GitHub alone.** GitHub gives hosting, history, PR review, CODEOWNERS and CI, but tags can move and releases are unsigned by default. So every package version is pinned by SHA-256 in `index.json`, the index is signed by the registry maintainers, the public key is pinned in server config, and the server verifies both at install. Protect `main` (required CODEOWNERS review, no force-push, no tag deletion) and check GitHub's current docs for tag protection and immutable releases. A wrong version is withdrawn in the index; cases that used it show a warning and nothing is deleted.

**Extra checks for Phase 6:** packages contain definitions only (no patient data, names, MRNs or free-text cases); any rule threshold, band or dose-like text must carry a citation the AI did not invent; peer review is not regulatory approval; MIT covers the code, so decide a content licence for packages; installs never auto-upgrade existing cases; the server fetches only from the allow-listed registry, and offline hospitals install from a file with the same hash, signature and lint checks; two reviewers for packages containing rules or bands.


### [ ] 42a1. Content 1a: package-lint.js base and first checks

**Goal:** canonicalJson, sha256Hex and the structural lint checks, with tests.

```text
Create package-lint.js (browser and Node; end with if(typeof module!=='undefined')module.exports=...) and package-lint.test.js (node:test). canonicalJson(obj) (sorted keys, no whitespace), async sha256Hex(text) (crypto.subtle or node:crypto), and lintPackage(pkg, verifiedCodes) returning {errors, warnings}. This chunk adds only these errors: bad manifest or semver, id pattern, unknown field type, content over 1 MB, any key named eval or function. No network, no eval. Tests: one passing package and one failing case per error, plus a stable hash for the same content with keys in a different order.
```

**Paste:** Data contract v6


### [ ] 42a2. Content 1b: package-lint.js safety checks and warnings

**Goal:** Rule, threshold, dose-like text, patient-like strings and the warnings.

```text
Extend package-lint.js and package-lint.test.js. Add errors: rule op not whitelisted, threshold not a finite number, band/rule/dose-like text without a references entry, patient-like strings (phone numbers, long digit runs, 'MRN', 'patient name') reported with the path. Add warnings: coding not in verified table, empty rationale, duplicate field ids. One failing test per new error and per warning; the 42a1 tests must still pass.
```

**Paste:** Data contract v6, the current lintPackage function from 42a1

**Done when:** Lint flags patient-like data, uncited thresholds and unverified codes with plain messages.


### [ ] 42b. Content 2: tier badges, read-only guards, Fork

**Goal:** Registry fields, badges and read-only rendering.

```text
enhancer.html. Add source, readOnly, tier, forkedFrom, package to registry entries (old entries default to source seed or local, tier local-draft). Tier badge on set cards, the Pathway tab and the '+ Add' list. A readOnly set renders without edit controls (no field, rule or protocol editing); applying it and entering VALUES stay allowed. Guard the save functions too, not only the UI. 'Fork to local copy': new setId 'local.<slug>', version 1, tier local-draft, forkedFrom {setId, version, contentHash}; never changes the original. Editing a local-reviewed set creates a new draft version.
```

**Paste:** Data contract v6, set card renderer, set save functions, '+ Add' list renderer

**Done when:** Server refuses PATCH/DELETE on read-only sets; guards exist in save functions, not only in the UI.


### [ ] 42c. Content 3: import package file and Provenance

**Goal:** Import a package JSON (Demo mode) and list package info in FHIR Provenance.

```text
(1) Tools > Import package file: read JSON, run lintPackage, show errors and warnings, on success store as source marketplace, readOnly true, tier marketplace-verified only after hash recomputed locally (Demo mode only for now; the server does it in chunk 46a). (2) buildBundle Provenance lists package id, version, contentHash and tier per applied set. No new clinical logic.
```

**Paste:** package-lint.js export names, buildBundle Provenance part, Tools menu code


### [ ] 43a. Request 1: request flow and AI draft, 'My drafts'

**Goal:** Plain-words request to an AI draft saved as an unapproved local draft.

```text
'Request a feature' in '+ Add' and Tools: text box and output choice (form/flowsheet set, pathway skeleton of existing ids, rule for an existing set). Reuse the chunk 36 routes only. The model gets only the sentence plus registry ids, titles, field ids, labels and units. Validation as before (ids exist, whitelisted operators, thresholds appear in the sentence, no invented doses or bands, codes empty unless verified). A valid draft is saved as a local set tier local-draft with provenance {requestText, model, at} and listed under 'My drafts'. With AI off, the manual set builder still creates drafts.
```

**Paste:** Data contract v6, set builder save function, llm client calls


### [ ] 43b. Request 2: live lint, draft safety block, submit route

**Goal:** Lint on drafts, never apply a draft to a real case, Submit for review.

```text
(1) Run lintPackage live on a draft and show errors in plain language. (2) 'Try it' applies a draft only to Demo or synthetic cases; block applying any unapproved draft to a real patient's case in code with a message. (3) 'Submit for review' enabled only with zero lint errors; new route creates a review_requests row (status submitted) with a validated body; the author cannot edit the submitted version (editing creates a new version and withdraws the request). (4) Tests: invalid AI output saves nothing; draft cannot be applied to a real case; submit refused with lint errors.
```

**Paste:** package-lint.js, applySet, review_requests table, permissions.js


### [ ] 44a1. Review 1a: informatician role, review queue and get-one (server)

**Goal:** Permissions for the informatician role, list queue, get one with server-side lint.

```text
Server only. Update permissions.js for the informatician role (reviews and approves content, installs packages; no charting). Add routes: list queue (submitted, in_review, changes_requested) and get one (re-run lintPackage on the server and return the result). Reviewer and decidedAt always come from the session. Tests: informatician allowed, nurse and viewer refused, get-one returns lint errors for a bad package. No approve, reject or request-changes yet (44a2).
```

**Paste:** Data contract v6, permissions.js, audit.js, review tables from 001_core.sql, package-lint.js


### [ ] 44a2. Review 1b: approve, request changes, reject (server)

**Goal:** The decision routes and the two-reviewer rule.

```text
Server only. Add approve, request changes (comment required) and reject (comment required). Rules: reviewerId != authorId (403); two distinct approving reviewers when content has any rule, band or dose-like text (configurable, default 2); approval freezes that version as tier local-reviewed; later edits create a new draft version; review_events and audit_log written in one transaction. Tests: author cannot review, one approval is not enough for rule content, missing comment refused, rollback leaves no half-written rows.
```

**Paste:** Data contract v6, review routes from 44a1, permissions.js, audit.js


### [ ] 44b. Review 2: review screen

**Goal:** Queue, checklist, rendered content, diff.

```text
Tools > Review screen: queue, review page with request text and AI provenance, fields and rules in plain language, server lint result, diff against the previous version if any, and the checklist (schemaValid automatic, the rest ticked by the reviewer, codesVerified compared with verified_codes). Buttons Approve (all ticked or waived with comment), Request changes, Reject. Optional 'Prepare for public registry' on an approved version.
```

**Paste:** Data contract v6, review routes doc, plain-language rule sentence function


### [ ] 44c. Review 3: tests

**Goal:** Automated tests for the review rules.

```text
Tests: self-review refused; one reviewer insufficient for rules; approved version immutable; edit after approval makes a draft; reviewer id comes from the session; every action writes review_events and audit_log; informatician cannot chart. List gaps found.
```

**Paste:** review routes, permissions.js

**Done when:** Reviewer cannot be the author (server-enforced); every status change writes a review_events row.


### [ ] 45a. Registry 1: repo layout, templates, docs

**Goal:** New repo emr-enhancer-registry: structure and community files.

```text
Separate repo, not the app. Create: packages/<id>/<version>/package.json layout, README.md, CONTRIBUTING.md (how a facility turns an approved local version into a package via 'Prepare for public registry' and opens a PR; the app never needs a GitHub token), GOVERNANCE.md stub, LICENSE (MIT, code), CONTENT-LICENSE.md with a clear placeholder for me to choose, .github/CODEOWNERS, PULL_REQUEST_TEMPLATE.md (the review checklist), ISSUE_TEMPLATE files (pathway request, rule request, error or recall request). Seed packages only if I confirm their codes are verified; otherwise leave codings empty.
```

**Paste:** Data contract v6


### [ ] 45b. Registry 2: index builder, verify script, CI

**Goal:** Scripts that build and check the index; CI on every PR.

```text
Create scripts/build-index.js, scripts/verify.js and .github/workflows/ci.yml. CI: copy package-lint.js with a check that it matches the app's copy, lint changed packages, recompute contentHash and compare, refuse edits to an already-merged version folder, rebuild index.json in a check job. index.json is generated, never hand-edited. Add a tiny test for verify.js.
```

**Paste:** package-lint.js, Data contract v6


### [ ] 45c. Registry 3: signing, release workflow, withdrawal, protection checklist

**Goal:** Signed index on a protected tag; withdrawal list.

```text
(1) release.yml on a protected tag: build index.json, sign with an ed25519 key from GitHub secrets (node:crypto), publish index.json and index.json.sig, print the public key and keyId; never commit a private key. (2) withdrawn.json edited by PR with a reason, marked in the index. (3) List the branch and tag protection settings to apply by hand (required CODEOWNERS review, no force-push, no tag deletion, signed commits) and tell me to check GitHub's current docs on tag rulesets and immutable releases. (4) Key rotation and key-loss notes in GOVERNANCE.md.
```

**Paste:** build-index.js, ci.yml

**Done when:** Signed index verifies with the pinned public key; branch protection checklist completed.


### [ ] 46a1. Marketplace 1a: signed index fetch (server)

**Goal:** Verified fetch of the registry index only. Nothing is installed yet.

```text
Server only. GET /api/market: fetch index.json and index.json.sig from ONE allow-listed base URL set in the environment, cache with ETag, verify the signature against the pinned public key, refuse if invalid. Network egress only to that host. Admin or informatician only. Tests: wrong signature refused, unlisted host refused, ETag cache used, tampered index refused.
```

**Paste:** Data contract v6, permissions.js, the environment variable list


### [ ] 46a2. Marketplace 1b: install a package (server)

**Goal:** Fetch, verify, lint and store one package as read-only.

```text
Server only. POST /api/market/install: fetch the package, recompute contentHash and compare with the signed index, run lintPackage, check manifest.requires and minAppVersion, then store in element_sets as source marketplace, read_only true, tier marketplace-verified, plus an installed_packages row, in one transaction with an audit row. Rules and bands arrive enabled:false. The server refuses PATCH and DELETE on read_only rows (403). Admin or informatician only. Tests: tampered package refused, hash mismatch refused, failed lint refused, nothing stored on any failure, read-only rows refuse edits.
```

**Paste:** Data contract v6, package-lint.js, permissions.js, element_sets routes, GET /api/market code from 46a1

**Done when:** A tampered hash or bad signature is refused; installed content is read-only.


### [ ] 46b. Marketplace 2: browse, preview, install screen

**Goal:** Marketplace screen in Tools.

```text
Tools > Marketplace: search, filter by kind and context, preview (members, fields, rule count, reviewers, license, short hash, version history, withdrawn flag), Install button calling the route from 46a, installed badge. Loading and error states. No update logic yet.
```

**Paste:** market routes doc, tier badge helper, Tools menu code


### [ ] 46c. Marketplace 3: updates, recall, file install, uninstall/retire

**Goal:** Update side by side, withdrawal warning, offline install.

```text
(1) 'Update available' installs side by side; existing cases keep their version; new cases use the newest. (2) Withdrawn versions: banner on every case using it (Summary and Pathway tab) with the reason; applying to NEW cases blocked; nothing removed. (3) Install from file (no internet) with identical checks and the signed index entry supplied. (4) Uninstall only if no case uses it, else mark retired. (5) Rules and bands show 'Needs local enable'; a doctor or admin enables them (server stamps user and time, audited), never editable. Tests for update, withdrawn and uninstall rules.
```

**Paste:** market routes, Summary and Pathway tab render functions, installed_packages table

**Done when:** Update never changes existing cases; a withdrawn version shows a warning and deletes nothing.


### [ ] 46d. Marketplace 4: composition and composite pathways

**Goal:** Local composites with pinned references.

```text
'Build composite pathway' creates a LOCAL pathway whose members are pinned {setId, version, contentHash}; may include one marketplace pathway (expanded one level), cycle check; each member shows its own tier badge; the composite takes the weakest tier unless all members are marketplace-verified; a publishable composite may contain only marketplace-verified members. It never copies or edits member content. Tests: self-composite cycle refused; composite tier computed correctly.
```

**Paste:** Data contract v6, applyPathway, tier badge helper


### [ ] 47a. Governance 1: marketplace safety tests

**Goal:** Add the immutability and provenance tests to the safety pack.

```text
Add to the safety tests: marketplace content cannot be edited by any route; a fork gets a new id and tier local-draft and leaves the original unchanged; a changed byte fails the hash check; a bad index signature is refused; patient-like strings fail lint; package rules and bands never fire until a doctor enables them; a withdrawn version warns and blocks new use; Provenance lists id, version, hash, tier; a case keeps its version after an update; reviewer is not the author; seed sets still have zero rules, bands and thresholds. List gaps.
```

**Paste:** safety.test.js, market and review routes

**Done when:** Safety tests for marketplace read-only, hash, signature and no-auto-upgrade all pass.


### [ ] 47b. Governance 2: GOVERNANCE.md and top 10 risks

**Goal:** What 'verified' means, reviewers, recall, licensing and regulatory checklist.

```text
Write GOVERNANCE.md: what 'verified' does and does not mean (peer review, not regulatory approval); who may review and conflict-of-interest declaration; two-reviewer rule for rules and bands; how to request a recall and target response time; error reporting; content license; a checklist to complete BEFORE the first public release (SNOMED CT and LOINC licence terms for public redistribution, medical-device-software rules in the countries of use, privacy, disclaimer wording). State no legal conclusion; list what I must confirm with a qualified person. End with the top 10 marketplace risks.
```

**Paste:** registry repo file list, Data contract v6


---

## 8. Phase 7: operational context components

Orders, pharmacy/MAR, scheduling/ADT and billing become specialised element sets and views on the **same repeating-row engine** (`case_rows`), with clinician-typed thresholds and export-only decoupling.

| Gap | Component | How it works |
|---|---|---|
| Orders (CPOE) | `care.orders` + Orders view | Timestamped order rows with status transitions; discontinue needs a reason; FHIR ServiceRequest / MedicationRequest |
| Pharmacy and MAR | `care.allergies` + MAR view | Allergies as a banner chip; MAR links active medication orders to administration logs (Given/Held/Refused + reason) |
| Scheduling and ADT | `care.adt_schedule` | Admissions, transfers, discharges, follow-ups as rows that update the ward board, banner and FHIR Encounter |
| Billing and charge capture | Charge Summary in Export | Decoupled from charting; extends verified codes with ICD-10/CPT; audited JSON/CSV export |

**Rules:** orders and ADT sets ship with zero doses, thresholds or rules; discontinuing never hard-deletes; doses are free text only; unverified billing codes are omitted.


### [ ] 48a. Orders 1: care.orders set and table view

**Goal:** The order set and an Orders view.

```text
Per Data contract v7: add care.orders to element-sets.js (kind care, direct true, quick order 6 short 'Orders', view type orders) with the repeat group in the contract; zero pre-filled doses or rules. Add an Orders table view grouped Active vs Completed/Discontinued. Status changes come in the next chunk.
```

**Paste:** Data contract v7, one existing care set from element-sets.js, the view dispatcher in enhancer.html


### [ ] 48b. Orders 2: status transitions and FHIR export

**Goal:** Complete or discontinue with a reason; export ServiceRequest/MedicationRequest.

```text
One-click Complete and Discontinue (reason prompt, required) as row patches with audit; never hard delete. buildBundle maps orders to ServiceRequest (MedicationRequest for Medication) with status mapping; free-text instructions exactly as typed. Test: discontinue needs a reason; row kept.
```

**Paste:** Data contract v7, orders view code, buildBundle

**Done when:** Discontinuing requires a reason and keeps the row; FHIR ServiceRequest/MedicationRequest exports.


### [ ] 49a. MAR 1: allergies and banner chip

**Goal:** care.allergies and a banner chip.

```text
Add care.allergies (repeat group per Data contract v7) and show active allergies as a persistent warning chip in the patient banner (display only). No auto-rules, no thresholds.
```

**Paste:** Data contract v7, banner renderer, one care set example


### [ ] 49b. MAR 2: MAR view

**Goal:** Administration grid linked to active medication orders.

```text
MAR view (view type mar) reading active Medication rows of care.orders and administration entries (Given, Held, Refused with reason, dose_given free text, given_by from the session, note) on a daily time grid. Doses are never calculated, converted, summed or auto-filled. If a typed allergy substance matches an active medication order text, show a non-blocking banner 'Review allergy list before administering'.
```

**Paste:** Data contract v7, orders view code, dailyGrid for reference

**Done when:** MAR doses are free text; Given/Held/Refused with reason; no calculation anywhere.


### [ ] 50a. ADT 1: care.adt_schedule, banner and ward board

**Goal:** ADT set feeding ward and bed.

```text
Add care.adt_schedule (per Data contract v7). The latest Admission or Ward Transfer row populates the patient's current ward and bed on the banner and ward board (overriding manual banner edits when present). Zero pre-filled data.
```

**Paste:** Data contract v7, banner and board renderers


### [ ] 50b. ADT 2: Schedule view and FHIR Encounter

**Goal:** Upcoming visits and Encounter export.

```text
Schedule view on the Patients screen listing upcoming Follow-up Scheduled and Outpatient Visit rows by date. buildBundle exports Encounter status (planned, in-progress, finished) and location from the ADT rows; a Discharge changes status without deleting clinical data.
```

**Paste:** Data contract v7, Patients screen code, buildBundle Encounter part


### [ ] 51a. Charge capture 1: ICD-10 and CPT in the codes tool

**Goal:** Extend verified codes with icd10 and cpt.

```text
Extend verified_codes and the Codes tool to allow systems icd10 and cpt next to snomed and loinc (validation patterns, server check constraint via migration 00N). Unverified codes stay out of every export. Tests.
```

**Paste:** Data contract v7, codes client functions, codes routes, verified_codes table


### [ ] 51b. Charge capture 2: Charge Summary export

**Goal:** Billing summary inside Export, separate from charting.

```text
Billing / Charge Summary sub-view inside Export only: verified Condition codes, completed procedure/order items and stay length from care.adt_schedule; reviewer can attach verified codes; export JSON/CSV as an audited event, formula-safe CSV. Billing codes never alter notes or trigger alerts.
```

**Paste:** Data contract v7, export tab code, audit.js

**Done when:** Unverified ICD-10/CPT are omitted; the export is audited.


### [ ] 52a. Phase 7 tests 1: orders

**Goal:** Safety tests for care.orders.

```text
Tests only. care.orders seed has zero pre-filled doses, thresholds or rules; discontinuing an order requires a reason; discontinuing never hard-deletes (the row stays, status Discontinued). Add new test blocks to safety.test.js and return only the new blocks, not the whole file.
```

**Paste:** safety.test.js (test helpers only), the orders server routes, element-sets.js orders entry


### [ ] 52b. Phase 7 tests 2: MAR and allergies

**Goal:** Safety tests for the MAR view and allergies.

```text
Tests only. MAR never computes or sums doses (dose_given stays free text); administration rows keep given_by from the session; care.allergies seed has no pre-filled entries. Add new test blocks to safety.test.js and return only the new blocks, not the whole file.
```

**Paste:** safety.test.js (test helpers only), the MAR and allergies server code, element-sets.js allergies entry


### [ ] 52c. Phase 7 tests 3: ADT and Encounter

**Goal:** Safety tests for care.adt_schedule.

```text
Tests only. care.adt_schedule seed has no pre-filled rows or rules; an ADT Discharge updates the Encounter status without deleting any clinical data. Add new test blocks to safety.test.js and return only the new blocks, not the whole file.
```

**Paste:** safety.test.js (test helpers only), the ADT server code, element-sets.js adt entry


### [ ] 52d. Phase 7 tests 4: charge capture

**Goal:** Safety tests for the Charge Summary export.

```text
Tests only. Charge Capture omits unverified ICD-10 and CPT codes; the export writes an audit row; billing codes never change notes or trigger alerts; CSV is formula-safe. Add new test blocks to safety.test.js and return only the new blocks, not the whole file.
```

**Paste:** safety.test.js (test helpers only), the Charge Summary export code, audit.js


---

## 9. Reference: data contracts

Paste the relevant contract into a chunk's chat when its **Paste** line asks for it. Contracts v1-v4 (schema, element sets, pathways and rules, direct elements) are built and stable; copy them from the original plan only if a chunk needs them.

### v5: Standalone EMR (chunks 26-41)

```text
Standalone EMR (v5). v2-v4 stay valid. Additions:

Server tables (PostgreSQL): users, patients, encounters, cases, element_sets, set_usage, audit_log, imports.
users: {id, name, username, password_hash, role:'admin|doctor|nurse|informatician|viewer', active, failed_logins, locked_until}
patients: {id, mrn(unique, server-generated), name, sex, date_of_birth|age_estimated, phone?, national_id?, active}
encounters: {id, patient_id, type:'admission|OPD|emergency', start, end, ward, bed, attending, status}
cases: {id, patient_id, encounter_id, narrative, applied, pathways, pinned, version, created_at, updated_at}
audit_log (append-only): {id, at, user_id, role, action, entity, entity_id, patient_id, before, after, reason, ip}

Rows (repeat groups) gain: entered_by, entered_at, version, status:'active|entered_in_error', error_reason.
Rules: every write carries the version last seen (409 on conflict, never last-write-wins); every write also writes an audit row in the same transaction; clinical data is never hard-deleted; verifiedBy and verifiedAt come from the session, not typed text; AI calls go through the server, are off by default, are de-identified and logged without content.
Storage in enhancer.html: window.Store with in-memory cache, ordered background write queue, per-entity version, serverStore (default) and localStore (Demo mode, synthetic data only). Repeat rows live in case_rows (append, patch with version, entered_in_error), not inside the case record. Also tables: case_values, verified_codes, code_bindings, cds_rules, protocols, alert_acks, user_prefs.
FHIR R4 is EXPORT ONLY. No SMART launch, no import from or write to another EMR.
```

### v6: Content lifecycle and marketplace (chunks 42-47)

```text
Content lifecycle and marketplace (v6). v2-v5 stay valid. Additions:

Element set / pathway additions (optional; seed and old local sets default to the values shown):
{"source":"seed|local|marketplace",            // default seed or local
 "readOnly":false,                             // true for marketplace; the SERVER refuses PATCH/DELETE, the UI only mirrors it
 "tier":"marketplace-verified|local-reviewed|local-draft",
 "forkedFrom":{"setId":"","version":1,"contentHash":""},
 "package":{"id":"","version":"1.2.0","publisher":"","license":"","contentHash":"sha256:","registryUrl":"","reviewRef":"PR url","signatureOk":true},
 "members":[{"setId":"","version":1,"contentHash":"","optional":false}]   // composite pathways pin version and hash; at most ONE nested pathway level; cycle check
}

Package file (what is published in the registry):
{"manifest":{"id":"","version":"semver","kind":"disease|care|template|pathway|rules","title":"","description":"","authors":[],"reviewers":[],
   "license":"","requires":[{"id":"","version":""}],"minAppVersion":"","createdAt":"ISO","references":[]},
 "content":{ ...element set(s), pathway or rules, same shapes as v2-v3... }}
contentHash = SHA-256 of canonical JSON of "content" (keys sorted, no whitespace).
Registry index.json: {"schema":1,"generatedAt":"ISO","keyId":"","packages":[{"id":"","version":"","kind":"","title":"","path":"","contentHash":"","withdrawn":false,"withdrawnReason":""}],"signature":"base64"}

Review request (server table review_requests; review_events is append-only):
{"id":"","setId":"","version":1,"authorId":"","status":"draft|submitted|in_review|changes_requested|approved|rejected",
 "checklist":{"schemaValid":true,"codesVerified":false,"noPatientData":true,"unitsStated":true,"noUncitedDoseOrThreshold":true,"decisionSupportWording":true,"duplicateChecked":false},
 "reviewerId":"","decidedAt":"ISO","comment":""}

AI draft provenance (stored with a draft): {"requestText":"","model":"","at":"ISO"}   // never patient values

Rules:
- reviewerId != authorId, enforced by the server; reviewer and decidedAt come from the session.
- Installed and approved content is read-only; to change it, fork (new setId, tier local-draft) or publish a new version.
- Rules and protocol bands inside a package arrive enabled:false; a local doctor enables them; the server stamps user and time; editing is still refused.
- A case keeps the version it started with; installs never auto-upgrade cases. A withdrawn version shows a warning on the case, Summary and Pathway tab; nothing is deleted.
- Packages never contain patient data. Any rule threshold, protocol band or dose-like text needs a references entry.
- Server fetches only from the allow-listed registry address, verifies index signature (pinned public key), package hash and lint before storing. File install uses the same checks.
- FHIR export Provenance lists package id, version, contentHash and tier for every applied set.
New role: informatician (reviews and approves content, installs packages; no charting rights; never reviews own drafts).
New tables: installed_packages, review_requests, review_events, package_cache. New localStorage key: none (server mode); Demo mode may hold 'drafts'.
```

### v7: Operational context components (chunks 48-52)

```text
Operational Context Components (v7). v2-v6 stay valid. Additions:

1. Order Element Set (care.orders, kind:'care', direct:true, quick:{order:6,short:'Orders'}, view:{type:'orders'}):
   Repeat group "orders": ord_time (datetime), ord_category (select: Medication|Lab|Imaging|Nursing|Consult|Diet), ord_item (text), ord_instructions (text, free text — never calculated), ord_priority (select: Routine|Urgent|STAT), ord_status (select: Draft|Active|Completed|Discontinued), ord_reason (text, required when Discontinued), ord_by (session user).
   FHIR export: ServiceRequest (or MedicationRequest for Medication category).

2. Pharmacy & MAR Context (care.allergies + view:{type:'mar'}):
   care.allergies repeat group "allergies": substance, reaction, severity, recorded_at (surfaced as persistent warning chip in patient banner).
   MAR view: links active Medication rows from care.orders to timestamped administration logs (Given|Held|Refused, dose_given as free text, given_by from session, note).

3. Scheduling & ADT Set (care.adt_schedule):
   Repeat group "adt": adt_time (datetime), adt_event (select: Admission|Ward Transfer|Discharge|Outpatient Visit|Follow-up Scheduled), adt_ward (text), adt_bed (text), adt_clinician (text), adt_status (select: Scheduled|Arrived|Completed|Cancelled).
   Updates Ward Board, Patient Banner ward/bed, Schedule view, and FHIR Encounter status/location.

4. Billing & Charge Capture (Export-only mapping inside Export tab):
   Extends verified_codes with icd10 and cpt. Aggregates verified Condition codes, completed Procedure/Order items, and encounter stay from care.adt_schedule into an audited Charge Summary JSON/CSV export.

Rules: zero pre-filled doses, thresholds, or rules; discontinuing requires a reason and never hard-deletes; doses remain 100% free text (never calculated or summed); billing codes never alter clinical notes or trigger alerts; unverified codes are omitted from exports.
```
