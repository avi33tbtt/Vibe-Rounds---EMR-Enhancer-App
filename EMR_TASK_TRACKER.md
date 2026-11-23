# EMR Enhancer App: Agent Protocol and Task Tracker (slim)

Repo: https://github.com/avi33tbtt/Vibe-Rounds---EMR-Enhancer-App/
Plan files: `emr-plan-chunks/`. Old decisions and long delivery notes: `DECISIONS.md` (do not read unless needed).

---

## PROTOCOL (instructions for Claude)

Trigger phrase: **"do next"**. Keep the session small: this protocol is written for a free-tier limit.

1. **Refresh the repo first**: `git clone --depth 1` (or `git pull`). Work from the latest version. Do not pick a task or write code before this succeeds.
2. **Read only these three things**: this file, `emr-plan-chunks/01-core.md`, and the ONE chunk file named in the next task's "Plan file" column. Do not read other plan files, `DECISIONS.md`, or whole big source files. For `emr-enhancer.html` (1500+ lines) use `grep -n` and `sed -n` ranges for the parts the chunk names.
3. **Pick the next task**: first row with status `TODO` (or `IN PROGRESS`). ONE task per "do next".
4. **Size check before coding**: if the task cannot be finished within its "Size guard" (files touched, lines added), STOP, do not half-build. Tell the user which part to split off, and add it as a new row (for example `6d-1`). Do not implement later tasks.
5. **Match existing conventions.** If the plan is ambiguous, choose the most reasonable option and put it in `DECISIONS.md` (max 3 rows) and mention it in the summary.
6. **Verify, lightly**: run `npm test` ONCE (all must pass; known `test.todo` items are fine). Run the new tests twice only if they involve concurrency or timing. Do at most 3 deliberate-breakage checks (undo a fix, see the new test fail, restore). Do not run suites 3x or 5x.
7. **Deliver**: send ONLY new or changed files with their repo-relative paths, plus the updated tracker (status `DONE`, date, files, ONE line of notes, 200 characters max). Summary: 2 to 4 sentences: what was built, what needs the user's attention, what the next task is.
8. **Never** edit existing files in `emr-plan-chunks/`. Never mark `DONE` unless implemented and verified. If a `test.todo` listed in a chunk file becomes real, convert it.
9. If everything is `DONE`, say the plan is complete and offer a final review.

Other commands: `status` (summary only), `redo <id>`, `skip <id>`, `split <id>` (propose smaller pieces, no code).

If a chat ends midway (limit hit): nothing is marked `DONE` until verified, so open a new chat, attach this file and say "do next". The sub-chunk restarts.

---

**Added 2026-11-22 (plan extension).** Rows B0 to B5 extend the plan toward the book's Chapter 5 (clinical context on the server). Rules that apply to every new row: use the next free migration number (never a fixed one); every new route updates the permission matrix and audit tests on purpose; every new table gets only the grants `emr_app` needs and no DELETE/TRUNCATE on clinical data. The CCIS app (spec, schemas, validator, runtime, analytics, cohorts) is a SEPARATE repo with its own tracker: https://github.com/avi33tbtt/Vibe-Rounds---CCIS . Only B5 (context envelope) and D8b (cohort exporter) stay here. The old Track C/D rows are marked MOVED; their chunk files in `emr-plan-chunks/` are left in place as reference and are not to be built here.

---

**Added 2026-11-23 (demo track and roadmap).** Rows B5a to DM4 build one end-to-end demo slice with CCIS; rows R0 to R8 are the full advanced-EMR roadmap and stay `LOCKED` until DM4 is `DONE` and the user says **"start roadmap"**. Read `emr-plan-chunks/04-demo-and-roadmap.md` for the boundary rules, global order across both repos and R-row briefs. B5 is replaced by B5a and B5b because CCIS row 1.4 fixed the envelope schema. Every new route updates the permission matrix and audit tests on purpose.

---

**Added 2026-11-23 (small-row split).** DM3, DM4, D8b and every R row are now split into small sub-rows, sized for one free-tier session each. R sub-rows have no chunk file yet: when you say "start roadmap" and a row is next, its first step is to write its chunk file (docs only, from the R brief in `04-demo-and-roadmap.md`, stating the context impact), then build. If a sub-row still looks too big, STOP and split it again.

---

## STATUS LEGEND
`TODO` | `IN PROGRESS` | `DONE` | `BLOCKED` | `SKIPPED` | `SPLIT` (replaced by sub-tasks) | `MOVED` (now tracked in the CCIS repo) | `LOCKED` (not yet started; do not pick)

## TASK LIST

| ID | Plan file | Task | Status | Date | Size guard | Notes (one line) |
|----|-----------|------|--------|------|------------|------------------|
| 0 | (all) | Read plan, populate table | DONE | 2026-11-21 |  |  |
| 1 | chunk-01-registration-screens.md | Registration screens | DONE | 2026-11-21 |  | Server, patients, encounters, audit, roles created. |
| 2 | chunk-02-code-registry.md | Code-system registry + bindings[] | DONE | 2026-11-21 |  | 9 systems; verified-only export. Live tx.fhir.org not tried. |
| 3 | chunk-03-create-screen.md | Unified create screen | DONE | 2026-11-21 |  | SDC checkbox, code picker, `sdc.js`. |
| 4a | chunk-04-ai-browser.md | AI in browser, minimal payload | DONE | 2026-11-21 |  | Superseded by 4b (no key in browser). |
| 4b | chunk-04-ai-server.md | AI on the server | DONE | 2026-11-22 |  | Mock provider only; real provider call not tried. |
| 5 | chunk-05-safety-tests.md | Safety-test pack + CI | DONE | 2026-11-22 |  | 92 tests (87 pass, 5 todo). CI workflow never run on GitHub yet. |
| 6 | chunk-06-security.md | Security hardening (original) | SPLIT |  |  | Replaced by 6a to 6e. |
| 6a | chunk-06a-escaping.md | Escape all user text in the page | DONE | 2026-11-22 | page + 1 test file | emr-enhancer.html, test/safety-escaping.test.js, DECISIONS.md. Shared escaper + jsA for handler ids at ~45 sites; 5 hostile-string tests. 97 tests (92 pass, 5 todo). |
| 6b | chunk-06b-headers-cookies-ratelimit.md | Headers, Secure cookie, rate limits | DONE | 2026-11-22 | app.js, auth.js + 1 test | app.js, auth.js, ratelimit.js, test/safety-hardening.test.js, env.txt, DECISIONS.md. Headers, Secure cookie (HTTPS=1), 429 limits on login and writes, audited once per window. 106 tests (101 pass, 5 todo). Per-process limiter. |
| 6c | chunk-06c-db-role.md | Restricted DB role, no DELETE/TRUNCATE | DONE | 2026-11-22 | 1 migration + config + tests | 005_app_role.sql, MIGRATE_DATABASE_URL, tests run as emr_app, TRUNCATE todo now real. Not tried on Render. |
| 6d | chunk-06d-csp.md | Content-Security-Policy (93 inline handlers) | SPLIT |  |  | Replaced by 6d-1, 6d-2a, 6d-2b, 6d-2c. Option A (delegated listener) chosen 2026-11-22. |
| 6d-1 | chunk-06d1-csp-header.md | CSP header + per-response nonce (server half) | DONE | 2026-11-22 | app.js + serve code + 1 test | app.js, env.txt, test/safety-csp.test.js, test/safety-hardening.test.js, DECISIONS.md. Nonce per response; script-src-attr unsafe-inline is temporary (pinned test + todo for 6d-2c). |
| 6d-2a | chunk-06d2-handlers.md | Delegated listener + convert handlers 1 to 30 | DONE | 2026-11-22 | about 30 handlers | emr-enhancer.html, test/safety-handlers.test.js. ACT table + data-act/data-arg/data-ev; 63 inline handlers left (ratchet test). |
| 6d-2b | chunk-06d2-handlers.md | Convert handlers 31 to 62 | DONE | 2026-11-22 | about 30 handlers | emr-enhancer.html, test/safety-handlers.test.js, test/safety-escaping.test.js. 32 converted (ids via data-arg, no jsA); 31 inline left, ratchet set to 31. |
| 6d-2c | chunk-06d2-handlers.md | Convert the rest; remove unsafe-hashes; zero inline handlers | DONE | 2026-11-22 | about 30 handlers | app.js, emr-enhancer.html, 4 test files. 31 converted; page has 0 inline handlers; script-src-attr 'none'; real-Chrome test shows an injected onclick is blocked. Closes 6d. |
| 6e | chunk-06e-policy-docs.md | Retention, access, consent notes | DONE | 2026-11-22 | docs only | docs/POLICY.md. Labels BUILT/DECISION/PLACEHOLDER; no patient export route exists yet; scan template added (scan after 7a). Legal points left open. |
| 7 | chunk-07-backup-deploy.md | Backup, restore, deploy (original) | SPLIT |  |  | Replaced by 7a to 7d. |
| 7a | chunk-07a-container-tls.md | Container + TLS | DONE | 2026-11-22 | Dockerfile, compose, proxy config | Run on Windows Docker Desktop: build, migrate, db-role, app healthy, seed, curl -k https://localhost/ OK. Seed does not reset passwords (wipe with down -v). |
| 7b | chunk-07b-encrypted-backups.md | Encrypted scheduled backups | DONE | 2026-11-22 | 1 script + schedule | scripts/backup.sh, compose backup profile, safety-backup test. age + public key; tested on real PG; Docker service not run yet. |
| 7c | chunk-07c-restore-test.md | Restore script + recorded restore | DONE | 2026-11-22 | 1 script + 1 doc | restore.sh, verify-restore.sh, safety-restore test, docs/RESTORE-TEST.md. Run 2 reported done by owner 2026-11-22; Run 2 table not yet filled in. |
| 7d | chunk-07d-downtime-golive-docs.md | Downtime page + go-live checklist | DONE | 2026-11-22 | docs only | docs/DOWNTIME.md, docs/GO-LIVE-CHECKLIST.md. All 7 gate items have evidence or owner; none ticked. Placeholders to fill. |
| 8 | chunk-08-review-workflow.md | Review/approval workflow (original) | SPLIT |  |  | Replaced by 8a to 8f. |
| 8a | chunk-08a-lint.md | Shared lint module | DONE | 2026-11-22 | 1 new module + 1 test | lint.js, test/lint.test.js, DECISIONS.md. 5 rules + needsTwoReviewers; 27 tests incl. seed-set check. Full suite 142 pass, 4 todo. Page loads lint.js in 8d. |
| 8e | chunk-08e-signer-from-session.md | Signer/author from session (core-rule gap) | DONE | 2026-11-22 | page + tests | emr-enhancer.html, test/safety-data.test.js, test/safety-escaping.test.js. Signer, amender and FHIR author = signed-in user; no typed box; vr_user purged. 147 pass, 3 todo. Notes still in browser. |
| 8f | chunk-08f-entered-in-error.md | No hard delete of observation rows | DONE | 2026-11-22 | page + tests | emr-enhancer.html, test/safety-data.test.js, test/safety-escaping.test.js. Rows marked entered_in_error (session user, time), kept, hidden by default, exported as entered-in-error. 148 pass, 2 todo. |
| | | **TRACK B: canonical clinical context model on the server (book Ch5)** | | | | |
| B0 | chunk-B0-baseline-contract.md | Baseline contract: prototype objects to entities (docs only) | DONE | 2026-11-22 | 1 markdown file | CLINICAL_CONTEXT_MODEL.md. 29 objects mapped; 6 decisions D1-D6 await your review before B1a. Table names are proposals (Ch5 text not in repo). Found: field ids clash across sets. |
| B1a | chunk-B1a-cases-server.md | Persistent cases: migration, API, permissions | DONE | 2026-11-22 | 1 migration, 1 routes file, tests | 006_cases.sql, cases.js, app.js, permissions.js, 3 test files, DECISIONS.md. 7 routes; DB-enforced same-patient link. 162 tests (157 pass, 2 todo). B0 names differ: see DECISIONS. |
| B1b | chunk-B1b-cases-page.md | Cases in the page via storage adapter | SPLIT | 2026-11-22 |  | Replaced by B1b-1 and B1b-2: item 3 (audited import) needs a server route; interim data rule undecided. Nothing built. |
| B1b-1 | chunk-B1b-cases-page.md | Storage adapter (server/local); signed-in case list, create, open, title/status, narrative; 409 screen | DONE | 2026-11-22 | page + 1 test file | emr-enhancer.html, test/storage-adapter.test.js, test/safety-data.test.js, DECISIONS.md. Server/local adapter, 409 screen, vr_interim. 170 tests (165 pass, 2 todo, 3 skipped: no Chrome). |
| B1b-2 | chunk-B1b-cases-page.md | Import local demo cases (explicit action, audited as an import) | DONE | 2026-11-22 | 1 route in cases.js, matrix, page button, 1 test file | cases.js, emr-enhancer.html, test/case-import.test.js, test/safety-routes.test.js, DECISIONS.md. Import route + panel; sends title and narrative only. 175 tests (170 pass, 2 todo, 3 skipped). |
| B2a | chunk-B2a-element-sets-server.md | Versioned element sets (server) | DONE | 2026-11-22 | 1 migration, 1 routes file, tests | sets.js, 007_element_sets.sql, app.js, permissions.js, 4 test files, DECISIONS.md. 7 routes; publish admin-only (no informatician role). 188 tests (183 pass, 2 todo, 3 skipped). |
| B2b | chunk-B2b-element-sets-page.md | Library + case pinning use server versions | SPLIT | 2026-11-22 |  | Replaced by B2b-1 and B2b-2. Pin needs a migration + case route change (outside page + 1 test) and would be thrown away in B3a. Nothing built. |
| B2b-1 | chunk-B2b-element-sets-page.md | Library from server; one-time demo-library import as published v1 (items 1) | DONE | 2026-11-22 | page + 1 test file | emr-enhancer.html, library-page test, 4 tests edited, DECISIONS.md. Server library, admin imports 4 demo sets as v1, read-only. 195 tests (190 pass, 2 todo, 3 skipped). Pin is B3. |
| B2b-2 | chunk-B2b-element-sets-page.md | Pin exact version, visible diff, explicit update, export uses pin (items 2, 3) | SKIPPED | 2026-11-22 | n/a | Merged into B3a/B3b (case_applied_sets stores the version id). Do not run separately. |
| 8b | chunk-08b-submit-snapshot.md | Server: submit set for review (snapshot) | DONE | 2026-11-22 | 1 migration, routes, tests | 008 migration, review.js, matrix+audit tests. Submit draft version to in_review, lint gate, DB-frozen. Codes fail lint (no server verifier). 204 tests (202 pass, 2 todo). |
| 8c | chunk-08c-review-rules.md | Reviewer rules + frozen approved version | DONE | 2026-11-22 | routes, trigger, tests | 009 migration, review.js, seed, tests. Role informatician; no self-review; 2 reviewers if flagged; DB-enforced. Publish not tied to review yet (8c-2). 215 tests (213 pass, 2 todo). |
| 8c-2 | chunk-08c-review-rules.md | Publish only an approved (`reviewed`) version; demo import goes through review | DONE | 2026-11-22 | routes + sets tests + page import | 010 migration, sets.js, permissions.js, page, helpers + 6 tests, DECISIONS.md. DB + route refuse unreviewed publish; import submits, no codes. 227 tests (225 pass, 2 todo). |
| X1 | (requested) | OPD and IPD sets + one-click pathways (OPD, IPD admission, IPD discharge) | DONE | 2026-11-22 | page + tests | emr-enhancer.html, test/clinic-pathways.test.js, test/library-page.test.js. 4 sets, 3 pathways, Start buttons, Suggest; demo import now 9 sets. No doses/codes. 220 tests (218 pass, 2 todo). |
| 8d | chunk-08d-review-ui.md | Review screens + tier badges | SPLIT | 2026-11-22 |  | Replaced by 8d-1 and 8d-2: page edit would pass 200 lines (queue + status list + submit + badges). Nothing built. |
| 8d-1 | chunk-08d-review-ui.md | Reviewer queue screen (item 3): list, lint findings, approve/reject with reason, who/when from the server; hidden from nurse/viewer | DONE | 2026-11-22 | page + 1 test file | emr-enhancer.html, test/review-page.test.js. Review tab for informatician only; queue, lint, reviews, approve/reject. 233 tests (231 pass, 2 todo). |
| 8d-2 | chunk-08d-review-ui.md | My set versions: status badges (`draft`, `in review`, `approved`, `published`) + Submit for review with lint findings (items 1, 2, 4) | DONE | 2026-11-22 | page + 1 test file | emr-enhancer.html, test/versions-page.test.js. Library tab lists all server versions with local draft/reviewed badges; Submit shows lint findings. No draft editor. 237 tests (235 pass, 2 todo). |
| B2r | chunk-B2r-review-on-versions.md | Re-point review workflow at server versions | SKIPPED | 2026-11-22 | n/a | Merged into 8b to 8d by the reorder; do not run separately. |
| B3a | chunk-B3a-observations-server.md | Applied sets, observations, events (server) | DONE | 2026-11-23 | 1 migration, 1 routes file, tests | 011_observations.sql, observations.js, app.js, 4 test files, DECISIONS.md. 6 routes; pins, append-only values, DB-enforced. 246 tests (244 pass, 2 todo). Page is B3b. |
| B3b | chunk-B3b-observations-page.md | Values and trajectories via server; entered-in-error UI | SPLIT | 2026-11-23 |  | Replaced by B3b-1 to B3b-3: pins, values and the error/export work each need about 200+ page lines (values keyed per set, type mapping, version diff). Nothing built. |
| B3b-1 | chunk-B3b-observations-page.md | Pins in the page: apply, pathway apply and remove (withdraw) via server; exact pinned version shown; version diff and explicit update (B2b-2 items) | DONE | 2026-11-23 | page + 1 test file | emr-enhancer.html, test/pins-page.test.js, 4 tests edited, DECISIONS.md. Pins, pathway apply, withdraw, diff + update via server; none in vr_interim. 251 tests (246 pass, 2 todo, 3 skipped). |
| B3b-2 | chunk-B3b-observations-page.md | Values in the page: scalar and repeat rows via server (typed, per set and field); trajectories by effective time, recorded time shown; no values in localStorage | DONE | 2026-11-23 | page + 1 test file | emr-enhancer.html, test/values-page.test.js, 2 tests edited, DECISIONS.md. Values per set via server; blank never sent, Unknown button; none in vr_interim. 259 tests (254 pass, 2 todo, 3 skipped). |
| B3b-3 | chunk-B3b-observations-page.md | Entered-in-error via server (struck-through row with reason), export from the pin, convert todo (b) to real tests | DONE | 2026-11-23 | page + 1 test file | emr-enhancer.html, test/values-page.test.js, DECISIONS.md. Error via server with reason, struck-through rows; export marks wrong rows entered-in-error. 262 tests (257 pass, 2 todo, 3 skipped). |
| B3c | chunk-B3c-notes-server.md | Notes and signing on the server | SPLIT | 2026-11-23 | 1 migration, routes, page notes, tests | Replaced by B3c-1 (server) and B3c-2 (page): migration, routes, matrix and todos plus the whole notes page would pass the size guard. Nothing built. |
| B3c-1 | chunk-B3c-notes-server.md | Notes on the server: migration 012 (`case_notes`, `case_note_amendments`, forbid-change triggers, grants without DELETE/TRUNCATE), routes to list, create draft, edit draft (stale edit gives 409), discard (kept), sign, amend with reason; author and signer from the session only | DONE | 2026-11-23 | 1 migration, 1 routes file, app.js, permissions, 3 test files | 012_notes.sql, notes.js, app.js, notes + 3 safety tests, DECISIONS.md. 6 routes; DB-immutable signed notes. 272 tests, 0 todo. Page is B3c-2. |
| B3c-2 | chunk-B3c-notes-server.md | Notes in the page via the server: load, add draft, edit with conflict message, discard, sign, amend with reason; notes leave `vr_interim`; no typed-signer path | DONE | 2026-11-23 | page + 1 test file | emr-enhancer.html, test/notes-page.test.js, 6 tests edited, DECISIONS.md. Server notes; no title; sign/amend server-only; vr_interim keeps no case data. 277 tests, 0 todo, 0 skipped. |
| B4 | chunk-B4-pathways.md | Pathway versions and composition | SPLIT | 2026-11-23 | 1 migration, routes, page, tests | Replaced by B4a (server) and B4b (page): migration, routes and matrix fill the guard; page rewrites hard-coded PATHWAYS and applySetSrv (~50 refs). Nothing built. |
| B4a | chunk-B4-pathways.md | Pathways on the server (items 1, 2, 4): next free migration (`pathways`, `pathway_versions`, ordered members each naming an exact published `element_set_version_id`, `case_applied_pathways`, `from_pathway_version_id` on `case_applied_sets`; immutable versions, grants without DELETE/TRUNCATE), routes to list, create draft, publish (admin-only, as sets), apply to a case (one transaction, traceable pins, each set removable alone); matrix and audit tests updated on purpose | DONE | 2026-11-23 | 1 migration, 1 routes file, app.js, permissions, 3 test files | 013_pathways.sql, pathways.js, app.js, observations.js, 3 test files, DECISIONS.md. 6 routes + apply; DB-immutable versions, pins link to source. 285 tests, 0 todo. Page is B4b. |
| B4b | chunk-B4-pathways.md | Pathways in the page (item 3): library from the server, one-time demo-pathway import, Apply via the adapter (replaces looped `applySetSrv`), remove a set after applying while the source pathway stays shown | DONE | 2026-11-23 | page + 1 test file | emr-enhancer.html, test/pathways-page.test.js, 2 tests edited, DECISIONS.md. Server pathway library, one-call apply, source kept, admin demo import. 290 tests, 0 todo. |
| B5 | chunk-B5-context-service.md | Context service: versioned minimal envelope | SPLIT | 2026-11-23 | | Replaced by B5a, B5b. Envelope shape now follows CCIS `context-envelope` schema (row 1.4). |
| B5a | chunk-B5a-envelope-builder.md | Pure envelope builder `context.js`; vendor CCIS schemas into `contracts/`; ajv devDependency | SPLIT | 2026-11-23 | | Replaced by B5a-1, B5a-2. Draft context.js, route, permission and 249-line test already exist; the schema shape breaks all 9 route tests. |
| B5a-1 | chunk-B5a-envelope-builder.md | Vendor CCIS schemas into `contracts/`; ajv 8.18.0 devDependency; NEW pure `envelope.js` building the CCIS schema shape; schema-validation test. Old context.js and route untouched | DONE | 2026-11-23 | `envelope.js`, `contracts/`, 1 test file, package.json | envelope.js, contracts/ (2 schemas + README), test/envelope.test.js, package.json, lock, DECISIONS.md. 11 new tests pass, 3 breakages seen; full suite not run (no Postgres). |
| B5a-2 | chunk-B5a-envelope-builder.md | Point the existing `GET /api/cases/:id/context` at `envelope.js` (422 on EnvelopeError, drop `purpose=audit`); rewrite the route tests in `test/context.test.js` to the schema shape; remove the old draft builder | DONE | 2026-11-23 | context.js, 1 test file, DECISIONS.md | context.js, test/context.test.js, DECISIONS.md. Every response schema-validated; no params; 422 on id clash. 310 tests, 307 pass, 3 skipped (no Chrome). |
| B5b | chunk-B5b-context-route.md | Export log (`context_exports`, append-only), file download with hash, "Download context envelope" button | DONE | 2026-11-23 | 1 migration, 1 route, 1 button, tests | 014_context_exports.sql, context.js, page, context + context-page + safety-data tests, DECISIONS.md. Row and audit in one transaction. 317 tests, 3 skipped (no Chrome). |
| | | **TRACK DEMO: end-to-end demo slice with CCIS** (see `emr-plan-chunks/04-demo-and-roadmap.md`) | | | | |
| DM0 | chunk-DM0-demo-script.md | Demo script and scope contract (docs only) | DONE | 2026-11-23 | docs/DEMO-SCRIPT.md | Draft delivered with this plan; owner reviews. |
| DM1 | chunk-DM1-seed-demo.md | One-command demo seed and reset (`demo:seed`, `demo:reset`) | DONE | 2026-11-23 | 1 script, 1 test | scripts/seed-demo.js, test/demo-seed.test.js, package.json, DECISIONS.md. Via real routes; idempotent; reset archives. 8 values, 1 Unknown, 1 missing. |
| DM2a | chunk-DM2a-run-results-server.md | Import and acknowledge CCIS run records: `ccis_runs`, `ccis_run_acks`, 3 routes, permissions | DONE | 2026-11-23 | 1 migration, 3 routes, tests | ccis-runs.js, 015 migration, 5 schemas, ajv to deps, 5 test files, DECISIONS. Record needs x-envelopeSha256 (DM3 adds it). 337 tests, 3 skipped (no Chrome). |
| DM2b | chunk-DM2b-insights-panel.md | CCIS insights panel in the case screen (import file, view, acknowledge, demo-parameter banner) | DONE | 2026-11-23 | page edit + 1 test file | emr-enhancer.html, test/ccis-page.test.js, DECISIONS.md. Panel: list, detail, banners, import, acknowledge. 344 tests, 3 skipped (no Chrome). Browser not tried. |
| DM3 | chunk-DM3-bridge.md | `scripts/demo-bridge.js`: envelope -> CCIS CLI child process -> import | SPLIT | 2026-11-23 | | Replaced by DM3a to DM3d. Found: EMR concept ids (`snake-envenomation-timing.*`) differ from CCIS (`snake.envenomation-timing.*`) and select words differ from codes: a mapping step is needed. Nothing built. |
| DM3a | chunk-DM3a-export-file.md | Bridge step 1: log in, `GET /context`, write the file unchanged, return path and SHA-256 (equals the `context_exports` hash) | DONE | 2026-11-23 | 1 script, 1 test | scripts/demo-bridge.js, test/demo-bridge.test.js, chunk-DM3a-export-file.md. Exact bytes, hash = context_exports. 3 new tests pass; full suite not run. |
| DM3b | chunk-DM3b-map-ids.md | `scripts/demo-map.js`: pure `mapEnvelope` (concept ids and select words to CCIS names; unknown value throws; input untouched; output validates) | DONE | 2026-11-23 | 1 script, 1 test | scripts/demo-map.js, test/demo-map.test.js, chunk-DM3b-map-ids.md. Pure; unknown throws; negatives become explicitly-negative; Clotted/Unclotted share demo-result-a. 4 tests; full suite not run. |
| DM3c | chunk-DM3c-run-cli.md | `runCcis`: spawn `ccis-cli.js run` (array args, no shell, `CCIS_PATH`, timeout), add `x-envelopeSha256` of the ORIGINAL file | DONE | 2026-11-23 | same script, 1 test | scripts/demo-bridge.js, test/demo-run-cli.test.js, chunk-DM3c-run-cli.md. Stub-CLI tests, 3 breakages seen. Real CLI refuses: CCIS holds 0.1.0, EMR sends 1.0.0 (DM3b-2). |
| DM3b-2 | chunk-DM3b-map-ids.md | Fix mapper versions: EMR pin v1 maps to CCIS `0.1.0` for the 2 demo artefacts (unknown version throws); update DM3b test; real CLI run on a seeded envelope must reach `complete` | DONE | 2026-11-23 | demo-map.js + its test | demo-map.js, demo-map test, DECISIONS.md. v1 to 0.1.0, others throw. Real CLI on a built envelope returns completed. 1 breakage seen. |
| DM3d | chunk-DM3d-import-and-npm.md | Import via `POST /ccis-runs`, `npm run demo:run -- <case id>`, retry gives `alreadyImported` | DONE | 2026-11-23 | same script, 1 test, package.json | scripts/demo-bridge.js, test/demo-run.test.js, package.json, gitignore, chunk, DECISIONS.md. Stub CLI, real server; 3 breakages seen. 360 tests, 3 skipped. Real CLI run is DM4c. |
| DM4 | chunk-DM4-demo-polish.md | Demo runbook, banners, end-to-end test | SPLIT | 2026-11-23 | docs + 1 test + banner | Replaced by DM4a to DM4c. Nothing built. |
| DM4a | chunk-DM4-demo-polish.md | Persistent "Synthetic data, prototype" banner on every page; staged features labelled "planned" (item 2) | TODO |  | page edit + 1 small test | Needs DM2b. No new features. |
| DM4b | chunk-DM4-demo-polish.md | One end-to-end test: seed -> envelope -> map -> stub CLI -> import -> acknowledge (item 3); fix only rough edges it finds on the demo path (item 4) | TODO |  | 1 test file | Needs DM1, DM2b, DM3d. Stub CLI; real CLI run is DM4c. |
| DM4c | chunk-DM4-demo-polish.md | `docs/DEMO-RUNBOOK.md`: clean-machine setup, reset, click path, known limits, staged list; owner checklist for screen backup and two rehearsals (items 1, 5) | TODO |  | docs only | Needs DM4a, DM4b, CCIS DS7. Rehearsal is yours. |
| | | **TRACK R: full advanced-EMR roadmap (LOCKED until DM4 DONE and "start roadmap")** | | | | |
| R0 | (written when reached) | Split `emr-enhancer.html` into modules, no behaviour change | SPLIT | 2026-11-23 |  | Replaced by R0a to R0e. Still LOCKED. |
| R0a | 04-demo-and-roadmap.md (R brief) | Module loading under the CSP (nonce, same origin), test helper that finds code in the new files; no behaviour change | LOCKED |  | 1 build/serve edit + 1 test | Do first. Ratchet tests keep passing. |
| R0b | 04-demo-and-roadmap.md (R brief) | Move shared core out of the page: escaper, storage adapter, session, ACT table (delegated listener) | LOCKED |  | page + new module + tests edited | No behaviour change. |
| R0c | 04-demo-and-roadmap.md (R brief) | Move screens group 1: patients, encounters, cases list | LOCKED |  | new module + page edit | One screen group per row. |
| R0d | 04-demo-and-roadmap.md (R brief) | Move screens group 2: library, review, versions, pathways | LOCKED |  | new module + page edit |  |
| R0e | 04-demo-and-roadmap.md (R brief) | Move case workspace: pins, values, notes, insights panel; page file only wires modules | LOCKED |  | new module + page edit | Check no inline handlers return. |
| R1 | (written when reached) | A. Advanced OPD: complaints, symptom attributes, adaptive history, examination, assessment and plan | SPLIT | 2026-11-23 |  | Replaced by R1a to R1f. Still LOCKED. |
| R1a | 04-demo-and-roadmap.md (R brief) | Complaint picker screen + OPD complaint sets (data only, no codes, no doses) | LOCKED |  | page + 1 test file | Context impact: none (uses sets). |
| R1b | 04-demo-and-roadmap.md (R brief) | Structured symptom attributes (onset, duration, severity as fields) | LOCKED |  | page + set definitions + test | Context impact: new observation kinds only; state it. |
| R1c | 04-demo-and-roadmap.md (R brief) | Adaptive history: follow-up fields shown by earlier answers (display logic only, no thresholds) | LOCKED |  | page + 1 test file | Context impact: none. |
| R1d | 04-demo-and-roadmap.md (R brief) | Structured examination fields | LOCKED |  | set definitions + page + test | Context impact: new observation kinds. |
| R1e | 04-demo-and-roadmap.md (R brief) | Assessment and plan block (free text and optional verified code) | LOCKED |  | page + 1 test file | Notes stay server-side and immutable once signed. |
| R1f | 04-demo-and-roadmap.md (R brief) | Quick and detailed mode switch | LOCKED |  | page + 1 test file | Display only; same data. |
| R2 | (written when reached) | B. Terminology: server code search and verification, LOINC/ICD bindings, local terms, versions | SPLIT | 2026-11-23 |  | Replaced by R2a to R2f. Still LOCKED. |
| R2a | 04-demo-and-roadmap.md (R brief) | YOUR task: terminology licence check (ICD, LOINC, local terms) | LOCKED |  | none | Gate. Nothing in R2b onward starts before you confirm. |
| R2b | 04-demo-and-roadmap.md (R brief) | Migration: terminology systems, versions, concepts (no DELETE); loader script for a small licensed or open sample | LOCKED |  | 1 migration + 1 script + tests |  |
| R2c | 04-demo-and-roadmap.md (R brief) | Server routes: search and verify (code exists AND display matches); matrix and audit tests | LOCKED |  | 1 routes file + tests | Context impact: bindings carry version. |
| R2d | 04-demo-and-roadmap.md (R brief) | Lint accepts server-verified codes; restore codes on demo glucose, DKA, vitals sets via new versions | LOCKED |  | lint + sets + tests | Fixes the "lost codes on import" open item. |
| R2e | 04-demo-and-roadmap.md (R brief) | Page code picker uses the server; unverified never exported | LOCKED |  | page + 1 test file |  |
| R2f | 04-demo-and-roadmap.md (R brief) | Local terms: add, review, publish (admin and informatician rules as sets) | LOCKED |  | 1 migration + routes + tests |  |
| R3 | (written when reached) | D. Longitudinal record: problems, allergies, medication history, results, timeline | SPLIT | 2026-11-23 |  | Replaced by R3a to R3i. Still LOCKED. |
| R3a | 04-demo-and-roadmap.md (R brief) | Problems: migration + routes (add, resolve with reason, entered-in-error; no delete) | LOCKED |  | 1 migration + 1 routes file + tests |  |
| R3b | 04-demo-and-roadmap.md (R brief) | Problems in the page | LOCKED |  | page + 1 test file |  |
| R3c | 04-demo-and-roadmap.md (R brief) | Allergies: migration + routes (same rules) | LOCKED |  | 1 migration + 1 routes file + tests |  |
| R3d | 04-demo-and-roadmap.md (R brief) | Allergies in the page | LOCKED |  | page + 1 test file |  |
| R3e | 04-demo-and-roadmap.md (R brief) | Medication history (recorded list only, no orders): server | LOCKED |  | 1 migration + 1 routes file + tests | Orders stay in R4. |
| R3f | 04-demo-and-roadmap.md (R brief) | Medication history in the page | LOCKED |  | page + 1 test file |  |
| R3g | 04-demo-and-roadmap.md (R brief) | Timeline: server read route across cases | LOCKED |  | 1 routes file + tests |  |
| R3h | 04-demo-and-roadmap.md (R brief) | Timeline in the page | LOCKED |  | page + 1 test file |  |
| R3i | 04-demo-and-roadmap.md (R brief) | Envelope sections problems and allergies (CCIS schema version bump first, in the CCIS repo) | LOCKED |  | envelope.js + contracts + tests | Context impact: new sections; needs CCIS agreement. |
| R4 | (written when reached) | C. Orders and results: medications, investigations, results, abnormal acknowledgement, referrals, procedures | SPLIT | 2026-11-23 |  | Replaced by R4a to R4j. Still LOCKED. |
| R4a | 04-demo-and-roadmap.md (R brief) | YOUR task: name clinician owner; decide drug-data licence | LOCKED |  | none | Gate. Nothing in R4b onward starts first. |
| R4b | 04-demo-and-roadmap.md (R brief) | Medication orders: migration + routes (order, change with reason, stop; no delete) | LOCKED |  | 1 migration + 1 routes file + tests | Signer from session. No doses suggested by AI. |
| R4c | 04-demo-and-roadmap.md (R brief) | Medication orders in the page | LOCKED |  | page + 1 test file |  |
| R4d | 04-demo-and-roadmap.md (R brief) | Medication reconciliation (compare history and orders, explicit accept) | LOCKED |  | routes + page + tests | Split again if over guard. |
| R4e | 04-demo-and-roadmap.md (R brief) | Investigation orders: server | LOCKED |  | 1 migration + 1 routes file + tests |  |
| R4f | 04-demo-and-roadmap.md (R brief) | Specimen and results: server (append-only, correction by new row) | LOCKED |  | 1 migration + 1 routes file + tests |  |
| R4g | 04-demo-and-roadmap.md (R brief) | Investigations, results and abnormal acknowledgement in the page | LOCKED |  | page + 1 test file |  |
| R4h | 04-demo-and-roadmap.md (R brief) | Referrals: server + page (split if large) | LOCKED |  | routes + page + tests |  |
| R4i | 04-demo-and-roadmap.md (R brief) | Procedures: server + page (split if large) | LOCKED |  | routes + page + tests |  |
| R4j | 04-demo-and-roadmap.md (R brief) | Envelope sections orders and results (CCIS schema bump first) | LOCKED |  | envelope.js + contracts + tests | Context impact: new sections. |
| R5 | (written when reached) | C. IPD: admission, progress, medication administration, discharge | SPLIT | 2026-11-23 |  | Replaced by R5a to R5h. Still LOCKED. |
| R5a | 04-demo-and-roadmap.md (R brief) | Admission record: server | LOCKED |  | 1 migration + 1 routes file + tests | Needs R4. |
| R5b | 04-demo-and-roadmap.md (R brief) | Admission in the page | LOCKED |  | page + 1 test file |  |
| R5c | 04-demo-and-roadmap.md (R brief) | Progress notes (reuse notes with a type): server and page | LOCKED |  | routes + page + tests |  |
| R5d | 04-demo-and-roadmap.md (R brief) | Medication administration record: server (append-only) | LOCKED |  | 1 migration + 1 routes file + tests |  |
| R5e | 04-demo-and-roadmap.md (R brief) | Medication administration record in the page | LOCKED |  | page + 1 test file |  |
| R5f | 04-demo-and-roadmap.md (R brief) | Discharge and follow-up: server | LOCKED |  | 1 migration + 1 routes file + tests |  |
| R5g | 04-demo-and-roadmap.md (R brief) | Discharge and follow-up in the page | LOCKED |  | page + 1 test file |  |
| R5h | 04-demo-and-roadmap.md (R brief) | Envelope section administrations (CCIS schema bump first) | LOCKED |  | envelope.js + contracts + tests | Context impact: new section. |
| R6 | (written when reached) | E. FHIR R4 export, Questionnaire/Bundle import, conformance tests | SPLIT | 2026-11-23 |  | Replaced by R6a to R6g. Still LOCKED. |
| R6a | 04-demo-and-roadmap.md (R brief) | FHIR Observation export from verified codings only (check what exists) | LOCKED |  | 1 module + 1 test file |  |
| R6b | 04-demo-and-roadmap.md (R brief) | FHIR Condition export (problems) | LOCKED |  | 1 module + 1 test file | Needs R3b. |
| R6c | 04-demo-and-roadmap.md (R brief) | FHIR AllergyIntolerance export | LOCKED |  | 1 module + 1 test file | Needs R3d. |
| R6d | 04-demo-and-roadmap.md (R brief) | FHIR MedicationRequest export | LOCKED |  | 1 module + 1 test file | Needs R4c. |
| R6e | 04-demo-and-roadmap.md (R brief) | Questionnaire import into element sets (draft only, goes through review) | LOCKED |  | 1 module + 1 test file |  |
| R6f | 04-demo-and-roadmap.md (R brief) | Bundle import (draft only, audited) | LOCKED |  | 1 module + 1 test file |  |
| R6g | 04-demo-and-roadmap.md (R brief) | Conformance test pack against a public validator | LOCKED |  | tests + 1 doc |  |
| R7 | (written when reached) | F. Integration hardening: batch envelope (D8b), versioning policy, retention, de-identification review | SPLIT | 2026-11-23 |  | Replaced by R7a to R7d. Still LOCKED. |
| R7a | 04-demo-and-roadmap.md (R brief) | Batch envelope export = D8b-1 to D8b-3 (do not duplicate) | LOCKED |  | n/a | Absorbs D8b. |
| R7b | 04-demo-and-roadmap.md (R brief) | Envelope versioning policy (docs) and a test that old versions still validate | LOCKED |  | docs + 1 test |  |
| R7c | 04-demo-and-roadmap.md (R brief) | Run-record retention rule (docs) and a check that nothing is deleted | LOCKED |  | docs + 1 test |  |
| R7d | 04-demo-and-roadmap.md (R brief) | De-identification review: checklist and tests on `deid.js` | LOCKED |  | docs + 1 test file | Final sign-off is yours. |
| R8 | (written when reached) | Clinical validation: workflow tests, clinician walkthrough, privacy/security review, safety case | SPLIT | 2026-11-23 |  | Replaced by R8a to R8e. Still LOCKED. |
| R8a | 04-demo-and-roadmap.md (R brief) | End-to-end workflow test pack (OPD, IPD, demo path) | LOCKED |  | tests |  |
| R8b | 04-demo-and-roadmap.md (R brief) | Clinician walkthrough script and feedback form (docs) | LOCKED |  | docs only | Walkthrough is yours. |
| R8c | 04-demo-and-roadmap.md (R brief) | Privacy and security review checklist with evidence links (docs) | LOCKED |  | docs only | Review is yours. |
| R8d | 04-demo-and-roadmap.md (R brief) | Safety case draft (hazards, controls, residual risk) (docs) | LOCKED |  | docs only | Clinical owner signs. |
| R8e | 04-demo-and-roadmap.md (R brief) | YOUR task: go-live gate sign-off | LOCKED |  | none | Not for clinical use until done. |
| | | **TRACK C and D: MOVED to the CCIS repo** (https://github.com/avi33tbtt/Vibe-Rounds---CCIS) | | | | |
| C0 to C9 | (CCIS repo) | CCIS spec, schemas, validator, compiler, runtime, run records, marketplace, viewer, first slice | MOVED | 2026-11-22 |  | Replaced by CCIS phases 0 to 3. Do not build here. |
| D1a to D7 | (CCIS repo) | Templates, decision graphs, cohorts, FHIR Mode, governance, evaluation | MOVED | 2026-11-22 |  | Replaced by CCIS phases 4 to 6. Do not build here. |
| D8a | (CCIS repo) | Cohort data package contract | MOVED | 2026-11-22 |  | Now CCIS row 6.4. |
| D8b | chunk-D8b-emr-cohort-exporter.md | EMR Enhancer cohort exporter | SPLIT | 2026-11-23 | 1 routes file + page dialog + tests | Replaced by D8b-1 to D8b-3. Still BLOCKED (needs CCIS 6.4). Nothing built. |
| D8b-1 | chunk-D8b-emr-cohort-exporter.md | Server: `POST /api/cohort-export` (permission `cohort:export`), cohort selection, only fields the purpose needs, de-identified by default, manifest, audit of purpose and counts; matrix and audit tests on purpose (items 1, 4) | BLOCKED |  | 1 routes file, permissions, 2 test files | Needs B3c, B5b and CCIS 6.4. Re-read chunk against 6.4 first. Never narrative or identity. |
| D8b-2 | chunk-D8b-emr-cohort-exporter.md | Page: small export dialog with purpose and preview of included fields (item 2) | BLOCKED |  | page + 1 test file | Needs D8b-1. |
| D8b-3 | chunk-D8b-emr-cohort-exporter.md | Contract test: real export accepted by the CCIS import path; export without narrative or identity (item 3) | BLOCKED |  | 1 test file + fixture | Needs D8b-1 and CCIS 6.4. |

Suggested order: numeric within each track; Track A, then B. The EMR side then waits for the CCIS repo: B5 needs CCIS row 0.3 (import contract), D8b needs CCIS row 6.4. Exceptions that are safe: 8e and 8f can be done any time after 6a; 6e and 7d can share one session.

Reorder done 2026-11-22: B0 to B2b now come before 8b to 8d, so B2r is merged into them (SKIPPED). Next rows in order: 8e, 8f, B0, B1a, B1b, B2a, B2b, 8b, 8c, 8d.

## ITEMS ONLY YOU CAN DO (Claude cannot)
- Turn on branch protection for `main` and require the `test` check (GitHub, Settings, Branches).
- Look at the first GitHub Actions run (the workflow has never run).
- Try one real AI provider call (`AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` in `.env` and Render), then tick Enable AI as admin.
- Try the app in a real browser with real synthetic data; Node 20 and other PostgreSQL versions are untested.
- Tick the finished chunks in `emr-plan-chunks/02-roadmap.md` (items 01 to 05 are still unticked there); later items are tracked in `03-roadmap-track-bcd.md`.
- For 7c: perform the restore on a clean machine yourself and confirm the result.
- Review and approve: the B0 mapping (before B1). CCIS approvals (R0, limitations review) are tracked in the CCIS tracker.
- Name a clinician owner for any clinical rule content (thresholds, bands, medication safety, staging): see the CCIS tracker.
- Check terminology licences and device-software/health-data rules (go-live gate).

## KNOWN GAPS (0 `test.todo` tests left) and where they are fixed
(a) signer/author: page now uses the session (8e, done); server enforcement done in B3c-1. (b) observation rows: page no longer deletes them (8f, done); server now refuses rewrites and deletes (B3a, done); page wiring done in B3b-2 and B3b-3. (c) closed by 6c. (d) signed-note immutability and stale-version conflicts only in the page; element sets, cases and notes are not stored on the server -> DECIDED 2026-11-22: full server storage is now planned (B1 to B4); notes in B3c (server B3c-1, page B3c-2, both done); both todos (a) and (d) are now real tests. (e) `GET /api/patients/:id/encounters` not audited -> left as is.

## DECISIONS MADE ON 2026-11-22 (also in DECISIONS.md)
- Server-side storage is ALWAYS ON for cases, element sets, observations and notes (reverses the snapshot-only idea). Browser storage remains only as the file:// demo fallback behind one storage adapter; signed-in sessions write no clinical data to localStorage.
- CSP uses option A (delegated listener, no inline handlers), split into 6d-1 and 6d-2a to 6d-2c.
- CCIS is a separate app and repo (CCIS decision D-001): standalone, local-first, imports an export file from the EMR. It replaces the old EMR Track C/D plan. This repo keeps only the exporter side (B5, D8b).
- First CCIS slice (in the CCIS repo): snake envenomation process metrics. No doses or bands; parameters from a local clinician, disabled by default. The EMR cohort exporter is the last EMR row.

## OPEN QUESTIONS
- 2026-11-23: rehearse and review `docs/DEMO-SCRIPT.md` (row DM0 is a draft). The early "criteria met" example was dropped: CCIS outputs are descriptive process metrics with disabled thresholds.
- 2026-11-23: hand-off to CCIS is by file and local CLI only (no network). Say if you want a different mechanism.
- 2026-11-23: R0 (page split) is added because the single 2.4k-line HTML file will strain at R1 to R4.
- Resolved 2026-11-22 (8d-2): the page only shows and submits server drafts (no draft editor). A draft editor in the page is still not planned: say if you want a row for it.
- Resolved 2026-11-22: interim data while signed in = option B (`vr_interim`). Values left it in B3b-2; notes left it in B3c-2; custom sets still sit there.
- Resolved 2026-11-22: re-ordered, review workflow (8b to 8d) now follows B2b and is built on server versions.
- Resolved 2026-11-22: CCIS lives in its own repo (Vibe-Rounds---CCIS). The snake-envenomation parameter owner question is now tracked there.
- Which clinician owns the snake-envenomation parameters used by the slice?
- Resolved 2026-11-22 (8c-2): publish and retire stay admin-only; informaticians review only.
- Demo sets glucose, DKA and vitals lost their codes on import (the server cannot verify codes, review refuses unverified ones). Add codes in a later version once a server verifier exists.
- Resolved 2026-11-23 (B3b-2, default used): blank does nothing on the server in a signed-in case; the page offers `Unknown` (explicit unknown). `Entered in error` for values comes in B3b-3.
- Done in B3b-2: two sets that share a field id (glu, wbct, swell, arr, out) no longer share one value; each set keeps its own, as B0 section 5 says.
- Adding any API route makes `test/safety-routes.test.js` fail until the permission matrix there is updated on purpose.
