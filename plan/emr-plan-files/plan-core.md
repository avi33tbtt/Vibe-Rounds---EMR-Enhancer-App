# EMR Enhancer plan: core file (give this in every chat)

*v6 split into files, 20 Nov 2026. EMR repo: github.com/avi33tbtt/Vibe-Rounds---EMR-Enhancer-App. Analytics repo: github.com/avi33tbtt/VibeRounds-Clinical-Analytics-App. Registry repo: `emr-enhancer-registry` (built in this project).*

**Latest `npm test` (EMR repo, after 44a2d, 21 Nov 2026): 479 tests, 479 pass (run twice).** Tests now run one file at a time (`--test-concurrency=1`) because the test files share one database role (`emr_app`). The database must be running first (`npm run db:up`, with `POSTGRES_PASSWORD` in `.env`).

## How to use (every chat, nothing to remember)

1. Find the **first row below that is not ticked**. That is your step.
2. Open a **new chat**. Attach **this file** and the **file(s) named in that row**. Nothing else.
3. Say: **"Do the next task."** Claude picks the first unticked task in that file inside the row's task range, and tells you which `grep` or `sed` output to paste. (On Windows PowerShell there is no `grep`: use `Select-String`, or attach the source files so Claude can read them.)
4. Apply the edits, run `npm test`, commit.
5. Tick the task `[x]` in the phase file. When every task in the row is ticked, tick the row here. If a row has a gate or a manual check, do it before moving on.
6. Rows marked *Analytics repo* are built in the Analytics repo with **Context block B** (below). All other rows use Context block A.

If a task's Paste line names a section that is not in the attached file, Claude will tell you which file from the section map and you attach it. You do not need to look it up.

## The sequence (top to bottom, do not skip)

Steps 5, 11, 14 and 16 are different from the old order in section 15.3. The old order put some tasks before the things they paste from (P2c before F4, P5b before AA1) and Phase A before M1, which Phase A needs. This table fixes that. It is based on the Paste lines and prerequisites I read; a task not listed in a row's notes can still turn out to need something earlier, and Claude will say so in the chat if it does.

| Step | Done | File | Tasks | Decide first (see `plan-ref-decisions.md`) | Gate or check after |
|---|---|---|---|---|---|
| 1 | [x] | `plan-V.md` | V0a to V1a | - | Create the repo-side basics: orphan tests into npm test, hand-code inventory, VIEWS.md. |
| 2 | [x] | `plan-R.md` | R1 | - | - |
| 3 | [x] | `plan-V.md` | V2a to V4d | 13 | **Gate 1:** the I/O sum looks identical and no hand-named I/O code is left. Then (manual) build one real specialty template as data and note every place it needed a new view type. |
| 4 | [x] | `plan-F.md` | F0 to F3b | 24, 25 | **Gate 2:** the coverage report is right on made-up sets and on real seed sets. Then (manual) read the coverage report for each seed set against the example in 7.1. |
| 5 | [x] | `plan-P-coding.md` | P0 to P2b, P3a to P3d, P4a to P4d, P5a | 38, 39 | - |
| 6 | [x] | `plan-V.md` | V6b1 to V8c (V5a to V6a done) | 11, 17 | V8c has the Phase V release gate (checked after step 8). |
| 7 | [x] | `plan-R.md` | R2 to R9 | 12, 18, 19 | - |
| 8 | [x] | `plan-5-handover.md` | 37d4 to 37d5 (both done, 20 Nov 2026) | - | **V8d1 to V8d8 done (20 Nov 2026; `ALLOW_MAX` is 0). Do now: the Phase V gate. First make `npm test` green: run it twice (see the note above the gate in `plan-V.md`), then do the manual checks.** I/O sum, ward board and handover look the same as before; no clinical set or field name left in code except the V8a allow-list; switching the Handover pathway off removes its tab. |
| 9 | [ ] | `plan-D-demo.md` | D0 to D5b1 (all done, 20 Nov 2026; D5b2 moved to step 10) | 35, 36 | **Do now: run `npm test` (D5b1 was only run on a stand-in persona file), then Gate D.** **Gate D:** ten demo patients load on a fresh database and in Demo mode and match `demo-expected.json`. Then (manual) open each demo patient on the ward board, handover and flowsheets and confirm everything is marked synthetic. |
| 10 | [x] | `plan-F.md`, then `plan-D-demo.md` | F4, then D5b2 (both done, 20 Nov 2026) | 28 | **Do now: run `npm test` (F4 added `elements.project.test.js`; D5b2 was only syntax-checked).** The export half of D5b2 is a `test.todo` until F7b; D7a covers it. |
| 11 | [x] | `plan-P-coding.md` | P2c | - | P2c needs F4, so it moved here from step 5. **Done 20 Nov 2026. Do now: run `npm test`, then step 12 (F5 to F9b); F7c must pass `localSystems` to `projectCase`.** |
| 12 | [x] | `plan-F.md` | F9b (F5 to F9a done 21 Nov 2026; F9b done 21 Nov 2026, see plan-F.md) | 22, 29, 31, 33 | **F7c, F8 and F9a done 21 Nov 2026. Do now: set EXPORT_SALT in .env and .env.example, run npm test, then F9b (admin and informatician). Rewrite the About text on analytics in F9b.** F7a and F7b done 20 Nov 2026 (`export-bundle.js`; tests in `export-bundle.test.js` and `export-bundle.build.test.js`). F7c settled its roles: admin and informatician; it passes `localSystems` to `projectCase`, takes its salt from configuration and passes the final (mergedInto) patient id. After F7 (manual): export a de-identified bundle from synthetic data, import it into the Analytics app as a batch and run Data quality and completeness in V1, V2 and V4. |
| 13 | [ ] | `plan-6-marketplace.md` | 42a1 to 47b2 | 1, 2, 3, 6, 8, 10 | **Started 21 Nov 2026. Done: 42a1 to 42c3 and 43a1 to 43b2 (43b3 is built but not green yet, see its note), except 42a3b (parts ii and iii wait for AA1 and M1). 43b3 to 44a2d done (44a2d 21 Nov 2026: guard tests for approve, request-changes and reject, in `review-decide.test.js`; 44a2b 21 Nov 2026: rules, bands and dose-like text need two different approving reviewers, `REVIEW_REQUIRED_APPROVALS`; 44a2c 21 Nov 2026: `POST /api/review-requests/:id/request-changes` and `/reject`, comment required; `set-withdraw.test.js` fixed, so 43b4 is green). Do now: 44b1 (Tools > Review: queue list). Steps 9 and 12 above: 12 is done; 9 still needs Gate D. If `validateAccess` wants a different access shape, fix `ALLOW_ADMIN` in `audit.test.js` and `ACC` in `review-requests.test.js`.** `server.js` `STATIC_FILES` now also serves `views.js` and `package-lint.js` (enhancer.html loads both). Steps 9 and 12 above are still unticked; finish them when you can. |
| 14 | [ ] | `plan-M-matching.md` | M1 | - | M1 moved before Phase A: Phase A needs it (section 22 and the Phase A prerequisites). |
| 15 | [ ] | `plan-A-analytics.md` | AA0 to AA1 | 30, 32 | Analytics repo, use Context block B. |
| 16 | [ ] | `plan-P-coding.md` | P5b | 42 | Analytics repo. It needs AA1, so it moved here from step 5. |
| 17 | [ ] | `plan-A-analytics.md` | AA2a to AA14 | 23 | Analytics repo, use Context block B. **Gate 3a:** wave 1 definitions run in the Analytics app, masked and audited. After P5b (manual): export an ICD-coded and a SNOMED-coded form and confirm the Analytics app treats ICD as uncoded. |
| 18 | [ ] | `plan-D-demo.md` | D7a to D7b | - | Demo patients exported to the Analytics app and compared with the expected results. |
| 19 | [ ] | `plan-M-matching.md` | M2 to M7 | 26 | - |
| 20 | [ ] | `plan-P-coding.md` | P6 to P9 | **43 (open)** | Settle decision 43 before P6. |
| 21 | [ ] | `plan-P-coding.md` | P10 to P13 | 40, 41 | **Gate P:** a form with no codes, one with a local system and one with SNOMED CT plus ICD all record, export and show coverage; a profile label shows its checked-on date. |
| 22 | [ ] | `plan-S-summary.md` | S1 to S3 | 27 | **Gate 3:** you read the Summary, the coverage reports and the analytics output on synthetic data before Orders is built. |
| 23 | [ ] | `plan-O-orders.md` | 48a1a to 48a2 | - | - |
| 24 | [ ] | `plan-O-orders.md` | O1 to O3 | - | O3 replaces 48b1a: skip 48b1a, it is marked `[-]`. |
| 25 | [ ] | `plan-O-orders.md` | 48b1b, 48b2, O4 | - | - |
| 26 | [ ] | `plan-7-operational.md` | 49a1 to 52d | 14, 15 | - |
| 27 | [ ] | `plan-D-demo.md` | D6, D8, D9 | 37 | Adds orders, allergy, MAR and ADT rows to the demo patients, then the walkthrough. |
| 28 | [ ] | `plan-H-release.md` | 39a1 to 41c2 | - | Release gates. Keep the 'Not for clinical use' banner until the named-clinician sign-off in GOLIVE.md. |
| 29 | [ ] | `plan-Z-ship.md` | Z1 to Z10 | 34 | **Gate Z:** every row of section 3.2 is true and checked (3.2 is in `plan-ref-direction.md`). |

Decisions: every decision has a default and applies unless you say otherwise. The only genuinely open one is **43** (before step 20). If a row lists decisions, give `plan-ref-decisions.md` in that chat so Claude can show the default.

## Files and when to give them

| File | What | When |
|---|---|---|
| `plan-core.md` | this file: sequence, method, Context blocks | every chat |
| `plan-V.md`, `plan-R.md`, `plan-F.md`, `plan-5-handover.md`, `plan-6-marketplace.md`, `plan-A-analytics.md`, `plan-M-matching.md`, `plan-S-summary.md`, `plan-O-orders.md`, `plan-7-operational.md`, `plan-H-release.md`, `plan-D-demo.md`, `plan-P-coding.md`, `plan-Z-ship.md` | the phase files, with the tasks and tick boxes | the file named in the current row |
| `plan-ref-direction.md` | sections 1 to 3: why, separation rule, final outcome and definition of done | only when a task or you ask |
| `plan-ref-design.md` | sections 4 to 9: the design (roles, FHIR spine, analytics, summary and orders) | only when a task's Paste line names a section from 4 to 9 |
| `plan-ref-decisions.md` | section 13: all open and default decisions | when a row lists decisions |
| `plan-ref-status.md` | sections 10, 11, 14, 15: what is built, repo check, manual jobs, phase map, retired tasks | when you want history |

## Section map (where "section N" lives)

| Section | File |
|---|---|
| 1 to 3 (3.2 definition of done, 3.3 first library) | `plan-ref-direction.md` |
| 4 to 9 (6.3, 6.5, 7.1, 8.2 and others) | `plan-ref-design.md` |
| 10, 11, 14, 15 | `plan-ref-status.md` |
| 12 | this file (below) |
| 13 | `plan-ref-decisions.md` |
| 16 Phase V | `plan-V.md` |
| 17 Phase R | `plan-R.md` |
| 18 Phase F | `plan-F.md` |
| 19 Phase 5 (rest) | `plan-5-handover.md` |
| 20 Phase 6 | `plan-6-marketplace.md` |
| 21 Phase A | `plan-A-analytics.md` |
| 22 Phase M | `plan-M-matching.md` |
| 23 Phase S | `plan-S-summary.md` |
| 24 Phase O, and task 48 from section 25 | `plan-O-orders.md` |
| 25 Phase 7 (tasks 49 to 52) | `plan-7-operational.md` |
| 26 Phase H | `plan-H-release.md` |
| 27 Phase D | `plan-D-demo.md` |
| 28 Phase P (its subsections are now 28.1 and 28.2) | `plan-P-coding.md` |
| 29 Phase Z | `plan-Z-ship.md` |

## Method and Context blocks (section 12, unchanged)

*The numbered method in this section is replaced by "How to use" above. The task size rule, the handover line and the Context blocks still apply.*

**Why chats ran out before.** Your limit is spent on what you paste, what Claude writes back, and how long the chat runs. So every task is one file and one concern, usually 30-90 new lines.

1. New chat. 2. Paste the **Context block** once. 3. Paste the task prompt and only the code on its **Paste** line (`grep -n "name" file` then `sed -n 'A,Bp' file`). 4. Apply edits, `npm test`, commit. 5. Tick the box here. One task per chat; stop when it is done.

Ask for **edits only**: "exact old text to find, new text". Never ask for a whole `enhancer.html`.

**Task size rule (audit, 20 Nov 2026).** A task is micro when it has one file, one concern, one prompt of about 60 words or fewer and at most 90 new lines. If a prompt has "and" joining two jobs, or two files, or a route plus a screen plus tests, split it. In v5 the 24 oversized tasks were split, so ids with a letter suffix (F3a, F7b, AA12c) are parts of one old task; in the text above a bare id such as F7 means all its parts. Exceptions that stay as they are: no-code inventory tasks (V0b, F0, D0, AA0), doc-only tasks, and pure data seeds.

**Handover line** (if a chat ran out): `Task <id> partly done. Done: <1 line>. Left: <1 line>. Files changed: <names>.`

```text
Project: EMR Enhancer. Node + Express + PostgreSQL 16, all files in repo root (no folders), single-file client enhancer.html, element-sets.js, cds-rules.js, store.js (window.Store, cache-first), api.js, permissions.js (can(user, action), ROUTE_ACTIONS), audit.js, numbered migrations, node:test + supertest. Demo mode (localStorage) must keep working.
Safety: no pre-filled doses/thresholds/bands; doses are free text, never calculated or summed; AI drafts only; unapproved rules never fire; data shown as recorded, no judgement of care; every write carries the version last seen (409 on conflict) and writes one audit row in the same transaction; follow mergedInto for patients; keep the "Not for clinical use" banner; new routes need an action in permissions.js and an entry in the audit-coverage test.
No hand-written clinical screens: code never names a clinical set id, field id or option text. Every EMR screen is a registered view/section/surface type plus data in a seed set or an EMR view pathway (contexts ['emr'], surface, sections). A new generic type needs a pure function, a test that uses a made-up set, a validator entry and a line in VIEWS.md. View data holds ids, labels and display windows only.
No analytics in the EMR: analytics run only in the Analytics app; the EMR only projects case rows to element rows (elements.js) and exports a de-identified bundle plus an elements manifest (action analytics.export). The EMR installs only marketplace items with targetApp "emr".
Access first: every element declares an access block (view, enter, amend, approve, configure, export; roles from permissions.js; default deny; may narrow, never widen) before anything else; the server enforces it with canElement.
Coding is free: a field may carry any mix of standard systems (SNOMED CT, LOINC, ICD), a facility's own local system, or no code; the software never fills a code in; a profile label says "checked against X vN on synthetic data", never "compliant".
Demo data: synthetic only, deterministic, generated from persona data (the generator names no set or field), loaded through the real create and append paths, refused in production, never put in a package.
Reply format: edits only (exact old text to find + new text), never whole files. Under ~90 new lines. If more is needed, stop and list what is left.
```

**Context block B (paste in Analytics-app chats, Phase A)**
```text
Project: VibeRounds Clinical Analytics. Node + Express + PostgreSQL, all files in repo root (no folders), single-file UI index.html, server.js, analytics.js (engine), security.js (sign-in, audit, sqlGuard, ROLES), evidence.js, knowledge.js, pathways.js, population.js. Tests are self-tests: node <file> --selftest, run by npm test; no database needed.
Rules: all analytics read the scoped FHIR views on the SELECT-only connection; groups under PATHWAY_MIN_CELL (5) are hidden on the server; every data-changing request and every patient-list read is audited; imports stay locked by the import password and data-use confirmation; tables are created at startup with CREATE TABLE IF NOT EXISTS; never store request bodies or patient data in new tables.
Marketplace: this app fetches only items with targetApp "analytics" from the signed index (ed25519, pinned public key, one allow-listed host); install recomputes the SHA-256 of canonical JSON and runs validateAnalytic; installed definitions are read-only. A definition holds slots, a closed analyticKind, params, access and rules [] only: no query text, expression, threshold, target, dose or clinical list. Reference lists are local reviewed records, never in a package by default.
Coverage (definition vs the elements manifest) and readiness (definition vs the data profile) are shown separately and never as quality of care. Reply format: edits only (exact old text to find + new text), under ~90 new lines; if more is needed, stop and list what is left.
```
