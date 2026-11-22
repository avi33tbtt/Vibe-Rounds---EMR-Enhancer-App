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

## STATUS LEGEND
`TODO` | `IN PROGRESS` | `DONE` | `BLOCKED` | `SKIPPED` | `SPLIT` (replaced by sub-tasks)

## TASK LIST

| ID | Plan file | Task | Status | Date | Size guard | Notes (one line) |
|----|-----------|------|--------|------|------------|------------------|
| 0  | (all) | Read plan, populate table | DONE | 2026-11-21 | | |
| 1  | chunk-01-registration-screens.md | Registration screens | DONE | 2026-11-21 | | Server, patients, encounters, audit, roles created. |
| 2  | chunk-02-code-registry.md | Code-system registry + bindings[] | DONE | 2026-11-21 | | 9 systems; verified-only export. Live tx.fhir.org not tried. |
| 3  | chunk-03-create-screen.md | Unified create screen | DONE | 2026-11-21 | | SDC checkbox, code picker, `sdc.js`. |
| 4a | chunk-04-ai-browser.md | AI in browser, minimal payload | DONE | 2026-11-21 | | Superseded by 4b (no key in browser). |
| 4b | chunk-04-ai-server.md | AI on the server | DONE | 2026-11-22 | | Mock provider only; real provider call not tried. |
| 5  | chunk-05-safety-tests.md | Safety-test pack + CI | DONE | 2026-11-22 | | | 5  | chunk-05-safety-tests.md | Safety-test pack + CI | DONE | 2026-11-22 | | 92 tests (87 pass, 5 todo). CI workflow never run on GitHub yet. |
| 6  | chunk-06-security.md | Security hardening (original) | SPLIT | | | Replaced by 6a to 6e. |
| 6a | chunk-06a-escaping.md | Escape all user text in the page | DONE | 2026-11-22 | page + 1 test file | emr-enhancer.html, test/safety-escaping.test.js, DECISIONS.md. Shared escaper + jsA for handler ids at ~45 sites; 5 hostile-string tests. 97 tests (92 pass, 5 todo). Rest of 6 still TODO. |
| 6b | chunk-06b-headers-cookies-ratelimit.md | Headers, Secure cookie, rate limits | DONE | 2026-11-22 | app.js, auth.js + 1 test | app.js, auth.js, ratelimit.js, test/safety-hardening.test.js, env.txt, DECISIONS.md. Headers, Secure cookie (HTTPS=1), 429 limits on login and writes, audited once per window. 106 tests (101 pass, 5 todo). Per-process limiter. |
| 6c | chunk-06c-db-role.md | Restricted DB role, no DELETE/TRUNCATE | TODO | | 1 migration + config + tests | |
| 6d | chunk-06d-csp.md | Content-Security-Policy (93 inline handlers) | TODO | | decide approach first; may need 2 sessions | |
| 6e | chunk-06e-policy-docs.md | Retention, access, consent notes | TODO | | docs only | |
| 7  | chunk-07-backup-deploy.md | Backup, restore, deploy (original) | SPLIT | | | Replaced by 7a to 7d. |
| 7a | chunk-07a-container-tls.md | Container + TLS | TODO | | Dockerfile, compose, proxy config | |
| 7b | chunk-07b-encrypted-backups.md | Encrypted scheduled backups | TODO | | 1 script + schedule | |
| 7c | chunk-07c-restore-test.md | Restore script + recorded restore | TODO | | 1 script + 1 doc; user does the clean-machine run | |
| 7d | chunk-07d-downtime-golive-docs.md | Downtime page + go-live checklist | TODO | | docs only | |
| 8  | chunk-08-review-workflow.md | Review/approval workflow (original) | SPLIT | | | Replaced by 8a to 8f. |
| 8a | chunk-08a-lint.md | Shared lint module | TODO | | 1 new module + 1 test | |
| 8b | chunk-08b-submit-snapshot.md | Server: submit set for review (snapshot) | TODO | | 1 migration, routes, tests | |
| 8c | chunk-08c-review-rules.md | Reviewer rules + frozen approved version | TODO | | routes, trigger, tests | |
| 8d | chunk-08d-review-ui.md | Review screens + tier badges | TODO | | page + 1 test file | |
| 8e | chunk-08e-signer-from-session.md | Signer/author from session (core-rule gap) | TODO | | page + tests | |
| 8f | chunk-08f-entered-in-error.md | No hard delete of observation rows | TODO | | page + tests | |

Suggested order: numeric. 8e and 8f can be done at any point after 6a (they fix core-rule gaps and do not depend on review work). 6e and 7d are short and can share one session.

## ITEMS ONLY YOU CAN DO (Claude cannot)
- Turn on branch protection for `main` and require the `test` check (GitHub, Settings, Branches).
- Look at the first GitHub Actions run (the workflow has never run).
- Try one real AI provider call (`AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` in `.env` and Render), then tick Enable AI as admin.
- Try the app in a real browser with real synthetic data; Node 20 and other PostgreSQL versions are untested.
- Tick the finished chunks in `emr-plan-chunks/02-roadmap.md` (items 01 to 05 are still unticked there).
- For 7c: perform the restore on a clean machine yourself and confirm the result.

## KNOWN GAPS (5 `test.todo` tests) and where they are fixed
(a) signer/author read from typed box, not session -> 8e. (b) `delRow` splices observation rows -> 8f. (c) TRUNCATE not blocked on patients/encounters -> 6c. (d) signed-note immutability and stale-version conflicts only in the page; element sets, cases and notes are not stored on the server -> partly 8b/8c (sets submitted for review only); full server storage is NOT planned yet. (e) `GET /api/patients/:id/encounters` not audited -> left as is.

## OPEN QUESTIONS
- Plan 8 needs a choice (recorded in DECISIONS.md): only a snapshot goes to the server on "submit for review". If you want sets stored on the server all the time, say so; that is a separate, larger chunk.
- Adding any API route (for example a health check in 7a) makes `test/safety-routes.test.js` fail until the permission matrix there is updated on purpose.
