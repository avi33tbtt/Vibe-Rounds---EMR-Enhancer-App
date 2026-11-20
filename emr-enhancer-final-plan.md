# EMR Enhancer: Final Plan v2 (EMR views are pathways)

*20 Nov 2026. Repo: github.com/avi33tbtt/Vibe-Rounds---EMR-Enhancer-App. This one file replaces `emr-enhancer-build-plan.html`, `emr-enhancer-remaining-plan.md` and `emr-enhancer-micro-plan.md`. Do not paste it into a coding chat; paste only the Context block (section 5) and one task.*

**Next up: V0a**

## Contents
1. Reason and idea
2. The design in short (vocabulary and engine rules)
3. What is built so far
4. What the repo check found
5. How to work, and the Context block
6. Open decisions
7. Manual jobs
8. **PHASE V (do first): EMR views become pathways**
9. Phase 5 (rest): handover time, analytics, tests, security, deploy
10. Phase 6: content lifecycle and marketplace
11. Phase 7: operational components, rewritten as data

---

## 1. Reason and idea

**What went wrong.** The plan said every screen should come from the same engine: element sets (data) plus pathways (bundles of sets), like the disease pathways (DKA, snakebite, fever). Phase 5 chunks 37c and 37d then built the ward screens by hand: the I/O sum is code that names `care.intake_output`, `io_time`, `io_type` and `io_volume`; the ward board and the Handover tab are fixed screens with a fixed list of sections. Phase 7 (orders, MAR, allergies, ADT, charge summary) was about to repeat this with view types called `orders` and `mar` and special logic per component.

**What you want.** No hand-written clinical screens. The EMR views (ward board, handover, orders, MAR, allergies, schedule, I/O sum) are themselves **pathways**: seed content in the registry, versioned, forkable, tiered, installable from the marketplace, exactly like a disease pathway. The code only knows a small, generic vocabulary (how to show a latest value, a sum, a status board, a list of sections). The data says which set and which fields.

**The fix, in order.**
1. **Phase V (first):** define the vocabulary, validate it, build a generic renderer registry, then re-home what is already built (I/O sum, ward board, handover) as pathway data with identical output. Add a test that fails if hand-named sets or fields creep back into code.
2. Finish the rest of Phase 5 as planned.
3. Phase 6 gets two small additions (lint and tests for view data).
4. Phase 7 is rewritten so orders, MAR, allergies, ADT and charge summary are seed sets and view pathways plus a few generic view types, not special screens.

**Why this is better, not only tidier.** One mechanism to secure and test. Facilities can change a ward board or handover layout by editing data (a local draft pathway) with no new release. Marketplace packages can carry whole EMR layouts. A new ward screen costs one data file and, at most, one small generic renderer with a test.

---

## 2. The design in short

Three layers. Only the third is new.

| Layer | What it is | Status |
|---|---|---|
| Sets | Fields, repeat groups, units (`care.vitals`, `care.intake_output`) | unchanged |
| View blocks | Optional declarative blocks inside a set: how its rows are shown | `view.type` flowsheet / fever / dailygrid exist; new optional keys added in Phase V and 7 |
| EMR view pathways | A pathway (`kind:'pathway'`, `contexts:['emr']`) with a `surface` (where it appears) and optional `sections` (what it lists) | new |

**View block keys (all refer to field ids declared in the same set; none holds a dose, threshold, band or rule):**

| Key | Does | First used by |
|---|---|---|
| `summary:[{type:'sumBy', timeField, keyField, valueField, windowsHours, label}]` | plain sum of entered rows per key in a window; never compared to anything | I/O (V4) |
| `board:{show:'latest'}` | what a ward-board cell shows (default latest value and its age) | V5 |
| `banner:{chipField}` | active (not entered-in-error) values as a chip in the patient banner | allergies (49) |
| `statusboard:{statusField, groups:[{label, values}]}` | read-only grouping of rows by status | orders (48) |
| `actions:[{label, field, to, reasonField?, reasonRequired?}]` | one-click row patch of one field, through the existing row route | orders (48) |
| `crosscheck:{against:{setId, field}, textField, message}` | non-blocking note when two typed texts match | MAR (49) |
| `drives:{...}` | informational only, see decision 15 | ADT (50) |

**Surface types (closed list; adding one means a generic renderer plus a test):**

| Surface | Where | Sections / content |
|---|---|---|
| `case_tab` | an extra tab in a patient's chart | `sections[]` (see below) |
| `patients_columns` | columns on the Patients ward board | members, or `columnsFrom:'pinned'` |
| `patients_panel` | a panel on the Patients screen | one member set with an `upcoming` view |
| `banner_chips` | chips in the patient banner | members with a `banner` block |
| `export_section` | a sub-view in Export | sections for the charge summary |

**Section types for `case_tab`:** `narrative`, `activePathways`, `latestValues` (scope applied), `ackedAlerts` (hours), `newRows` (since `lastHandover`), `setTable` (a member set as a table), `statusboard`, `linkedgrid` (MAR).

**Worked examples (data only, no clinical values):**

```json
{"setId":"care.intake_output", "view":{"type":"flowsheet","timeField":"io_time",
 "summary":[{"type":"sumBy","timeField":"io_time","keyField":"io_type","valueField":"io_volume",
             "windowsHours":[8,12,24],"label":"sum of entered rows"}]}}

{"setId":"pathway.emr.ward_board","kind":"pathway","contexts":["emr"],"members":[],"rules":[],
 "surface":{"type":"patients_columns","columnsFrom":"pinned"}}

{"setId":"pathway.emr.handover","kind":"pathway","contexts":["emr"],"members":[],"rules":[],
 "surface":{"type":"case_tab","id":"ho","label":"Handover","print":true},
 "sections":[{"type":"narrative"},{"type":"activePathways"},{"type":"latestValues","scope":"applied"},
             {"type":"ackedAlerts","hours":24},{"type":"newRows","since":"lastHandover"}]}
```

**Engine rules (the "nothing hand-written" test):**

- **E1.** Code (`enhancer.html`, `store.js`, `api.js`) never names a clinical set id, field id or option text. Only seed data and tests do.
- **E2.** Every screen is a registered view, section or surface type plus data.
- **E3.** A new type needs: one pure function, a test that uses a **made-up set** (proves it is generic), a validator entry, one line in `VIEWS.md`.
- **E4.** View data holds ids, labels and display windows only. No doses, thresholds, bands or rules. Pathways stay `rules:[]` in seed.
- **E5.** View pathways are ordinary content: versioned, tiered, forkable, read-only when from the marketplace.
- **E6.** Viewing writes nothing. Writes use the existing row routes with the existing permissions, versions (409) and audit.
- **E7.** The fixed frame stays fixed: patient banner, Summary, Flowsheets, Notes, Pathway, Alerts, Export, Settings and Tools. Safety-critical screens (alerts, notes signing, audit) are not data-driven.

---

## 3. What is built so far

*Source: the three old plan files. Test counts are as last recorded in them (285 after 37b); later counts were not recorded. Run `npm test` and write the number here.*

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

**Not built yet:** 37d4 and 37d5 (last-handover time), analytics on the server (38), the remaining tests (39), security hardening (40), deployment (41), marketplace (42-47), operational components (48-52).

---

## 4. What the repo check found

*Clone of the public repo (single commit `756c4dc`, "5th commit"). I read the code; I did not run `npm test` or open the app.*

1. **Hand-named code (the reason for Phase V).**
   - `enhancer.html` around lines 1507-1511: `sumByType` reads `r.io_time`, `r.io_volume`, `r.io_type`; `ioSum` returns nothing unless `s.setId=='care.intake_output'`.
   - Around line 1853: `boardRow`; line 1860: `handoverData` (fixed list of five sections); line 1893: `renderPatients` builds the board; line 187 and 459: the Handover button and pane are fixed HTML; line 981: the tab dispatcher calls `handoverRender()` by name.
   - Around lines 2418-2435: `ana()` reads `r.temp` directly (analytics, handled in 38 and decision 16).
2. **Four test files are not in `npm test`:** `sum-by-type.test.js`, `board-no-reading.test.js`, `handover-data.test.js`, `handover-view.test.js`. They exist but the `test` script in `package.json` does not run them. Fixed in V0a.
3. `env.example` is still in the repo next to `.env.example` (manual job).
4. The three old plan files are committed in the repo root. After this file is in, delete them or move them out so only this plan remains.
5. Seed pathways are member lists only with `rules:[]`; seed sets have zero rules and thresholds. This is the pattern Phase V keeps.

---

## 5. How to work, and the Context block

**Why chats ran out before.** Your limit is spent on what you paste, what Claude writes back, and how long the chat runs. So every task is one file and one concern, usually 30-90 new lines.

1. New chat. 2. Paste the **Context block** once. 3. Paste the task prompt and only the code on its **Paste** line (`grep -n "name" file` then `sed -n 'A,Bp' file`). 4. Apply edits, `npm test`, commit. 5. Tick the box here. One task per chat; stop when it is done.

Ask for **edits only**: "exact old text to find, new text". Never ask for a whole `enhancer.html`.

**Handover line** (if a chat ran out): `Task <id> partly done. Done: <1 line>. Left: <1 line>. Files changed: <names>.`

```text
Project: EMR Enhancer. Node + Express + PostgreSQL 16, all files in repo root (no folders), single-file client enhancer.html, element-sets.js, cds-rules.js, store.js (window.Store, cache-first), api.js, permissions.js (can(user, action), ROUTE_ACTIONS), audit.js, numbered migrations, node:test + supertest. Demo mode (localStorage) must keep working.
Safety: no pre-filled doses/thresholds/bands; doses are free text, never calculated or summed; AI drafts only; unapproved rules never fire; data shown as recorded, no judgement of care; every write carries the version last seen (409 on conflict) and writes one audit row in the same transaction; follow mergedInto for patients; keep the "Not for clinical use" banner; new routes need an action in permissions.js and an entry in the audit-coverage test.
No hand-written clinical screens: code never names a clinical set id, field id or option text. Every EMR screen is a registered view/section/surface type plus data in a seed set or an EMR view pathway (contexts ['emr'], surface, sections). A new generic type needs a pure function, a test that uses a made-up set, a validator entry and a line in VIEWS.md. View data holds ids, labels and display windows only.
Reply format: edits only (exact old text to find + new text), never whole files. Under ~90 new lines. If more is needed, stop and list what is left.
```

---

## 6. Open decisions

Answer before the task that needs it, or accept the default.

| # | Default | Needed by |
|---|---|---|
| 1 | Locked-account sign-in attempts are not logged | 40b |
| 2 | Admin may chart, approve and sign | 39 |
| 3 | Informatician cannot open patients | 44, 46 |
| 6 | Patient searches not audited; opening a record is | 40c |
| 8 | Audit CSV omits before/after contents | 40c |
| 9 | Reference-data conflicts offer only "Reload the app" | done |
| 10 | Two reviewers for packages with rules | 44a2d |
| **11** | **Who turns EMR view pathways on:** admin picks the facility's active view pathways in Settings (stored in `app_settings`, audited); everyone sees them. Not a per-case "apply", so the rule "a nurse cannot apply pathways" is not in the way. | V7 |
| **12** | **Orders entry:** optional set-level `entryRoles` (data) enforced by the server; `care.orders` sets it to doctor and admin, `care.mar` leaves it open to nurses. | 48a0 |
| **13** | **Which version of a view block a case uses:** the version recorded on the case (same as fields). Only synthetic data exists today, so after a seed bump, re-apply the set on test cases. Revisit before real patients. | V4b |
| **14** | **MAR link:** the MAR row stores a copy of the order text plus the order row id in a plain text field, no new field type. | 49b |
| **15** | **ADT vs Encounter:** the server's encounter record owns ward and bed (one open encounter per bed). ADT rows are informational and never change it silently; a button "Apply to encounter" calls the existing encounter route. | 50a |
| **16** | **Analytics cards:** stay as they are for now; their hand-named lines sit on the allow-list until 38a4. Make them data-declared later only if you want. | 38a4 |
| **17** | **Fixed frame:** Summary, Flowsheets, Notes, Pathway, Alerts, Export stay fixed (E7). Say if you want more of them made data-driven. | V7 |

---

## 7. Manual jobs (not tasks)

- [ ] Force a conflict on one row in two browsers; confirm the side-by-side screen.
- [ ] Idle a session out with an unsent reading; sign in again; confirm it is sent.
- [ ] As admin run Settings > Import from this browser; confirm a doctor does not see it.
- [ ] `git rm env.example` (keep `.env.example`).
- [ ] After V8c: remove the three old plan files from the repo root.

---

# PHASE V (do first): EMR views become pathways

Goal: what 37c and 37d built by hand becomes seed data plus generic renderers, with **identical output**. Nothing new for the user to see except that Settings can switch view pathways on or off. Order matters: V0 to V8, one task per chat.

## V0. Housekeeping and inventory

### [ ] V0a. Put the four orphan tests into `npm test`
**File:** package.json | **Paste:** the `"test"` line only
```text
Add sum-by-type.test.js, board-no-reading.test.js, handover-data.test.js and handover-view.test.js to the test script. Change nothing else. Tell me if any of them fail.
```
**Done when:** `npm test` runs them; write the new total in section 3.

### [ ] V0b. Hand-code inventory (no code)
**Run yourself, paste the output:**
```text
grep -n "care\.intake_output\|io_time\|io_type\|io_volume" enhancer.html store.js api.js
grep -n "handoverRender\|boardRow\|sumByType\|ioSum\|data-shell-t=\"ho\"\|id=\"ho\"" enhancer.html
```
```text
Do not change code. From this output list every place that names a clinical set, field or option in code. For each, say which Phase V task removes it (V4, V5, V6, V7) or that it must stay (seed data, tests). Reply as a table.
```
**Done when:** the table is pasted under V8a as the allow-list starting point.

## V1. Write the vocabulary down

### [ ] V1a. VIEWS.md (doc only)
**File:** new `VIEWS.md` | **Paste:** section 2 of this plan
```text
Write VIEWS.md in the repo root from this text: layers, view block keys, surface types, section types, the three JSON examples, engine rules E1-E7. Add one empty "How to add a new type" checklist (pure function, made-up-set test, validator entry, doc line). No code.
```
**Done when:** VIEWS.md exists and matches section 2.

## V2. Validate view data (no screens)

### [ ] V2a. `views.js`: validateView(set)
**File:** new root `views.js` (browser + Node, ends with `if(typeof module!=='undefined')module.exports=...`) | **Paste:** VIEWS.md key table, one seed set (care.intake_output)
```text
Create views.js with validateView(set) returning {errors, warnings}. Errors: unknown view key or type; a referenced field id missing from the set; summary timeField not a datetime, valueField not number/integer, keyField not text/select; windowsHours not positive integers (max 8 entries); any key named eval or function; any key named threshold, band, dose, limit, target or default. Plus views.test.js: one passing case from the I/O example and one failing case per error, using a made-up set, not a seed set.
```

### [ ] V2b. Validate on seed and on save
**Files:** seed.js, api.js (element-sets create route) | **Paste:** the seed loop, the set create/update route
```text
Call validateView in seed.js (a seed with a bad view stops seeding with the set id in the message) and in the set create and update routes (422 with the error list). Test: a set with a bad view is refused; the real element-sets.js still seeds.
```

### [ ] V2c. `validatePathwayViews(pathway)`
**File:** views.js | **Paste:** the two pathway examples in VIEWS.md
```text
Add validatePathwayViews(p) for pathways whose contexts include "emr": surface.type must be in the closed list; case_tab needs id, label; every section type must be in the closed list; hours/windows positive integers; rules must be []; members must exist as set ids (checked by the caller). Tests: one failing case per error, one passing for ward_board and handover examples. Call it from seed.js and the set routes beside validateView.
```

## V3. Generic client engine (no change in behaviour)

### [ ] V3a. View registry and one dispatcher
**File:** enhancer.html | **Paste:** the view-type dispatcher (about line 1052: fever, dailygrid, flowsheet branches)
```text
Add VIEWS={} and registerView(type, fn). Register the existing fever, dailygrid and flowsheet renderers unchanged. Replace the if-chain with one function renderSetView(set, group, rows) that looks up VIEWS[set.view.type] and falls back to the old "could not be drawn" text. Output must be byte-identical.
```
**Done when:** `npm test` passes; open a fever chart, daily grid and flowsheet by hand and compare.

### [ ] V3b. Pure helpers
**File:** views.js (browser + Node) | **Paste:** `rowT`, `fnum` and how `__status` is read
```text
Add pure helpers rowsInWindow(rows, timeField, fromMs, toMs) (skips entered_in_error and unreadable times) and fieldsById(set). Tests with a made-up set: window edges, entered_in_error, bad time.
```

## V4. I/O sum becomes data

### [ ] V4a. `sumBy(rows, spec, fromMs, toMs)`
**Files:** views.js, sum-by-type.test.js | **Paste:** sumByType, sum-by-type.test.js
```text
Add sumBy(rows, spec, fromMs, toMs) with spec {timeField, keyField, valueField}: same behaviour as sumByType (plain numbers per key, entered_in_error skipped, '(no type)' key). Port the 5 cases in sum-by-type.test.js to call sumBy with the I/O field names passed in the test, and add one case with a different made-up set. Do not touch enhancer.html yet.
```

### [ ] V4b. Put the summary in the I/O seed (data only)
**Files:** element-sets.js, io-set.test.js | **Paste:** the care.intake_output entry, view example from section 2
```text
Add the "summary" block from the I/O example to care.intake_output's view and bump its version to 2. Do not change fields. Update io-set.test.js: validateView passes; the set still has zero rules, thresholds, limits and defaults.
```

### [ ] V4c. Render summaries from the view block
**File:** enhancer.html | **Paste:** ioSum, IOW state, where ioSum is called
```text
Replace ioSum with renderSummaries(set, rows): for each entry of set.view.summary of type sumBy, show the window choice from windowsHours and one line per key using sumBy. Label from the data ("sum of entered rows"). Keep the window choice state per set id. Delete sumByType and every mention of care.intake_output and io_ from enhancer.html. Same text and layout as before. Server mode only as before.
```
**Done when:** `grep -n "intake_output\|io_" enhancer.html` finds nothing; I/O flowsheet looks the same on a case that has the set re-applied (decision 13).

### [ ] V4d. Proof test: a made-up set gets a sum with no code change
**File:** new `views-generic.test.js` | **Paste:** how an existing jsdom or vm test loads functions from enhancer.html
```text
Test: define a made-up set "test.fluids" with different field ids and a sumBy block; renderSummaries shows its sums; remove the block and nothing is shown. No code change outside the test.
```

## V5. Ward board becomes a pathway

### [ ] V5a. Seed `pathway.emr.ward_board` (data only)
**Files:** element-sets.js, new `emr-views.test.js` | **Paste:** the ward_board example from section 2, one seed pathway
```text
Add pathway.emr.ward_board to the seed pathways exactly as in section 2 (members [], rules [], surface patients_columns, columnsFrom pinned). Test: it validates with validatePathwayViews and seeds read-only.
```

### [ ] V5b. Board columns come from the active surface
**File:** enhancer.html | **Paste:** `boardRow`, the board part of `renderPatients`, `pinListFor`
```text
Add emrSurfaces(type) returning the active EMR view pathways whose surface.type matches (until V7, treat pathway.emr.ward_board as active when found). boardRow takes its column list from the surface: "pinned" uses pinListFor, otherwise the pathway's members. Output unchanged; update board tests.
```

### [ ] V5c. Cell content from the set's `board` block
**File:** enhancer.html | **Paste:** boardRow, the 37c5 no-reading code
```text
A cell shows what set.view.board says; default {show:'latest'} gives latest value and age as now. Leave the "No reading for N min" logic (approved minutes_since_gt rule only) untouched. board-no-reading tests must still pass; with no rule no such text appears anywhere.
```

## V6. Handover becomes a pathway

### [ ] V6a. Seed `pathway.emr.handover` (data only)
**File:** element-sets.js, emr-views.test.js | **Paste:** the handover example from section 2
```text
Add pathway.emr.handover as in section 2. Test: validates; rules []; seeds read-only.
```

### [ ] V6b. Section registry (pure data functions)
**File:** enhancer.html | **Paste:** handoverData
```text
Split handoverData into SECTIONS = {narrative, activePathways, latestValues, ackedAlerts, newRows}, each a pure function (case, spec, ctx) returning its data. Add sectionsData(c, sections, ctx). handoverData(c, sinceMs) becomes sectionsData with the seed pathway's sections and must return the same object. handover-data.test.js must pass unchanged.
```

### [ ] V6c. Render by section type
**File:** enhancer.html | **Paste:** handoverHtml and handoverRender
```text
Render each section by type from a SECTION_HTML registry in the order the pathway lists. No colours, flags or judgement text. Print CSS from 37d3 stays. Add a made-up pathway in a test with only two sections and check only those two show. handover-view.test.js passes.
```

## V7. Surfaces: tabs and columns come from active pathways

### [ ] V7a. Active view pathways setting (server)
**Files:** api.js, permissions.js, audit | **Paste:** the app_settings routes for the AI switch (36a)
```text
Add key emr_views (list of pathway ids, default ["pathway.emr.ward_board","pathway.emr.handover"]) to app_settings. GET returns it (all roles, also in /me); PUT is admin only, new action views.admin, checks each id is an existing pathway with contexts "emr", carries the version, writes one audit row. Tests: nurse refused, bad id refused, audit row exists, role matrix and audit-coverage entries added.
```

### [ ] V7b. Client reads the list
**Files:** store.js, enhancer.html | **Paste:** how `/me` AI flag is read in Store
```text
Store.emrViews() returns the active ids (server mode from /me; Demo mode uses the default list). emrSurfaces(type) uses it instead of the temporary rule from V5b.
```

### [ ] V7c. Case tabs built from `case_tab` surfaces
**File:** enhancer.html | **Paste:** the tab button row (line ~187), the Handover pane (line ~459), the dispatcher line (~981)
```text
Remove the fixed Handover button and pane. Build extra tab buttons and panes from emrSurfaces('case_tab') after the fixed tabs; the dispatcher calls the section renderer for that pathway. If the pathway is switched off the tab is absent. Keep keyboard shortcuts for the fixed tabs.
```

### [ ] V7d. Settings: choose view pathways
**File:** enhancer.html | **Paste:** the Settings AI switch block
```text
Admin-only list in Settings: every EMR view pathway with a checkbox and its description; Save calls the V7a route with the version; plain error text. Non-admins see the list read-only.
```

## V8. Keep it that way

### [ ] V8a. No-hand-code guard test
**File:** new `no-handcode.test.js` | **Paste:** the V0b table
```text
Test: read element-sets.js, collect every seed set id and every seed field id (skip generic ids shorter than 4 characters). Scan enhancer.html, store.js and api.js for those strings as quoted words or property names (r.<id>). Fail on any hit not on ALLOW (an array of "file:line-pattern" strings). Start ALLOW from the V0b table (ana() lines only). The test prints the ALLOW size so it can only shrink.
```
**Done when:** the test passes and ALLOW holds only analytics lines.

### [ ] V8b. Safety tests for view data
**File:** safety.test.js (new if missing) | **Paste:** nothing
```text
Add tests: every seed view block passes validateView; no view block or surface has a threshold, band, dose, limit, target or default key; every seed pathway with contexts "emr" has rules [] and passes validatePathwayViews; seed view pathways have tier seed and are read-only; removing the whole `summary` key leaves the set usable.
```

### [ ] V8c. Docs
**Files:** VIEWS.md, API.md | **Paste:** the new routes from V7a
```text
Update API.md with the emr_views routes and VIEWS.md with the final key and section lists. Replace the Context block in the repo README with the one in this plan (section 5).
```
**Release gate for Phase V:** I/O sum, ward board and handover look the same as before; no clinical set or field name remains in code except on the V8a allow-list; switching the Handover pathway off removes its tab.

---

# PHASE 5 (rest): standalone EMR

## 37d (rest). Handover: last-handover time

*Do after V6. The handover view already has a `newRows` section with `since:'lastHandover'`; these two tasks supply that time.*

### [ ] 37d4. Last-handover time (server)
**Files:** api.js + one migration only if needed | **Paste:** the user_prefs routes
```text
Store a per-user "last handover" time per case in user_prefs (set by a POST that uses server time, read by GET). Add the action to permissions.js and the audit-coverage test.
```

### [ ] 37d5. "Mark handover done" button (generic)
**Files:** enhancer.html, store.js | **Paste:** Store prefs methods, the section renderer for newRows
```text
In a case_tab whose sections include newRows with since 'lastHandover', show "Mark handover done" using the 37d4 route. ctx.sinceMs comes from it (default: start of the encounter). The button appears because of the section, not because of a tab name.
```

---

## 38. Shared analytics

### [ ] 38a0. List the analytics cards (no code)
*Note (v2): ana() still reads hand-named fields. Its lines stay on the allow-list in V8a until 38a4 replaces them; see decision 16.*
**Paste:** the ana() function (or just its card names and which case fields each reads)
```text
Do not write code. List every card ana() produces, the inputs each reads, and group them into 3-4 groups of similar cards. This list drives 38a3.
```
**Done when:** you have the card list saved in this file under 38a3.

### [ ] 38a1. Filters helper (server)
**File:** api.js | **Paste:** one existing list route's query parsing
```text
Add parseScopeFilters(query) returning {scopeType, scopeId, from, to, ward} with validation (bad value -> 400). Pure function + 6 tests. No route yet.
```

### [ ] 38a2. First aggregate endpoint
**Files:** api.js, permissions.js | **Paste:** the simplest card's code from ana(), parseScopeFilters
```text
Add GET /api/analytics/<card> for the simplest card only, aggregates only (no patient list), using parseScopeFilters. Add the action, and a fixture test that the numbers equal the old client computation for the same fixture.
```

### [ ] 38a3. Remaining cards (repeat once per group from 38a0)
**Paste:** that group's card code + the 38a2 endpoint as a model
```text
Add one endpoint per card in this group, same pattern as 38a2, with a fixture test per card.
```
Groups: [ ] A  [ ] B  [ ] C  [ ] D

### [ ] 38a4. Client ana() calls the endpoints
**File:** enhancer.html | **Paste:** ana() and one card renderer
```text
In server mode, ana() fetches each card from its endpoint (through Store); Demo mode keeps the local computation and the synthetic-case buttons. Show loading and error text.
```

### [ ] 38a5. Patient lists need doctor or admin
**Files:** api.js, permissions.js | **Paste:** the drill-down code if any
```text
Make sure any route returning patient lists from analytics needs doctor or admin; others return aggregates only. Add a role-matrix test line for each.
```

### [ ] 38b1. Masking function
**File:** api.js (or a new root file masking.js if cleaner) | **Paste:** nothing
```text
Pure function maskCounts(table, {min:5}) turning cells under 5 into '<5' and masking one more cell in a row or column when a single masked cell could be recovered from a total. 10 tests.
```

### [ ] 38b2. Apply masking to endpoints
**File:** api.js | **Paste:** one endpoint, maskCounts
```text
Pass every analytics endpoint result through maskCounts. Test that a count of 3 never appears as 3.
```

### [ ] 38b3. De-identified CSV export (server)
**Files:** api.js, audit.js | **Paste:** the rules-inforce CSV code (formula-safe model)
```text
GET /api/analytics/export.csv: masked aggregates, no name, MRN, phone, national id; dates as days since encounter start; formula-safe; one audit row with the filter used. Action + tests.
```

### [ ] 38b4. De-identified FHIR export
**Files:** api.js | **Paste:** buildBundle
```text
Same rules as 38b3 for a FHIR bundle of the filtered cases: no identifiers, no exact dates, audited with its filter. Tests that no identifier string appears.
```

### [ ] 38b5. Export buttons
**File:** enhancer.html | **Paste:** analytics toolbar code
```text
Add two buttons (CSV, FHIR) to analytics, visible only if Store.can for the action. Plain messages for errors.
```

---

## 39. Tests

### [ ] 39a1. Permission matrix gaps
**Paste:** file names of existing tests only
```text
No code changes. Tell me what role x route cases the existing matrix test might miss and give only the new test blocks needed.
```

### [ ] 39a2. Concurrency tests
**Paste:** the rows append route
```text
Tests: 10 parallel row appends all succeed; two edits with the same version give exactly one 409.
```

### [ ] 39a3. Audit coverage gaps
**Paste:** the audit-coverage test list
```text
List write routes missing from the audit-coverage test and add them. Tests only.
```

### [ ] 39a4. npm scripts
**File:** package.json | **Paste:** package.json
```text
Add scripts test:server and test:safety (pattern match on file names). Do not move files.
```

### [ ] 39b1. Safety: seed sets
**Paste:** a loader snippet for element-sets.js
```text
New safety.test.js block: every seed set has zero rules, thresholds, bands, defaults and limits.
```

### [ ] 39b2. Safety: rules that never fire
**Paste:** evalRules, how tests load cds-rules.js
```text
Add tests: unapproved rule never fires; unit-mismatched rule never fires; disabled never fires.
```

### [ ] 39b3. Safety: bundle contents
**Paste:** buildBundle (first 30 lines)
```text
Add tests: bundle has no protocol bands, no fever thresholds, no rule text.
```

### [ ] 39b4. Safety: doses and errors
```text
Add tests: no function sums or converts dose text (search the code for banned patterns in a test); entered_in_error rows are hidden in the UI data but present in the database.
```

### [ ] 39b5. Migration test
**Paste:** migration runner
```text
migration.test.js: fresh database runs all migrations; upgrade from the previous migration works.
```

### [ ] 39c1. Playwright: install and login
```text
Add Playwright as a dev dependency and one test: open app, log in as a seeded test user, see the banner.
```

### [ ] 39c2. Playwright: new patient and a vitals row
**Paste:** element ids from the New patient dialog and vitals entry
```text
Extend: register a patient, start an encounter, add a vitals row, see it in the table.
```

### [ ] 39c3. Playwright: conflict
```text
Extend: two browser contexts edit one row; second save shows the conflict screen.
```

### [ ] 39c4. CI workflow
**Paste:** package.json scripts
```text
Add .github/workflows/ci.yml: PostgreSQL service, npm ci, test:server, test:safety, Playwright. Add script test:all.
```

---

## 40. Security

### [ ] 40a1. Find every unescaped insertion (list only)
**Paste:** output of `grep -n "innerHTML" enhancer.html`
```text
Do not fix anything. From these lines, list which insert a user-controlled string (narrative, notes, set titles, rule text, patient names, error messages) without escaping. Group them in three batches.
```

### [ ] 40a2. esc() helper and batch 1
**Paste:** the batch 1 lines
```text
Add one esc() helper (if missing) and fix batch 1.
```

### [ ] 40a3. Batch 2 (same prompt, batch 2 lines)
### [ ] 40a4. Batch 3 (same prompt, batch 3 lines)

### [ ] 40a5. XSS test
```text
Add a test or checklist: put <img src=x onerror=alert(1)> into every free-text field and confirm it is inert.
```

### [ ] 40a6. CSP plan (no code)
**Paste:** server.js static serving
```text
Do not change code. Recommend nonces vs moving inline script/style to files for this repo, with the exact steps and risks.
```

### [ ] 40a7. CSP implement
**Paste:** server.js static serving, the chosen plan
```text
Implement the chosen CSP approach in the smallest change. Say what I must test by hand.
```

### [ ] 40b1. Headers, HSTS, body limits
**File:** server.js | **Paste:** server.js middleware section
```text
Add security headers, HSTS (behind proxy), body size limits. No other change.
```

### [ ] 40b2. SQL review (one file per chat: api.js / patients.js / auth.js)
**Paste:** that one file
```text
Review every query for parameterisation. List problems with line numbers and the fix.
```
Files: [ ] api.js  [ ] patients.js  [ ] auth.js  [ ] other

### [ ] 40b3. DB roles migration
**Paste:** migration runner, existing role setup
```text
Migration + notes: migration role with DDL, app role without DDL, audit_log without UPDATE/DELETE for the app role.
```

### [ ] 40b4. Cookies and session fixation
**Paste:** session code in auth.js
```text
Check cookie flags and that a new session id is issued at login. Fix only what is wrong.
```

### [ ] 40b5. npm audit
```text
I paste `npm audit` output; list which findings matter and the safest upgrade for each.
```

### [ ] 40c1. Retention note (doc only)
```text
Write RETENTION.md: retention setting suggestions; no automatic deletion of clinical data.
```

### [ ] 40c2. Subject-access export (server)
**Paste:** patients routes list, audit.js
```text
Admin-only route returning one patient's data as JSON, audited, following mergedInto. Action + test.
```

### [ ] 40c3. Consent field (server)
**Paste:** patients table, create/update routes
```text
Optional consent fields on patients (migration + API + test). Not required unless a setting says so.
```

### [ ] 40c4. Consent field (screen)
**Paste:** the Find or register dialog form
```text
Show the consent fields only when the setting is on.
```

### [ ] 40c5. Regulatory checklist (doc only)
```text
Write REGULATORY-CHECKLIST.md: what I must confirm for health-data law, medical-device-software and national digital health rules where this runs, and the top 10 risks. No legal conclusions.
```

---

## 41. Deploy

### [ ] 41a1. Dockerfile
**Paste:** package.json, server.js start lines
### [ ] 41a2. docker-compose.prod.yml
### [ ] 41a3. TLS reverse proxy config (Caddy or nginx)
### [ ] 41a4. `.env.example` list and MIGRATING.md steps
```text
(one file per task) Produce only this file, root level, minimal. No clinical changes.
```

### [ ] 41b1. backup.sh (pg_dump, encrypt, retention)
### [ ] 41b2. restore.sh
### [ ] 41b3. RESTORE-TEST.md (restore to clean DB, run test:safety, compare row counts)
### [ ] 41b4. Health check, uptime alert idea, log rotation
**Done when (release gate):** a backup restores onto a clean database and the app reads it.

### [ ] 41c1. DOWNTIME.md (paper forms; back-entry records original time and entry time)
### [ ] 41c2. GOLIVE.md (named clinician review, training, synthetic pilot, limited real use, banner removed only after sign-off)

---
-e 
---

# PHASE 6: content lifecycle and marketplace

Facts every Phase 6 chat needs: marketplace content is read-only and hash-pinned; hash = SHA-256 of canonical JSON of `content` (keys sorted, no whitespace); tiers are marketplace-verified, local-reviewed, local-draft; the server enforces read-only (the UI only mirrors it); reviewer is never the author; packages contain definitions only, never patient data.

## 42a. package-lint.js (new root file, browser + Node, ends with `if(typeof module!=='undefined')module.exports=...`)

### [ ] 42a1. canonicalJson and sha256Hex + tests
```text
Create package-lint.js with canonicalJson(obj) and async sha256Hex(text) (crypto.subtle or node:crypto), and package-lint.test.js: same hash when keys are in a different order. Nothing else.
```
### [ ] 42a2. lintPackage skeleton: manifest, semver, id pattern
**Paste:** the manifest shape (package file, 6 lines)
```text
Add lintPackage(pkg) returning {errors, warnings} with errors: bad manifest, bad semver, bad id pattern. One failing test per error plus one passing package.
```
### [ ] 42a3. Errors: unknown field type, content over 1 MB, key named eval or function, any view block or EMR surface that fails `validateView` / `validatePathwayViews` (from V2)
### [ ] 42a4. Errors: rule op not whitelisted, threshold not a finite number
**Paste:** whitelisted operators from cds-rules.js
### [ ] 42a5. Errors: band/rule/dose-like text without a references entry
### [ ] 42a6. Errors: patient-like strings (phone, long digit runs, "MRN", "patient name") with the path
### [ ] 42a7. Warnings: coding not in verified table, empty rationale, duplicate field ids
```text
(for 42a3-42a7, same prompt each time) Extend lintPackage with ONLY the listed checks and one failing test per check. Earlier tests must still pass.
```

## 42b. Tier badges and read-only
*Note (v2): EMR view pathways (Phase V) are ordinary pathways, so they get the same tier, badge, read-only and fork rules. Nothing extra to build; V8b tests that seed view pathways load as tier seed.*

### [ ] 42b1. Registry fields with defaults
**Paste:** where registry entries are created/loaded
```text
Add source, readOnly, tier, forkedFrom, package to registry entries; old entries default to source seed/local, tier local-draft. No UI.
```
### [ ] 42b2. tierBadge(entry) helper and badge on set cards
### [ ] 42b3. Badge on the Pathway tab and '+ Add' list
### [ ] 42b4. readOnly sets render without edit controls (applying and entering values still allowed)
**Paste:** set card renderer / editor entry points
### [ ] 42b5. Guard the save functions for readOnly sets (not only the UI)
**Paste:** the set save functions
### [ ] 42b6. Server refuses PATCH/DELETE on read_only element_sets (403)
**Paste:** element_sets routes; add test
### [ ] 42b7. Fork to local copy
```text
New setId local.<slug>, version 1, tier local-draft, forkedFrom {setId, version, contentHash}; never changes the original. Editing a local-reviewed set makes a new draft version.
```

## 42c. Import package file and Provenance

### [ ] 42c1. Tools > Import package file: read JSON, run lintPackage, show errors/warnings
### [ ] 42c2. On success: recompute hash locally, store as marketplace, readOnly, tier marketplace-verified (Demo mode only)
### [ ] 42c3. buildBundle Provenance lists package id, version, contentHash, tier per applied set

## 43. Request a feature

### [ ] 43a1. "Request a feature" box and output choice (UI only)
### [ ] 43a2. Send the sentence plus registry ids/titles/field ids/units to the chunk-36 route; validate output (ids exist, operators whitelisted, thresholds appear in sentence, no doses, codes empty)
### [ ] 43a3. Save a valid draft as local-draft with provenance {requestText, model, at}; "My drafts" list
### [ ] 43b1. Run lintPackage live on a draft; plain-language errors
### [ ] 43b2. Block applying any unapproved draft to a real case (in code, with message); "Try it" only on Demo/synthetic
### [ ] 43b3. review_requests migration and submit route (status submitted, validated body)
### [ ] 43b4. "Submit for review" button (zero lint errors only); editing a submitted version creates a new version and withdraws the request
### [ ] 43b5. Tests: invalid AI output saves nothing; draft cannot be applied to a real case; submit refused with lint errors

## 44. Review (informatician)

### [ ] 44a1a. permissions.js for informatician (review and approve content, install packages, no charting) + role tests
### [ ] 44a1b. Queue route (submitted, in_review, changes_requested) + tests
### [ ] 44a1c. Get-one route re-running lintPackage on the server + tests
### [ ] 44a2a. Approve route: reviewer from session, freeze version as local-reviewed, review_events and audit_log in one transaction
### [ ] 44a2b. Rules/bands/dose-like text need two distinct approving reviewers (configurable, default 2)
### [ ] 44a2c. Request-changes and reject routes (comment required)
### [ ] 44a2d. Tests: author cannot review (403); one approval not enough; missing comment refused; rollback leaves no half rows
### [ ] 44b1. Tools > Review: queue list
### [ ] 44b2. Review page: request text, AI provenance, fields and rules in plain language, server lint result
### [ ] 44b3. Diff against previous version
### [ ] 44b4. Checklist (schemaValid automatic, others ticked, codesVerified vs verified_codes) and Approve / Request changes / Reject buttons
### [ ] 44c1. Tests: approved version immutable; edit after approval makes a draft; every action writes review_events and audit_log; informatician cannot chart

## 45. Registry repo (separate repo: emr-enhancer-registry; needs neither server nor app)

### [ ] 45a1. Layout: packages/<id>/<version>/package.json, README, CONTRIBUTING, LICENSE (MIT), CONTENT-LICENSE placeholder
### [ ] 45a2. CODEOWNERS, PULL_REQUEST_TEMPLATE (review checklist), three ISSUE_TEMPLATE files, GOVERNANCE stub
### [ ] 45b1. scripts/build-index.js
### [ ] 45b2. scripts/verify.js (+ tiny test): recompute hash and compare; refuse edits to merged version folders
### [ ] 45b3. .github/workflows/ci.yml (lint changed packages, check package-lint.js matches the app copy, rebuild index in a check job)
### [ ] 45c1. release.yml: ed25519 signing from secrets (node:crypto), publish index.json and index.json.sig, never commit a private key
### [ ] 45c2. withdrawn.json by PR with reason, shown in the index
### [ ] 45c3. Protection checklist (CODEOWNERS review, no force-push, no tag deletion, signed commits; check GitHub's current docs) and key rotation/loss notes in GOVERNANCE.md

## 46. Marketplace

### [ ] 46a1a. GET /api/market: fetch index and signature from one allow-listed base URL (env), admin/informatician only
### [ ] 46a1b. Verify signature with the pinned public key; refuse if invalid
### [ ] 46a1c. ETag cache; tests: wrong signature, unlisted host, tampered index refused
### [ ] 46a2a. POST /api/market/install: fetch package, recompute hash vs signed index, run lintPackage, check requires/minAppVersion
### [ ] 46a2b. Store in element_sets (source marketplace, read_only, tier marketplace-verified) plus installed_packages in one transaction with audit; rules and bands arrive enabled:false
### [ ] 46a2c. Tests: tampered package, hash mismatch, failed lint all store nothing; read-only rows refuse PATCH/DELETE
### [ ] 46b1. Marketplace screen: list, search, filter by kind
### [ ] 46b2. Preview panel (members, fields, rule count, reviewers, license, short hash, versions, withdrawn flag)
### [ ] 46b3. Install button, installed badge, loading and error states
### [ ] 46c1. Update side by side; existing cases keep their version
### [ ] 46c2. Withdrawn banner on Summary and Pathway tab with reason; block new use; delete nothing
### [ ] 46c3. Install from file (no internet) with identical checks
### [ ] 46c4. Uninstall only if no case uses it, else mark retired
### [ ] 46c5. "Needs local enable" for rules and bands; doctor/admin enables (server stamps user and time, audited)
### [ ] 46d1. Build composite pathway with pinned members, one nested level, cycle check
### [ ] 46d2. Composite tier = weakest member (marketplace-verified only if all are); member badges; tests

## 47. Governance

### [ ] 47a1. Safety tests: marketplace content cannot be edited by any route; fork leaves original unchanged; changed byte fails hash; bad signature refused
### [ ] 47a2. Safety tests: patient-like strings fail lint; package rules never fire until enabled; withdrawn warns and blocks; Provenance lists id/version/hash/tier; case keeps its version after update; reviewer is not author
### [ ] 47b1. GOVERNANCE.md: what "verified" means (peer review, not regulatory approval), reviewers, conflict of interest, two-reviewer rule, recall process
### [ ] 47b2. GOVERNANCE.md: content license, pre-release checklist (SNOMED/LOINC licence, device-software rules, privacy, disclaimer), top 10 risks

---
-e 
---

# PHASE 7: operational components, rewritten as data

Orders, allergies, MAR, ADT and charge summary are **seed sets plus EMR view pathways plus a few generic view types**, using the Phase V engine. No `orders` or `mar` screen exists in code. Each generic type is proven with a made-up set (rule E3).

Rules for every Phase 7 chat: zero pre-filled doses, thresholds or rules; discontinuing never hard-deletes; doses free text only; unverified billing codes omitted; Context block from section 5 applies.

Prerequisite: Phase V finished (V8 gate).

## 48. Orders

### [ ] 48a0. Optional `entryRoles` on a set (server)
**Files:** api.js, permissions.js | **Paste:** the rows append and patch routes, how the care-set rule for nurses is checked
```text
Add optional set field entryRoles (array of roles). When present, the rows append and patch routes also require the user's role to be in it (403 with a plain sentence); when absent, today's rules apply unchanged. validateView-style check on save: roles must be known. Tests: set without it behaves as before; set with ["doctor","admin"] refuses a nurse; audit unchanged.
```

### [ ] 48a1. `care.orders` seed (data only)
**File:** element-sets.js | **Paste:** one care set from element-sets.js, the orders group from the list below
```text
Add care.orders (kind care, direct true, quick order 6 short 'Orders', entryRoles ["doctor","admin"]). Repeat group "orders": ord_time datetime, ord_category select (Medication, Lab, Imaging, Nursing, Consult, Diet), ord_item text, ord_instructions text (free text), ord_priority select (Routine, Urgent, STAT), ord_status select (Draft, Active, Completed, Discontinued), ord_reason text, ord_by session user. View block: {"type":"flowsheet","timeField":"ord_time","statusboard":{"statusField":"ord_status","groups":[{"label":"Active","values":["Draft","Active"]},{"label":"Closed","values":["Completed","Discontinued"]}]},"actions":[{"label":"Complete","field":"ord_status","to":"Completed"},{"label":"Discontinue","field":"ord_status","to":"Discontinued","reasonField":"ord_reason","reasonRequired":true}]}. No doses or rules.
```

### [ ] 48a2. Generic `statusboard` view (read only)
**Files:** views.js (validator), enhancer.html | **Paste:** the registry from V3a, the orders block above
```text
Register a statusboard renderer: rows grouped by the status field into the groups from the data, newest first, each row as its typed values. Add statusboard to validateView (statusField must be a select; group values must exist among its options). Test with a made-up set, not care.orders.
```

### [ ] 48b1. Generic row `actions`
**Files:** enhancer.html (+ api.js only if a check is missing) | **Paste:** the row patch code in Store, the statusboard renderer
```text
Render each action as a button on a row. Click patches only the named field through the existing row patch route (version sent, audit by the existing route). If reasonRequired, ask for a reason and send it in reasonField; no reason, no change. Never delete. Test with a made-up set: reason required, row kept, status changed, version conflict shows the usual conflict path.
```

### [ ] 48b2. FHIR mapping from the set's data
**Files:** enhancer.html (buildBundle) | **Paste:** buildBundle, the orders `fhir` block below
```text
Add a "fhir" block to care.orders: {"resource":"ServiceRequest","variants":[{"whenField":"ord_category","equals":"Medication","resource":"MedicationRequest"}],"statusMap":{"Draft":"draft","Active":"active","Completed":"completed","Discontinued":"revoked"},"textField":"ord_instructions"}. buildBundle gets one generic function that maps rows by such a block (instructions text exactly as typed). Test: a made-up set with a different block maps correctly; orders export keeps typed text unchanged.
```

## 49. Allergies and MAR

### [ ] 49a1. `care.allergies` seed (data only)
**File:** element-sets.js | **Paste:** one care set
```text
Add care.allergies, repeat group "allergies": substance text, reaction text, severity select (Mild, Moderate, Severe), recorded_at datetime. View block: {"type":"flowsheet","timeField":"recorded_at","banner":{"chipField":"substance"}}. No entries, no rules.
```

### [ ] 49a2. Generic `banner` chips
**Files:** views.js, enhancer.html | **Paste:** the patient banner renderer, patientView
```text
After validating the banner key, the banner shows one chip per active row's chipField from every applied set that has a banner block (skip entered_in_error; text escaped). Display only. Test with a made-up set.
```

### [ ] 49b1. `care.mar` seed (data only)
**File:** element-sets.js | **Paste:** one care set
```text
Add care.mar, group "admin": mar_time datetime, mar_item text, mar_order_id text, mar_result select (Given, Held, Refused), mar_reason text, dose_given text (free text), mar_by session user, mar_note text. View block: {"type":"flowsheet","timeField":"mar_time","crosscheck":{"against":{"setId":"care.allergies","field":"substance"},"textField":"mar_item","message":"Review allergy list before administering"}}. No dose values, no rules.
```

### [ ] 49b2. Generic `linkedgrid` section: pick from another set's active rows
**Files:** views.js, enhancer.html | **Paste:** the statusboard renderer, rows append in Store
```text
Section {"type":"linkedgrid","source":{"setId","field":"ord_item","filterField":"ord_category","filterValue":"Medication","statusField":"ord_status","statusValues":["Active"]},"into":{"setId","itemField","idField"}} lists active source rows and lets the user add a row in the target set with the item text copied and the source row id in the id field (decision 14). Doses are never calculated, converted, summed or auto-filled. Test with two made-up sets.
```

### [ ] 49b3. Generic `crosscheck` (non-blocking note)
**File:** enhancer.html | **Paste:** the form for adding a row
```text
When a typed text in textField contains (case-insensitive) a value from the against set's active rows, show the message from the data under the field. Never blocks saving. Test with a made-up set.
```

### [ ] 49b4. Seed `pathway.emr.mar` (data only)
**Files:** element-sets.js, emr-views.test.js | **Paste:** the handover example
```text
Add pathway.emr.mar: members care.orders, care.allergies, care.mar (not optional), surface case_tab {id "mar", label "MAR"}, sections [{"type":"linkedgrid",...as in 49b2...},{"type":"setTable","setId":"care.mar"}]. Add to the optional list in V7a (not on by default). Tests: validates; rules [].
```

## 50. ADT and schedule

### [ ] 50a1. `care.adt_schedule` seed (data only)
**File:** element-sets.js | **Paste:** one care set
```text
Add care.adt_schedule, group "adt": adt_time datetime, adt_event select (Admission, Ward Transfer, Discharge, Outpatient Visit, Follow-up Scheduled), adt_ward text, adt_bed text, adt_clinician text, adt_status select (Scheduled, Arrived, Completed, Cancelled). View block: {"type":"flowsheet","timeField":"adt_time"}. No rows, no rules.
```

### [ ] 50a2. "Apply to encounter" (decision 15)
**Files:** enhancer.html | **Paste:** Store.patients.updateEncounter signature, the bed_occupied message code
```text
In the ADT table, for a latest Admission or Ward Transfer row whose ward/bed differs from the open encounter, show a button "Apply to encounter" calling the existing encounter route (the server keeps one open encounter per bed; show bed_occupied in plain words). The banner and board keep reading the encounter record. Nothing changes silently. Server mode only.
```

### [ ] 50b1. Generic `upcoming` view and `patients_panel` surface
**Files:** views.js, enhancer.html | **Paste:** the Patients screen render function
```text
Add view type "upcoming": rows of one set whose time is in the future and whose event field is in a listed set of values, ordered by date. Add the patients_panel surface that shows it across the ward's patients. Test with a made-up set.
```

### [ ] 50b2. Seed `pathway.emr.schedule` and FHIR Encounter from ADT
**Files:** element-sets.js, enhancer.html | **Paste:** buildBundle Encounter part
```text
Add pathway.emr.schedule (surface patients_panel, member care.adt_schedule, upcoming view with events Follow-up Scheduled and Outpatient Visit). buildBundle Encounter status (planned, in-progress, finished) and location come from a "fhir" block on care.adt_schedule; a Discharge row changes the exported status without deleting data.
```

## 51. Charge capture

### [ ] 51a1. Migration: allow icd10 and cpt in verified_codes
**Paste:** the verified_codes check constraint
### [ ] 51a2. Codes tool and validation for icd10 and cpt; unverified codes stay out of every export; tests
### [ ] 51b1. Charge summary aggregate (server): verified Condition codes, completed orders, stay length from ADT, read from the bindings in `pathway.emr.charge_summary`
### [ ] 51b2. Seed `pathway.emr.charge_summary` (surface export_section, sections verifiedConditions, completedItems, stayLength) and its renderer from the section registry
### [ ] 51b3. JSON and CSV export, audited, formula-safe; billing never touches notes or alerts
```text
(one file per task) Data and generic code only; no billing code is pre-filled; unverified codes omitted. Return edits only.
```

## 52. Tests

### [ ] 52a. care.orders seed has no doses/thresholds/rules; actions need a reason where declared; row kept after Discontinue
### [ ] 52b. MAR never sums doses; mar_by from session; allergies seed empty; crosscheck never blocks
### [ ] 52c. ADT seed empty; Discharge changes exported Encounter status without deleting data; no silent encounter change
### [ ] 52d. Unverified ICD-10/CPT omitted; export audited; CSV formula-safe
```text
Tests only. Return only the new test blocks, not the whole file. Paste only the test helpers and the code under test.
```

*End of plan.*
