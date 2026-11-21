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
| 1  | chunk-01-registration-screens.md | Registration screens (patients list, register form, real banner, encounters) | BLOCKED | | | Server code (patients API routes, login/roles, audit log, migrations) is not in this repo. Repo has only the browser demo `emr-enhancer.html`. See Open Questions. |
| 2  | chunk-02-code-registry.md | Code-system registry + `bindings[]` migration | TODO | | | Also needs server migrations; the field model, verifier and FHIR exporter exist only in the demo HTML. See Open Questions. |
| 3  | chunk-03-create-screen.md | Unified create screen (SDC checkbox + code-system picker) | TODO | | | Needs task 2 done. |
| 4a | chunk-04-ai-browser.md | AI in the browser, minimal payload, off by default | DONE | 2026-11-21 | emr-enhancer.html | Done out of order (user chose 4a over blocked tasks 1 and 2). Verified with a jsdom test: off = nothing sent; preview contains the exact request body; payload keys are whitelist only; patient name, MRN, age, dates, values, narrative and notes never appear. Vignette field removed. Optional AI rank added. Existing saved settings with a key stay OFF until the switch is ticked. |
| 4b | chunk-04-ai-server.md | AI on the server | TODO | | | Roadmap lists server-side AI as later, but required by the go-live gate. Needs server repo. |
| 5  | chunk-05-safety-tests.md | Safety-test pack + CI | TODO | | | Most tests need the server. |
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

## OPEN QUESTIONS / BLOCKERS

- **Server code missing (blocks tasks 1, 2, 4b, 5 and parts of 6 to 8).** The repo only has `emr-enhancer.html` (single-file demo, localStorage) and `emr-enhancer-plan.html`. The roadmap says rules engine, alerts, flowsheets, PostgreSQL, login/roles, audit log, conflict screen and registration live in a separate server repo. Please give the repo URL (or attach/commit the server code) so the next "do next" can read the real routes and migrations.
- 4a limit (from the chunk): browser keys can be read by anyone using that browser. Server-side AI (task 4b) is still required by the go-live gate.
- Alternative: if registration screens should be built into the demo HTML against a stubbed API, say so and I'll record that as a decision.
