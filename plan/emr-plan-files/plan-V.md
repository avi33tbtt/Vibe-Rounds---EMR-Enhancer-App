# Phase V: EMR views become pathways

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 16. Phase V: EMR views become pathways (do first)

Goal: what 37c and 37d built by hand becomes seed data plus generic renderers, with **identical output**. Nothing new for the user to see except that Settings can switch view pathways on or off. Order matters: V0 to V8, one task per chat.

### V0. Housekeeping and inventory

#### [x] V0a. Put the five orphan tests into `npm test`
**File:** package.json | **Paste:** the `"test"` line only
```text
Add sum-by-type.test.js, board-no-reading.test.js, handover-data.test.js, handover-view.test.js and handover-print.test.js to the test script. Change nothing else. Tell me if any of them fail (do not fix them in this task).
```
**Done when:** `npm test` runs them; write the new total in section 10.

#### [ ] V0b. Hand-code inventory (no code)
**Run yourself, paste the output:**
```text
grep -n "care\.intake_output\|io_time\|io_type\|io_volume" enhancer.html store.js api.js
grep -n "handoverRender\|boardRow\|sumByType\|ioSum\|data-shell-t=\"ho\"\|id=\"ho\"" enhancer.html
```
```text
Do not change code. From this output list every place that names a clinical set, field or option in code. For each, say which Phase V task removes it (V4, V5, V6, V7) or that it must stay (seed data, tests). Reply as a table.
```
**Done when:** the table is pasted under V8a as the allow-list starting point.

### V1. Write the vocabulary down

#### [ ] V1a. VIEWS.md (doc only)
**File:** new `VIEWS.md` | **Paste:** section 9 of this plan
```text
Write VIEWS.md in the repo root from this text: layers, view block keys, surface types, section types, the three JSON examples, engine rules E1-E7. Add one "How to add a new type" checklist: step 0 access block (see R1), then pure function, made-up-set test, validator entry, doc line. No code.
```
**Done when:** VIEWS.md exists and matches section 9.

### V2. Validate view data (no screens)

#### [ ] V2a. `views.js`: validateView(set)
**File:** new root `views.js` (browser + Node, ends with `if(typeof module!=='undefined')module.exports=...`) | **Paste:** VIEWS.md key table, one seed set (care.intake_output)
```text
Create views.js with validateView(set) returning {errors, warnings}. Errors: unknown view key or type; a referenced field id missing from the set; summary timeField not a datetime, valueField not number/integer, keyField not text/select; windowsHours not positive integers (max 8 entries); any key named eval or function; any key named threshold, band, dose, limit, target or default. Plus views.test.js: one passing case from the I/O example and one failing case per error, using a made-up set, not a seed set.
```

#### [ ] V2b. Validate on seed and on save
**Files:** seed.js, api.js (element-sets create route) | **Paste:** the seed loop, the set create/update route
```text
Call validateView in seed.js (a seed with a bad view stops seeding with the set id in the message) and in the set create and update routes (422 with the error list). Test: a set with a bad view is refused; the real element-sets.js still seeds.
```

#### [ ] V2c. `validatePathwayViews(pathway)`
**File:** views.js | **Paste:** the two pathway examples in VIEWS.md
```text
Add validatePathwayViews(p) for pathways whose contexts include "emr": surface.type must be in the closed list; case_tab needs id, label; every section type must be in the closed list; hours/windows positive integers; rules must be []; members must exist as set ids (checked by the caller). Tests: one failing case per error, one passing for ward_board and handover examples. Call it from seed.js and the set routes beside validateView.
```

### V3. Generic client engine (no change in behaviour)

#### [ ] V3a. View registry and one dispatcher (part 1: registry only)
**File:** enhancer.html | **Paste:** the view-type dispatcher (about line 1052: fever, dailygrid, flowsheet branches)
```text
Add VIEWS={} and registerView(type, fn). Register the existing fever, dailygrid and flowsheet renderers unchanged (wrap them, do not edit them). Do not touch the if-chain yet.
```

#### [ ] V3a2. Switch the dispatcher to the registry
**File:** enhancer.html | **Paste:** the if-chain (about line 1052) and the registry from V3a
```text
Replace the if-chain with one function renderSetView(set, group, rows) that looks up VIEWS[set.view.type] and falls back to the old "could not be drawn" text. Output must be byte-identical.
```
**Done when:** `npm test` passes; open a fever chart, daily grid and flowsheet by hand and compare.

#### [ ] V3b. Pure helpers
**File:** views.js (browser + Node) | **Paste:** `rowT`, `fnum` and how `__status` is read
```text
Add pure helpers rowsInWindow(rows, timeField, fromMs, toMs) (skips entered_in_error and unreadable times) and fieldsById(set). Tests with a made-up set: window edges, entered_in_error, bad time.
```

### V4. I/O sum becomes data

#### [ ] V4a. `sumBy(rows, spec, fromMs, toMs)`
**Files:** views.js, sum-by-type.test.js | **Paste:** sumByType, sum-by-type.test.js
```text
Add sumBy(rows, spec, fromMs, toMs) with spec {timeField, keyField, valueField}: same behaviour as sumByType (plain numbers per key, entered_in_error skipped, '(no type)' key). Port the 5 cases in sum-by-type.test.js to call sumBy with the I/O field names passed in the test, and add one case with a different made-up set. Do not touch enhancer.html yet.
```

#### [ ] V4b. Put the summary in the I/O seed (data only)
**Files:** element-sets.js, io-set.test.js | **Paste:** the care.intake_output entry, view example from section 9
```text
Add the "summary" block from the I/O example to care.intake_output's view and bump its version to 2. Do not change fields. Update io-set.test.js: validateView passes; the set still has zero rules, thresholds, limits and defaults.
```

#### [ ] V4c. Render summaries from the view block
**File:** enhancer.html | **Paste:** ioSum, IOW state, where ioSum is called
```text
Replace ioSum with renderSummaries(set, rows): for each entry of set.view.summary of type sumBy, show the window choice from windowsHours and one line per key using sumBy. Label from the data ("sum of entered rows"). Keep the window choice state per set id. Delete sumByType and every mention of care.intake_output and io_ from enhancer.html. Same text and layout as before. Server mode only as before.
```
**Done when:** `grep -n "intake_output\|io_" enhancer.html` finds nothing; I/O flowsheet looks the same on a case that has the set re-applied (decision 13).

#### [ ] V4d. Proof test: a made-up set gets a sum with no code change
**File:** new `views-generic.test.js` | **Paste:** how an existing jsdom or vm test loads functions from enhancer.html
```text
Test: define a made-up set "test.fluids" with different field ids and a sumBy block; renderSummaries shows its sums; remove the block and nothing is shown. No code change outside the test.
```

### V5. Ward board becomes a pathway

#### [ ] V5a. Seed `pathway.emr.ward_board` (data only)
**Files:** element-sets.js, new `emr-views.test.js` | **Paste:** the ward_board example from section 9, one seed pathway
```text
Add pathway.emr.ward_board to the seed pathways exactly as in section 9 (members [], rules [], surface patients_columns, columnsFrom pinned). Test: it validates with validatePathwayViews and seeds read-only.
```

#### [ ] V5b. Board columns come from the active surface
**File:** enhancer.html | **Paste:** `boardRow`, the board part of `renderPatients`, `pinListFor`
```text
Add emrSurfaces(type) returning the active EMR view pathways whose surface.type matches (until V7, treat pathway.emr.ward_board as active when found). boardRow takes its column list from the surface: "pinned" uses pinListFor, otherwise the pathway's members. Output unchanged; update board tests.
```

#### [ ] V5c. Cell content from the set's `board` block
**File:** enhancer.html | **Paste:** boardRow, the 37c5 no-reading code
```text
A cell shows what set.view.board says; default {show:'latest'} gives latest value and age as now. Leave the "No reading for N min" logic (approved minutes_since_gt rule only) untouched. board-no-reading tests must still pass; with no rule no such text appears anywhere.
```

### V6. Handover becomes a pathway

#### [ ] V6a. Seed `pathway.emr.handover` (data only)
**File:** element-sets.js, emr-views.test.js | **Paste:** the handover example from section 9
```text
Add pathway.emr.handover as in section 9. Test: validates; rules []; seeds read-only.
```

#### [ ] V6b1. Section registry: narrative, activePathways, ackedAlerts
**File:** enhancer.html | **Paste:** handoverData
```text
Add SECTIONS={} and move three parts of handoverData into pure functions (case, spec, ctx): narrative, activePathways, ackedAlerts (hours from spec). handoverData still works, calling them. handover-data.test.js passes unchanged.
```

#### [ ] V6b2. Section registry: latestValues, newRows, sectionsData
**File:** enhancer.html | **Paste:** handoverData (current), the SECTIONS block from V6b1
```text
Move latestValues and newRows into SECTIONS the same way. Add sectionsData(c, sections, ctx). handoverData(c, sinceMs) becomes sectionsData with the seed pathway's sections and returns the same object. handover-data.test.js passes unchanged.
```

#### [ ] V6c. Render by section type
**File:** enhancer.html | **Paste:** handoverHtml and handoverRender
```text
Render each section by type from a SECTION_HTML registry in the order the pathway lists. No colours, flags or judgement text. Print CSS from 37d3 stays. Add a made-up pathway in a test with only two sections and check only those two show. handover-view.test.js passes.
```

### V7. Surfaces: tabs and columns come from active pathways

#### [ ] V7a1. Active view pathways: read (server)
**Files:** api.js | **Paste:** the app_settings read code for the AI switch (36a), the /me route
```text
Add key emr_views (list of pathway ids, default ["pathway.emr.ward_board","pathway.emr.handover"]) to app_settings reads. GET /emr-views (existing read action, all roles) and the same list in /me. Test: default list returned; /me carries it.
```

#### [ ] V7a2. Active view pathways: write (server)
**Files:** api.js, permissions.js | **Paste:** the AI switch PUT route (36a), the audit-coverage list
```text
PUT /emr-views: admin only, new action views.admin; checks each id is an existing pathway with contexts "emr"; carries the version (409); one audit row in the same transaction. Add the role-matrix and audit-coverage entries. Tests: nurse refused, bad id refused, audit row exists.
```

#### [ ] V7b. Client reads the list
**Files:** store.js, enhancer.html | **Paste:** how `/me` AI flag is read in Store
```text
Store.emrViews() returns the active ids (server mode from /me; Demo mode uses the default list). emrSurfaces(type) uses it instead of the temporary rule from V5b.
```

#### [ ] V7c1. Build extra tab buttons and panes from surfaces
**File:** enhancer.html | **Paste:** the tab button row (line ~187), the shell tab switch code
```text
After the fixed tabs, add buttons and empty panes from emrSurfaces('case_tab') (id, label from the data). Leave the old fixed Handover button and pane in place for now. Keep keyboard shortcuts for the fixed tabs.
```

#### [ ] V7c2. Dispatch and remove the fixed Handover markup
**File:** enhancer.html | **Paste:** the Handover pane (~459), the dispatcher line (~981), handoverRender
```text
The dispatcher draws a surface tab by calling the section renderer for its pathway. Delete the fixed Handover button, pane and the handoverRender() call by name. If the pathway is switched off the tab is absent.
```

#### [ ] V7d. Settings: choose view pathways
**File:** enhancer.html | **Paste:** the Settings AI switch block
```text
Admin-only list in Settings: every EMR view pathway with a checkbox and its description; Save calls the V7a route with the version; plain error text. Non-admins see the list read-only.
```

### V8. Keep it that way

#### [ ] V8a. No-hand-code guard test
**File:** new `no-handcode.test.js` | **Paste:** the V0b table
```text
Test: read element-sets.js, collect every seed set id and every seed field id (skip generic ids shorter than 4 characters). Scan enhancer.html, store.js and api.js for those strings as quoted words or property names (r.<id>). Fail on any hit not on ALLOW (an array of "file:line-pattern" strings). Start ALLOW from the V0b table (ana() lines only). The test prints the ALLOW size so it can only shrink.
```
**Done when:** the test passes and ALLOW holds only analytics lines.

#### [ ] V8b. Safety tests for view data
**File:** safety.test.js (new if missing) | **Paste:** nothing
```text
Add tests: every seed view block passes validateView; no view block or surface has a threshold, band, dose, limit, target or default key; every seed pathway with contexts "emr" has rules [] and passes validatePathwayViews; seed view pathways have tier seed and are read-only; removing the whole `summary` key leaves the set usable.
```

#### [ ] V8c. Docs
**Files:** VIEWS.md, API.md | **Paste:** the new routes from V7a
```text
Update API.md with the emr_views routes and VIEWS.md with the final key and section lists. Replace the Context block in the repo README with the one in this plan (section 12).
```
**Release gate for Phase V:** I/O sum, ward board and handover look the same as before; no clinical set or field name remains in code except on the V8a allow-list; switching the Handover pathway off removes its tab.
