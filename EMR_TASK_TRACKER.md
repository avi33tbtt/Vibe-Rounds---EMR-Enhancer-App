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

**Added 2026-11-22 (plan extension).** Rows B0 to D8b extend the plan toward the book's Chapters 5 to 10. Rules that apply to every new row: use the next free migration number (never a fixed one); every new route updates the permission matrix and audit tests on purpose; every new table gets only the grants `emr_app` needs and no DELETE/TRUNCATE on clinical data; CCIS libraries (`ccis-*.js`) are pure JS with no database access; data files live in `ccis/`; tests are `test/ccis-*.test.js`. The "Needs:" text in Notes lists prerequisite rows: do not start a row whose prerequisites are not DONE.

---

## STATUS LEGEND
`TODO` | `IN PROGRESS` | `DONE` | `BLOCKED` | `SKIPPED` | `SPLIT` (replaced by sub-tasks)

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
| B1b-2 | chunk-B1b-cases-page.md | Import local demo cases (explicit action, audited as an import) | TODO |  | 1 route in cases.js, matrix, page button, 1 test file | Needs: B1b-1. Chunk item 3. Needs a new server route, so it was outside B1b's size guard. |
| B2a | chunk-B2a-element-sets-server.md | Versioned element sets (server) | TODO |  | 1 migration, 1 routes file, tests | Needs: B1a. |
| B2b | chunk-B2b-element-sets-page.md | Library + case pinning use server versions | TODO |  | page + 1 test file | Needs: B2a, B1b. May merge into B3a/B3b (see chunk). |
| 8b | chunk-08b-submit-snapshot.md | Server: submit set for review (snapshot) | TODO |  | 1 migration, routes, tests | Needs: 8a, B2a. Reordered 2026-11-22: build on server versions (apply chunk-B2r changes here; chunk text says snapshots). |
| 8c | chunk-08c-review-rules.md | Reviewer rules + frozen approved version | TODO |  | routes, trigger, tests | Needs: 8b. Build on server versions. |
| 8d | chunk-08d-review-ui.md | Review screens + tier badges | TODO |  | page + 1 test file | Needs: 8c, B2b. Build on server versions. |
| B2r | chunk-B2r-review-on-versions.md | Re-point review workflow at server versions | SKIPPED | 2026-11-22 | n/a | Merged into 8b to 8d by the reorder; do not run separately. |
| B3a | chunk-B3a-observations-server.md | Applied sets, observations, events (server) | TODO |  | 1 migration, 1 routes file, tests | Needs: B2a. Append-only; entered-in-error. |
| B3b | chunk-B3b-observations-page.md | Values and trajectories via server; entered-in-error UI | TODO |  | page + 1 test file | Needs: B3a, 8f. Closes todo (b). |
| B3c | chunk-B3c-notes-server.md | Notes and signing on the server | TODO |  | 1 migration, routes, page notes, tests | Needs: B3a, 8e. Closes todos (a) and (d). |
| B4 | chunk-B4-pathways.md | Pathway versions and composition | TODO |  | 1 migration, routes, page, tests | Needs: B3a. Split server/page if large. |
| B5 | chunk-B5-context-service.md | Context service: versioned minimal envelope | TODO |  | 1 module, 1 route, tests | Needs: B3a, B4. Input contract for CCIS. |
| | | **TRACK C: CCIS schemas, validators and first vertical slice (book Ch9)** | | | | |
| C0 | chunk-C0-ccis-spec.md | CCIS spec baseline (docs only) | TODO |  | 3 markdown files | Can start any time after 8f; DB-free. User approves freeze. |
| C1a | chunk-C1a-schemas-core.md | Schemas: manifest, element, terminology binding | TODO |  | 3 schemas + module + tests | Needs: C0. Adds Ajv (pinned). |
| C1b | chunk-C1b-schemas-pathway-node.md | Schemas: pathway, decision node | TODO |  | 2 schemas + tests | Needs: C1a. |
| C1c | chunk-C1c-schemas-analytics.md | Schemas: analytics package, execution manifest, validation record, run result | TODO |  | 4 schemas + tests | Needs: C1b. |
| C2a | chunk-C2a-reference-valid.md | Reference artefacts (valid) + synthetic fixtures | TODO |  | JSON files + 1 test | Needs: C1c. Use case: snake envenomation process metrics. |
| C2b | chunk-C2b-reference-invalid.md | Research candidate, FHIR Mode example, invalid per layer | TODO |  | JSON files | Needs: C2a. |
| C3a | chunk-C3a-validator-1.md | Validator layers 1 to 3 | TODO |  | 1 module + CLI + tests | Needs: C2b. |
| C3b | chunk-C3b-validator-2.md | Validator layers 4 to 5 (semantic, graph) | TODO |  | 1 module + tests | Needs: C3a. |
| C3c | chunk-C3c-validator-3.md | Validator layers 6 to 8 (safety, tests, governance) | TODO |  | 1 module + tests | Needs: C3b. |
| C4 | chunk-C4-compiler.md | Compiler: canonical form, checksum, equivalence | TODO |  | 1 module + tests | Needs: C3c. |
| C5a | chunk-C5a-runtime-import.md | Runtime: import context envelope | TODO |  | 1 module + tests | Needs: B5, C4. |
| C5b | chunk-C5b-compatibility.md | Runtime: compatibility resolver | TODO |  | 1 module + tests | Needs: C5a. |
| C5c | chunk-C5c-executor.md | Runtime: constrained executor + decision path | TODO |  | 1 module + tests | Needs: C5b. No eval. |
| C6 | chunk-C6-run-records.md | Immutable run records + API | TODO |  | 1 migration, 1 routes file, tests | Needs: C5c, B5. |
| C7 | chunk-C7-test-marketplace.md | Local test marketplace: publish, resolve, pin | TODO |  | 1 module + index + tests | Needs: C4. |
| C8 | chunk-C8-result-viewer.md | Result viewer (ci.html) | TODO |  | 1 page + route + tests | Needs: C6. |
| C9 | chunk-C9-vertical-slice.md | First conformant vertical slice + CCIS 0.1 baseline | TODO |  | 1 test file + docs | Needs: C6, C7, C8. User reviews limitations. |
| | | **TRACK D: analytics catalogue, decision graphs, cohorts, FHIR, governance (book Ch8, Ch10)** | | | | |
| D1a | chunk-D1a-templates-core.md | Analytics templates 1 to 3 (threshold, trend, score) | TODO |  | 3 templates + fixtures | Needs: C9. |
| D1b | chunk-D1b-templates-more.md | Templates 4 to 6 (monitoring gap, eligibility, follow-up due) | TODO |  | 3 templates + fixtures | Needs: D1a. Medication-safety and staging BLOCKED until a clinician owner supplies rules. |
| D1c | chunk-D1c-catalogue-discovery.md | Catalogue discovery + status labels | TODO |  | 1 module + tests | Needs: D1b, C7. |
| D2a | chunk-D2a-decision-graph-engine.md | Decision graph: schema, static checks, executor | TODO |  | 1 schema + executor + tests | Needs: C5c. |
| D2b | chunk-D2b-graph-code-authoring.md | Decision graph authoring: code/structured editor | TODO |  | 1 page section/CLI + tests | Needs: D2a. Visual node builder is later. |
| D2c | chunk-D2c-llm-drafting.md | LLM drafting for graphs/templates (drafts only) | TODO |  | 1 route file + tests | Needs: D2b. |
| D3 | chunk-D3-research-to-package.md | Research paper to traceable analytics package | TODO |  | 1 module + route + tests | Needs: D2c, D1a. |
| D4a | chunk-D4a-cohort-definition.md | Cohort definition schema + validator | TODO |  | 1 schema + rules + tests | Needs: C9. |
| D4b | chunk-D4b-cohort-evaluator.md | Cohort evaluator (3-valued) on synthetic data | TODO |  | 1 module + fixtures + tests | Needs: D4a. |
| D4c | chunk-D4c-cohort-analytics.md | Cohort analytics execution + aggregation + provenance | TODO |  | 1 module + tests | Needs: D4b, D1a. |
| D4d | chunk-D4d-cohort-access.md | Population-level access, purpose, small-cell control | TODO |  | 1 routes file + permissions + tests | Needs: D4c, B5. |
| D5a | chunk-D5a-fhir-capability.md | FHIR Mode profile + capability matrix | TODO |  | docs + 1 test | Needs: C9. |
| D5b | chunk-D5b-fhir-roundtrip.md | FHIR Mode round-trip + negative tests | TODO |  | tests + fixtures | Needs: D5a. |
| D6 | chunk-D6-governance.md | External review + release governance | TODO |  | docs + 1 script + tests | Needs: C9, D1c. |
| D7 | chunk-D7-evaluation.md | Quality + reliability evaluation (CI job) | TODO |  | 1 workflow edit + script + docs | Needs: D4c. |
| D8a | chunk-D8a-cohort-package-contract.md | Cohort data package contract + import acceptance | TODO |  | 1 spec + schema + module + tests | Needs: D4d, B5. |
| D8b | chunk-D8b-emr-cohort-exporter.md | EMR Enhancer cohort exporter | TODO |  | 1 routes file + page dialog + tests | Needs: D8a, B3c, D4d. Last row. |

Suggested order: numeric within each track; tracks run A, then B, then C, then D. Exceptions that are safe: 8e and 8f can be done any time after 6a; 6e and 7d can share one session; C0 to C4 are DB-free and may run in parallel with Track B if you want faster progress (C5a onward needs B5).

Reorder done 2026-11-22: B0 to B2b now come before 8b to 8d, so B2r is merged into them (SKIPPED). Next rows in order: 8e, 8f, B0, B1a, B1b, B2a, B2b, 8b, 8c, 8d.

## ITEMS ONLY YOU CAN DO (Claude cannot)
- Turn on branch protection for `main` and require the `test` check (GitHub, Settings, Branches).
- Look at the first GitHub Actions run (the workflow has never run).
- Try one real AI provider call (`AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` in `.env` and Render), then tick Enable AI as admin.
- Try the app in a real browser with real synthetic data; Node 20 and other PostgreSQL versions are untested.
- Tick the finished chunks in `emr-plan-chunks/02-roadmap.md` (items 01 to 05 are still unticked there); later items are tracked in `03-roadmap-track-bcd.md`.
- For 7c: perform the restore on a clean machine yourself and confirm the result.
- Review and approve: B0 mapping (before B1), C0 spec freeze (before C1), C9 limitations list (before Track D).
- Name a clinician owner for any clinical rule content (thresholds, bands, medication safety, staging). Until then those templates stay BLOCKED and parameters stay disabled.
- Arrange an independent clinical reviewer before any package is labelled `validated` (D1c, D6).
- Check terminology licences and device-software/health-data rules (go-live gate).

## KNOWN GAPS (2 `test.todo` tests left) and where they are fixed
(a) signer/author: page now uses the session (8e, done); server enforcement still in B3c. (b) observation rows: page no longer deletes them (8f, done); server-enforced in B3a/B3b. (c) closed by 6c. (d) signed-note immutability and stale-version conflicts only in the page; element sets, cases and notes are not stored on the server -> DECIDED 2026-11-22: full server storage is now planned (B1 to B4); notes in B3c. (e) `GET /api/patients/:id/encounters` not audited -> left as is.

## DECISIONS MADE ON 2026-11-22 (also in DECISIONS.md)
- Server-side storage is ALWAYS ON for cases, element sets, observations and notes (reverses the snapshot-only idea). Browser storage remains only as the file:// demo fallback behind one storage adapter; signed-in sessions write no clinical data to localStorage.
- CSP uses option A (delegated listener, no inline handlers), split into 6d-1 and 6d-2a to 6d-2c.
- CCIS code: root-level `ccis-*.js` (pure, no DB) plus `ccis/` for schemas, examples, fixtures and spec; JSON Schema validated with one pinned dependency (Ajv); runtime is a whitelist interpreter, never `eval`.
- First vertical-slice use case: snake envenomation process metrics (bite-to-ASV interval, clotting-test documentation completeness). No doses or bands; parameters supplied by a local clinician and disabled by default.
- Cohort engine is built against synthetic fixtures first; the EMR cohort exporter is the last row.

## OPEN QUESTIONS
- Resolved 2026-11-22: interim data while signed in = option B (`vr_interim`, removed in B3b/B3c). Built in B1b-1.
- Resolved 2026-11-22: re-ordered, review workflow (8b to 8d) now follows B2b and is built on server versions.
- Where do the CCIS libraries and the Intelligence App live long term: this repo (current plan) or a separate repo after C9?
- Which clinician owns the snake-envenomation parameters used by the slice?
- Adding any API route makes `test/safety-routes.test.js` fail until the permission matrix there is updated on purpose.
