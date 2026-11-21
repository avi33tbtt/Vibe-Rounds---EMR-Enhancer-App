# EMR Enhancer App: Agent Protocol and Task Tracker

Repo: https://github.com/avi33tbtt/Vibe-Rounds---EMR-Enhancer-App/
Plan location: `emr-plan-chunks/` directory in the repo

---

## PROTOCOL (instructions for Claude)

Trigger phrase from the user: **"do next"**

When the user says "do next", do the following in order:

1. **FIRST, clone the repo, before doing anything else.** Use the add_repo tool if available, then clone, or `git pull` if already cloned. The user commits finished work to the repo between tasks, so always work from the latest version. Do not read the plan, pick a task or write any code until the clone/refresh has succeeded.
2. **Then read this file.** If the user attached an updated copy of this file, use that one as the source of truth. Otherwise use the copy in the workspace.
3. **Read the plan** in `emr-plan-chunks/`. Read every chunk file in order (sorted by filename). On the first run, populate the TASK LIST below with one row per chunk (or per task inside each chunk, if chunks contain multiple tasks).
4. **Pick the next task**: the first row with status `TODO` (or `IN PROGRESS` if a previous run was interrupted). Do only ONE task per "do next".
5. **Check dependencies**: the task may depend on files from earlier chunks. Read the existing code in the repo before writing anything, and match its conventions, structure, and naming.
6. **Implement the task** exactly as described in the plan chunk. Do not implement work from later chunks. If the plan is ambiguous or conflicts with existing code, make the most reasonable choice and record it in the Notes column and Decisions Log.
7. **Verify**: run any available build, lint, or tests. Fix failures before delivering.
8. **Deliver**:
   - Send ONLY the new or changed files (preserving their repo-relative paths) with SendUserFile.
   - Send the **updated copy of this file** with the task marked `DONE`, the date, files created or changed, and notes.
   - Give a 2 to 4 sentence summary: what was built, anything needing the user's attention, and what the next task is.
9. **Never** modify files in `emr-plan-chunks/`. Never mark a task DONE unless it was implemented and verified.
10. If the user says "do next" and all tasks are `DONE`, say the plan is complete and offer a final review or integration check.

Other commands the user may use:
- `status`: show the tracker summary, no implementation.
- `redo <task id>`: reimplement a task and update the tracker.
- `skip <task id>`: mark a task `SKIPPED` and move on.

Note for the user: workspace files may not persist between sessions. At the start of a new session, attach this file (and say "do next") so progress is not lost.

---

## STATUS LEGEND
`TODO` | `IN PROGRESS` | `DONE` | `BLOCKED` | `SKIPPED`

## TASK LIST

| ID | Plan chunk file | Task | Status | Date done | Files created/changed | Notes |
|----|-----------------|------|--------|-----------|-----------------------|-------|
| 0  | (all)           | Read plan and populate this table | DONE | 2026-11-21 | EMR_TASK_TRACKER.md | Plan read: 00-START-HERE, 01-core, 02-roadmap and 9 chunk files. |
| 1  | chunk-01-registration-screens.md | Registration screens (patients list, register form, real banner, encounters) | DONE | 2026-11-21 | package.json, package-lock.json, .gitignore, README.md, server.js, app.js, auth.js, audit.js, permissions.js, db.js, migrate.js, seed.js, migrations/001_users_sessions.sql, migrations/002_audit_log.sql, migrations/003_patients_encounters.sql, test/helpers.js, test/registration.test.js, test/ui.test.js, emr-enhancer.html | Server did not exist, so it was created here (user instruction): Express 5 + pg, scrypt passwords, cookie sessions, roles, append-only audit log, patients and encounters API. UI: Patients tab (sign-in, search by name/MRN, archived filter, register with server duplicate warning), real banner, encounter open/close on the Case screen. Verified: 13 tests pass against real PostgreSQL 16 (10 API, 3 page-in-jsdom), run 3x. Not verified: a real browser, and PostgreSQL versions other than 16. |
| 2  | chunk-02-code-registry.md | Code-system registry + `bindings[]` migration | DONE | 2026-11-21 | emr-enhancer.html, test/codes.test.js | Registry of 9 systems (CPT present but off), `bindings[]` on every field, per-binding verify with configurable terminology host and cached results, exporter emits every verified binding in `code.coding[]`, role-mismatch warning. Migration is a client-data migration (no SQL: the server stores no element sets). Verified: 11 new jsdom tests with a mocked terminology server, 24 of 24 total pass (twice); mutation checks confirmed the tests fail if unverified codes are exported or the display rule is dropped. NOT verified: live lookups against tx.fhir.org (not reachable from my sandbox). |
| 3  | chunk-03-create-screen.md | Unified create screen (SDC checkbox + code-system picker) | TODO | | | Task 2 done. This chunk also needs: multi-binding authoring in the create form (today it edits the first binding and keeps the rest), AI proposing bindings per ticked system (today one SNOMED/LOINC binding), and `sdc.js` extraction. |
| 4a | chunk-04-ai-browser.md | AI in the browser, minimal payload, off by default | DONE | 2026-11-21 | emr-enhancer.html | Done out of order (user chose 4a over blocked tasks 1 and 2). Verified with a jsdom test: off = nothing sent; preview contains the exact request body; payload keys are whitelist only; patient name, MRN, age, dates, values, narrative and notes never appear. Vignette field removed. Optional AI rank added. Existing saved settings with a key stay OFF until the switch is ticked. |
| 4b | chunk-04-ai-server.md | AI on the server | TODO | | | Roadmap lists server-side AI as later, but required by the go-live gate. Server now exists in this repo (task 1). |
| 5  | chunk-05-safety-tests.md | Safety-test pack + CI | TODO | | | Test setup exists (`npm test`, needs `TEST_DATABASE_URL`). CI workflow not yet written. |
| 6  | chunk-06-security.md | Security hardening | TODO | | | |
| 7  | chunk-07-backup-deploy.md | Backup, restore, deploy | TODO | | | |
| 8  | chunk-08-review-workflow.md | Review/approval workflow | TODO | | | |

## DECISIONS LOG

| Date | Task ID | Decision / assumption | Reason |
|------|---------|-----------------------|--------|
| 2026-11-21 | 0 | Two `chunk-04-*` files became tasks 4a (browser) and 4b (server). | Both exist in the plan; roadmap item 04 describes the browser version, with server AI deferred to before real use. |
| 2026-11-21 | 1 | Marked BLOCKED instead of building against guessed routes. | Chunk 01 says to read the server's patients API routes, which are absent from the repo. Building without them would invent an API. |
| 2026-11-21 | 1 | Did not start task 2 in the same run. | 00-START-HERE says chunks go in numeric order; task 2 also needs server migrations. |
| 2026-11-21 | 4a | Ran 4a before tasks 1 to 3, on the user's choice. | Tasks 1 and 2 need server code that is not in the repo; 4a only touches code that exists in emr-enhancer.html. |
| 2026-11-21 | 4a | Removed the Vignette field instead of relabelling it. | Chunk allows either; removal leaves no path for patient text. |
| 2026-11-21 | 4a | Generate is disabled when the AI switch is off, including demo mode (canned snake/DKA). | Chunk says AI buttons are hidden or disabled when off. Demo mode needs the switch ticked but sends nothing. |
| 2026-11-21 | 4a | Removed the automatic "Return ONLY JSON" retry in generate. | A retry is a second call and would need its own preview and click. The user now clicks Generate again. |
| 2026-11-21 | 4a | AI rank payload = diagnosis + applied set/pathway ids and titles + a candidate list of library item ids and titles (max 80). Diagnosis is typed at a prompt, not read from the case. | Ranking needs candidates to choose from; they are library content, not case fields. The case has no diagnosis field and the narrative is off-limits. |
| 2026-11-21 | 4a | Free-text "instructions" is not scanned or de-identified. | Chunk says not to add de-identification; the label now warns not to enter patient details. |

| 2026-11-21 | 1 | Created the server in this repo (flat root, Node + PostgreSQL) instead of waiting for a separate server repo. | User said the server code is not there and to create it as we proceed. |
| 2026-11-21 | 1 | Express 5.2.1 and pg 8.16.3, pinned exactly; only runtime deps. Passwords use Node's built-in scrypt; sessions are DB rows keyed by sha256 of the cookie token. | Minimal dependencies; raw tokens never stored. |
| 2026-11-21 | 1 | Roles: admin, doctor, nurse, viewer. Register and encounters: admin/doctor/nurse. Archive/restore: admin/doctor. Audit read: admin. | Plan names nurse and viewer only; archive and audit-read rules are my choice. Change in `permissions.js`. |
| 2026-11-21 | 1 | Duplicate rule: same MRN (case-insensitive) is a hard error; same name + date of birth is a warning that needs "Register anyway". | Plan says "duplicate warning, no merge UI". MRN must be unique to be an identifier. |
| 2026-11-21 | 1 | Patient fields: name, MRN, date of birth, sex (M/F/O/U). Age is computed on the server from DOB. | Banner needs age/sex; storing DOB avoids a stale age. |
| 2026-11-21 | 1 | A case stores only `patientId`; name/MRN/age are read from the server and not copied into localStorage. Cases themselves are still browser-side. | Keeps identity server-owned; case storage moves server-side in a later chunk. |
| 2026-11-21 | 1 | Encounter rules enforced by partial unique indexes: one open per bed (case-insensitive) and one open per patient. Archiving a patient with an open encounter is refused. | "One open encounter per bed shown as an error" plus data integrity. |
| 2026-11-21 | 1 | Audit rows written in the same transaction as the action. Search audits counts only, not the search text. Denied attempts and failed logins are audited. | Audit must match what happened; avoid copying PHI into the log. |
| 2026-11-21 | 1 | Mutating API calls require an `X-EMR: 1` header, on top of SameSite=Strict cookies. | Basic CSRF guard; full hardening is chunk 06. |
| 2026-11-21 | 1 | FHIR `Patient` export (`patientRes` in the HTML) was NOT changed; for a linked case it still uses the demo fields/synthetic MRN. | Chunk 01 says not to touch codes; this belongs with a later chunk. |
| 2026-11-21 | 1 | No audit-log viewer screen. `GET /api/audit` exists (admin only). | Not in the chunk's build list. |
| 2026-11-21 | 2 | No SQL migration was written. Element sets live in the browser (localStorage), and the server has no table holding bindings. The "bindings[] migration" is `migrateFields/migrateSet` in the page: runs on load, idempotent, lossless (a field with both `coding` and `bindings` keeps both, duplicates not doubled, version history migrated too), and the original `vr_traj` is copied once to `vr_traj_pre_bindings`. Server migration numbers 001 to 003 are unchanged. | Writing a SQL migration for a table that does not exist would be invented work. A server-side element-set table belongs to a later chunk. |
| 2026-11-21 | 2 | Registry lives inline in the HTML (single-file demo), not a shared module. | Keeps the demo working when opened alone. Chunk 03 already plans the shared `sdc.js` extraction; registry can move with it. |
| 2026-11-21 | 2 | Verifiers configured only for SNOMED CT, LOINC and RxNorm (FHIR `$lookup`, host from `CFG.txHost` / localStorage `vr_cfg`). ICD-10, ICD-11, ATC, UCUM, Local and CPT have no verifier and always stay unverified. | I could not confirm which systems tx.fhir.org serves, so I did not claim verification I cannot show. Add a verifier per system once checked. |
| 2026-11-21 | 2 | Stricter display rule: a cached verified code now counts as verified only while the binding's display still matches the server display. Codes previously "verified" with a different display (for example manual adds) will show unverified. | Core rule: verified = code exists AND display matches. The old code skipped the display check once cached. |
| 2026-11-21 | 2 | Manual "add verified code" only accepts systems that have a verifier. | A system without a verifier cannot be verified, even by hand. |
| 2026-11-21 | 2 | Export: only verified bindings become `Coding` (deduplicated). `code.text` stays the field label; unverified/local codes are not exported at all, not even as text. | Chunk says they stay in `code.text`; putting raw codes into display text would pollute it. Tell me if you want them appended. |
| 2026-11-21 | 2 | Role guard: each system lists field kinds it suits (for example ICD-10 not on numeric fields). Warning only, shown in the codes table, generated preview and create form. | Role lists are my judgement; edit `CODESYS[].roles`. |
| 2026-11-21 | 2 | Create form still shows one binding row (the first one) but its system list now comes from the registry; extra bindings are kept and a "+N more kept" note is shown. | Chunk says no UI beyond what verification needs; multi-binding authoring is chunk 03. Two bindings can currently come from SDC import (all `item.code` entries of known systems) or stored data. |
| 2026-11-21 | 2 | Codes table now has one row per binding; the verified percentage counts bindings (fields with none count as missing). SDC import now binds every known, enabled system in `item.code` (was first SNOMED/LOINC only); CPT and unknown systems go to `otherCodes`. | Needed so a field can carry two or more bindings. |

## OPEN QUESTIONS / BLOCKERS

- **Server code (resolved 2026-11-21):** now lives in this repo's root, created in task 1. The roadmap's rules engine, alerts, flowsheets and conflict screen are not built; no chunk asks for them yet. If they exist elsewhere, say so before chunk 02 or later reads them.
- **Repo layout:** your last commit put `001_*.sql`, `002_*.sql`, `003_*.sql`, `helpers.js`, `registration.test.js`, `ui.test.js` and `_.gitignore` at the repo root. The code expects `migrations/` and `test/` folders and `.gitignore`, and will not run as committed. Move them into place (see the paths in this tracker). Files in this delivery use the correct repo-relative paths; please keep the folders when copying.
- **Attached tracker was stale:** the copy you attached still showed task 1 as BLOCKED, so I used the newer copy from the repo (task 1 DONE). Please keep attaching the copy from this delivery.
- **Please check before relying on task 1:** roles and the duplicate rule (see Decisions Log) are my assumptions. Seed users are demo accounts; run `npm run seed` with your own `SEED_PASSWORD`.
- 4a limit (from the chunk): browser keys can be read by anyone using that browser. Server-side AI (task 4b) is still required by the go-live gate.
- Alternative: if registration screens should be built into the demo HTML against a stubbed API, say so and I'll record that as a decision.
