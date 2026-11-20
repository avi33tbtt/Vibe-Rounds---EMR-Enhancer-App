# Reference: status, manual jobs, phase map (sections 10, 11, 14, 15)

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 10. What is built so far

*Source: the three old plan files. **Test count, measured 20 Nov 2026:** `npm test` on GitHub commit `86d8259` (PostgreSQL 16, clean clone) gives **285 tests, 285 pass, 0 fail**. This does not include the five orphan test files (`sum-by-type`, `board-no-reading`, `handover-data`, `handover-view`, `handover-print`); V0a adds them, so write the new total here after V0a. If your local copy is newer than `86d8259`, re-run `npm test` and replace the number.*

**Prototype, chunks 1-25G (single file `enhancer.html`, localStorage).** Skeleton, AI schema generation, dynamic forms, code validation, FHIR bundle, analytics, DKA demo; element-set registry and trajectories; direct elements (quick bar, fever chart, daily insulin grid, vitals flowsheet, HbA1c due badge); pathways (`pathway.dka`, `.snakebite`, `.fever_monitoring`, member lists only); rules and AI-drafted rules (approved by a clinician, never auto); EMR shell (banner, Summary, Flowsheets, Notes with sign and amend, Pathway, Alerts, Export, Patients list, shortcuts).

**Server, chunks 26-28.** Express + PostgreSQL 16 in the repo root, numbered migrations (`001_core.sql` to `008_changes.sql`), REST API in `api.js` with strict validation, `seed.js` loading `element-sets.js` as read-only seed rows, `API.md`. Repeat readings live in `case_rows` (append, patch with version, entered-in-error with a reason, max 500 per group).

**Client store, chunks 29-31.** `store.js` (`window.Store`): cache-first reads, ordered write queue, per-entity versions, save-status text, Demo mode. Reference data (sets with versions, rules, protocols, usage, codes) through the API. Import from this browser (dry run, report, all-or-nothing). Conflict screen (three-way compare, never overwrites an entered-in-error row or a signed note).

**Login and roles, chunk 32.** scrypt passwords, cookie sessions (idle 30 min, absolute 12 h), lockout after 5 failures, CSRF token, roles (viewer, nurse, doctor, informatician, admin) in one table `permissions.js`, role-by-route matrix test, first-admin script, login screen, role-hidden controls, users screen, forced password change, last-admin protection.

**Audit, chunk 33.** Append-only `audit_log`, audit screen and CSV (formula-safe, export itself audited), version history per row and value, history drawer, view-audit rows (once per user per case per 10 min), sign-in events.

**Patients, chunk 34.** Patients and encounters on the server (MRN with check digit, duplicate check, merge via `mergedInto`, one open encounter per ward and bed, no deletes), `Store.patients`, find/register dialog, encounter start and case link, banner and Patients list on real data (`patientView(c)`), one-time demo-patient migration, real FHIR Patient and Encounter in an audited export.

**Rules on the server, chunk 35.** Server-stamped approval (a typed approver is ignored; edit resets approval), alert acknowledgements as records (`alert_acks`), "Rules in force" screen and CSV.

**AI on the server, chunk 36.** `llm.js`, off by default, admin switch, de-identification, a confirm dialog showing the exact text sent, per-user limit, audit row per call with no content.

**Wards, chunk 37.**
- 37a: `GET /cases/:id/changes` and live refresh by polling (10-15 s, paused when the tab is hidden, never overwrites a field being typed).
- 37b: seed set `care.intake_output`; "Entered by" initials in flowsheets.
- 37c1-c2: shift sum on the I/O flowsheet (`sumByType`, `ioSum`). **Hand-coded; re-homed in V4.**
- 37c3-c5: ward board (`boardRow`, ward filter, "No reading for N min" only from an approved `minutes_since_gt` rule). **Fixed screen; re-homed in V5.**
- 37d1-d3: handover data, view and A4 print layout (`handoverData`, Handover tab). **Fixed section list; re-homed in V6.**

**Not built yet:** everything in Part IV: Phases V, R, F, 5 (rest), 6, A, M, S, O, 7, H and Z. Section 11 lists what the repo check found.

## 11. What the repo check found

*Re-checked on 20 Nov 2026 against the public repo (commit `79bc8c8`, "5th commit"). I read the code; I did not run `npm test` or open the app.*

1. **Hand-named code (the reason for Phase V).**
   - `enhancer.html` around lines 1507-1511: `sumByType` reads `r.io_time`, `r.io_volume`, `r.io_type`; `ioSum` returns nothing unless `s.setId=='care.intake_output'`.
   - Around line 1853: `boardRow`; line 1860: `handoverData` (fixed list of five sections); line 1893: `renderPatients` builds the board; line 187 and 459: the Handover button and pane are fixed HTML; line 981: the tab dispatcher calls `handoverRender()` by name.
   - Around lines 2418-2435: `ana()` reads `r.temp` directly (analytics, handled in 38 and decision 16).
2. **Five test files are not in `npm test`:** `sum-by-type.test.js`, `board-no-reading.test.js`, `handover-data.test.js`, `handover-view.test.js`, `handover-print.test.js`. They exist but the `test` script in `package.json` does not run them. Fixed in V0a.
3. `env.example` is already gone; only `.env.example` remains.
4. This plan is in the repo root as `emr-enhancer-final-plan.md`. The three old plan files now sit in a `plan/` folder (optional: `git rm -r plan`). Nothing in code reads them. `plan/` is a folder in a repo whose rule is "no folders", so deleting it is tidier.
5. Seed pathways are member lists only with `rules:[]`; seed sets have zero rules and thresholds. This is the pattern Phase V keeps.
6. **Re-check for v3 (clone at commit `eacd1bd`, "5th commit").** `views.js`, `VIEWS.md`, `elements.js` and any Phase V code do **not** exist yet, so nothing in V, R, F, A, M, S or O is built. Section 6.3 lists what the repo already has for the FHIR spine (`fhir` blocks on numeric fields, `verified_codes`, `code_bindings`, `case_rows` with `row_time` and `status`, `buildBundle`). Because analytics now live in the Analytics app, `ana()` (about lines 2418-2435) is retired by F9 instead of being ported. Section 11 item 1 line numbers come from the earlier commit `79bc8c8`; re-run the V0b grep before relying on them.

## 14. Manual jobs (not tasks)

- [ ] Force a conflict on one row in two browsers; confirm the side-by-side screen.
- [ ] Idle a session out with an unsent reading; sign in again; confirm it is sent.
- [ ] As admin run Settings > Import from this browser; confirm a doctor does not see it.
- [x] `env.example` removed (only `.env.example` remains).
- [ ] Optional: `git rm -r plan` (the three old plan files).
- [ ] After F7: export a de-identified bundle from synthetic EMR data, import it into VibeRounds Analytics as a batch (data-use box ticked, import password set), and run **Data quality and completeness** in V1, V2 and V4. Note which analytics return rows and which say "needs a code".
- [ ] After F3: read the coverage report for each seed set against the example analytic in 7.1 and confirm every line shows its basis.
- [ ] After D5: open each demo patient on the ward board, handover and flowsheets and read D-09's history drawer; confirm everything is plainly marked synthetic.
- [ ] Optional, for the code demonstration: verify codes for a few demo elements in the official SNOMED CT and LOINC browsers and attach them on the demo database only; note which analytics change from "needs a code" to ready.
- [ ] After P5b: export a form coded in ICD and one coded in SNOMED CT; confirm the Analytics app shows the ICD one as uncoded and the SNOMED one as coded.
- [ ] After Gate 1: build one real specialty template (for example obstetrics) entirely as data; note every place it needed a new view type. That list is the evidence for or against the "any speciality" claim.
- [ ] At each gate in 15.3: read the wording on screen once and confirm nothing reads as a judgement of care.

## 15. Build order, gates and phase map

### 15.1 The journey and who builds what

| Step | Fixed code | Composable content | Phase |
|---|---|---|---|
| 1. Registration | MRN, duplicates, merge, one encounter per bed (done, chunk 34) | none; **provides** a fixed `core.registration` element list (F6) | done, F6 |
| 2. Recording | version pin, row rules, audit (done) | sets, pathways, templates | V, R, F |
| 3. Summary | alerts and acknowledgement (done) | derived cards, layouts | S |
| 4. Orders | status rules on the server | order sets, engine data | O |
| 5. Analytics | the **Analytics app**: engine, masking, audit | analytic definitions, installed there | F (export), A (in the Analytics repo), M |

### 15.2 Phase map

| Phase | What | Repo | Needs first |
|---|---|---|---|
| V (16) | EMR views become pathways | EMR | nothing |
| R (17) | role-based access for every element | EMR | V1a |
| F (18) | FHIR element spine: roles, coverage, projection, export | EMR | V4 for F0 to F3; Phase V for the rest |
| 5 rest (19) | last-handover time | EMR | V6 |
| 6 (20) | package format, tiers, signed index, marketplace client for the EMR | EMR and registry | F3, R9 |
| A (21) | analytics: marketplace client, definitions, closed kinds, roles | **Analytics app** | F7, M1, registry signing (45c1) |
| M (22) | matching marketplace: index provides/requires, pickers | EMR and registry | F3, Phase 6 |
| S (23) | Summary: derived cards, layouts | EMR | F3, F4 |
| O (24) | Orders engine | EMR | S, Gate 3 |
| 7 (25) | allergies, MAR, ADT, charge summary | EMR | V8, O |
| H (26) | tests, security, deploy | both | as each phase lands |
| D (27) | ten synthetic demo patients with longitudinal records, loaders, expected results | EMR (and one check in the Analytics app) | V for D0 to D5; Phase 7 and O for D6; F7 and A for D7 |
| P (28) | free coding choice per field, local code lists, profile labels and filter, export readiness | EMR and registry | P1 to P5 after F3; P6 to P13 after Phase M and F7 |
| Z (29) | publish the composable library, clean-install tests, acceptance | registry and both apps | everything above |

### 15.4 Retired and moved tasks

| Old item | What happened |
|---|---|
| 38a0 to 38a5, 38b1, 38b2, 38b5 (analytics in the EMR) | not built; analytics live in the Analytics app (Phase A) |
| 38b3, 38b4 (de-identified exports) | became F7 |
| `ana()` in `enhancer.html` | retired by F9 |
| 48a0 (`entryRoles`) | replaced by the `access` block (Phase R) |
| 48b1 status change as client-only `actions` | status rules now enforced on the server (Phase O); `actions` stays as the button layer |
| `emr-enhancer-build-plan.html`, `emr-enhancer-remaining-plan.md`, `emr-enhancer-micro-plan.md` | replaced by this file |
