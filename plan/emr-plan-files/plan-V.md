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

#### [x] V0b. Hand-code inventory (no code)
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

#### [x] V1a. VIEWS.md (doc only)
**File:** new `VIEWS.md` | **Paste:** section 9 of this plan
```text
Write VIEWS.md in the repo root from this text: layers, view block keys, surface types, section types, the three JSON examples, engine rules E1-E7. Add one "How to add a new type" checklist: step 0 access block (see R1), then pure function, made-up-set test, validator entry, doc line. No code.
```
**Done when:** VIEWS.md exists and matches section 9.

### V2. Validate view data (no screens)

#### [x] V2a. `views.js`: validateView(set)
**File:** new root `views.js` (browser + Node, ends with `if(typeof module!=='undefined')module.exports=...`) | **Paste:** VIEWS.md key table, one seed set (care.intake_output)
```text
Create views.js with validateView(set) returning {errors, warnings}. Errors: unknown view key or type; a referenced field id missing from the set; summary timeField not a datetime, valueField not number/integer, keyField not text/select; windowsHours not positive integers (max 8 entries); any key named eval or function; any key named threshold, band, dose, limit, target or default. Plus views.test.js: one passing case from the I/O example and one failing case per error, using a made-up set, not a seed set.
```

#### [x] V2b. Validate on seed and on save
**Files:** seed.js, api.js (element-sets create route) | **Paste:** the seed loop, the set create/update route
```text
Call validateView in seed.js (a seed with a bad view stops seeding with the set id in the message) and in the set create and update routes (422 with the error list). Test: a set with a bad view is refused; the real element-sets.js still seeds.
```

#### [x] V2c. `validatePathwayViews(pathway)`
**File:** views.js | **Paste:** the two pathway examples in VIEWS.md
```text
Add validatePathwayViews(p) for pathways whose contexts include "emr": surface.type must be in the closed list; case_tab needs id, label; every section type must be in the closed list; hours/windows positive integers; rules must be []; members must exist as set ids (checked by the caller). Tests: one failing case per error, one passing for ward_board and handover examples. Call it from seed.js and the set routes beside validateView.
```

### V3. Generic client engine (no change in behaviour)

#### [x] V3a. View registry and one dispatcher (part 1: registry only)
**File:** enhancer.html | **Paste:** the view-type dispatcher (about line 1052: fever, dailygrid, flowsheet branches)
```text
Add VIEWS={} and registerView(type, fn). Register the existing fever, dailygrid and flowsheet renderers unchanged (wrap them, do not edit them). Do not touch the if-chain yet.
```

#### [x] V3a2. Switch the dispatcher to the registry
**File:** enhancer.html | **Paste:** the if-chain (about line 1052) and the registry from V3a
```text
Replace the if-chain with one function renderSetView(set, group, rows) that looks up VIEWS[set.view.type] and falls back to the old "could not be drawn" text. Output must be byte-identical.
```
**Done when:** `npm test` passes; open a fever chart, daily grid and flowsheet by hand and compare.

#### [x] V3b. Pure helpers
**File:** views.js (browser + Node) | **Paste:** `rowT`, `fnum` and how `__status` is read
```text
Add pure helpers rowsInWindow(rows, timeField, fromMs, toMs) (skips entered_in_error and unreadable times) and fieldsById(set). Tests with a made-up set: window edges, entered_in_error, bad time.
```

### V4. I/O sum becomes data

#### [x] V4a. `sumBy(rows, spec, fromMs, toMs)`
**Files:** views.js, sum-by-type.test.js | **Paste:** sumByType, sum-by-type.test.js
```text
Add sumBy(rows, spec, fromMs, toMs) with spec {timeField, keyField, valueField}: same behaviour as sumByType (plain numbers per key, entered_in_error skipped, '(no type)' key). Port the 5 cases in sum-by-type.test.js to call sumBy with the I/O field names passed in the test, and add one case with a different made-up set. Do not touch enhancer.html yet.
```

#### [x] V4b. Put the summary in the I/O seed (data only)
**Files:** element-sets.js, io-set.test.js | **Paste:** the care.intake_output entry, view example from section 9
```text
Add the "summary" block from the I/O example to care.intake_output's view and bump its version to 2. Do not change fields. Update io-set.test.js: validateView passes; the set still has zero rules, thresholds, limits and defaults.
```

#### [x] V4c. Render summaries from the view block
**File:** enhancer.html | **Paste:** ioSum, IOW state, where ioSum is called
```text
Replace ioSum with renderSummaries(set, rows): for each entry of set.view.summary of type sumBy, show the window choice from windowsHours and one line per key using sumBy. Label from the data ("sum of entered rows"). Keep the window choice state per set id. Delete sumByType and every mention of care.intake_output and io_ from enhancer.html. Same text and layout as before. Server mode only as before.
```
**Done when:** `grep -n "intake_output\|io_" enhancer.html` finds nothing; I/O flowsheet looks the same on a case that has the set re-applied (decision 13).

#### [x] V4d. Proof test: a made-up set gets a sum with no code change
**File:** new `views-generic.test.js` | **Paste:** how an existing jsdom or vm test loads functions from enhancer.html
```text
Test: define a made-up set "test.fluids" with different field ids and a sumBy block; renderSummaries shows its sums; remove the block and nothing is shown. No code change outside the test.
```

### V5. Ward board becomes a pathway

#### [x] V5a. Seed `pathway.emr.ward_board` (data only)
**Files:** element-sets.js, new `emr-views.test.js` | **Paste:** the ward_board example from section 9, one seed pathway
```text
Add pathway.emr.ward_board to the seed pathways exactly as in section 9 (members [], rules [], surface patients_columns, columnsFrom pinned). Test: it validates with validatePathwayViews and seeds read-only.
```
*V5a result (20 Nov 2026): the seed entry is in `element-sets.js` (version 1, contexts ['emr'], members [], rules [], surface patients_columns / columnsFrom pinned; title and description added because the other seed pathways carry them). `emr-views.test.js` has two parts. No database: present once; section 9 shape; validates with `validatePathwayViews` (given the seed ids); no banned key and no other set or field named; every EMR pathway has no rules. Database (own database, like `local-codes.test.js`): `seedSets` stores it with source 'seed', read_only true, kind pathway, version 1; a second seeding changes nothing; `GET /element-sets` lists it as a read-only seed; POST, PATCH and DELETE are refused with 403 `read_only` and the row is unchanged. Note: seed rows get tier 'local-reviewed' (the code in `seed.js`), not 'seed' as some plan text says; the tests check source and read_only. Not run by me (no database, and the repo's `views.js` was not available): run `npm test`. Watch: a test that counts seed sets, or lists every seed pathway as care, may now fail. V5b must hide pathways with contexts 'emr' from Add to chart and the AI suggestion list (see V5b).*

#### [x] V5b. Board columns come from the active surface
**File:** enhancer.html | **Paste:** `boardRow`, the board part of `renderPatients`, `pinListFor`
```text
Add emrSurfaces(type) returning the active EMR view pathways whose surface.type matches (until V7, treat pathway.emr.ward_board as active when found). boardRow takes its column list from the surface: "pinned" uses pinListFor, otherwise the pathway's members. Output unchanged; update board tests.
```
*Added at V5a (20 Nov 2026): the seed pathway has contexts ['emr'] and kind 'pathway', so the Add-to-chart list (`inCtx`, All contexts) and the AI suggestion list (`availP`, about lines 979 and 1191) would show it as a pathway to start on a case. In this task also hide every pathway whose contexts include 'emr' from those two lists (one helper `isEmrView(s)`), so nothing new appears for the user.*

*V5b result (20 Nov 2026): in `enhancer.html`, next to `isPw`: `isEmrView(s)` (contexts include 'emr'), `EMR_ACTIVE_TEMP` (['pathway.emr.ward_board'], replaced at V7b), `emrSurfaces(type)` and `boardColumnIds(c)` ('pinned' or no surface found uses `pinListFor`, otherwise the pathway's members). `boardRow` and the board part of `renderPatients` use `boardColumnIds`. `availP` (AI suggestion list) and the Add-to-chart list (`r` in the picker) skip EMR view pathways. Output unchanged. Not run by me: run `npm test`. If `board-no-reading.test.js` or `handover-data.test.js` load functions from enhancer.html by name, add `isEmrView`, `emrSurfaces`, `boardColumnIds`, `EMR_ACTIVE_TEMP` to their list. Still to add by you: a test that `boardColumnIds` equals `pinListFor` with the seed present, and that `isEmrView` is true for contexts ['emr'] only.*

#### [x] V5c. Cell content from the set's `board` block
**File:** enhancer.html | **Paste:** boardRow, the 37c5 no-reading code
```text
A cell shows what set.view.board says; default {show:'latest'} gives latest value and age as now. Leave the "No reading for N min" logic (approved minutes_since_gt rule only) untouched. board-no-reading tests must still pass; with no rule no such text appears anywhere.
```
*V5c result (20 Nov 2026): in `enhancer.html`, `boardCfg(s)` reads `set.view.board`: `show` 'latest' (default) or 'age' (age only, no value), and optional `fields` (list of field ids; only those values are shown). `boardRow` uses it; no board block gives exactly the old cell. The board cell renderer now also shows the age line when only the age is present. `boardNoReading` and its text are untouched. No seed set carries a board block yet, so nothing changes on screen. Not run by me: run `npm test`. Add to `board-no-reading.test.js`: no block gives the old cell; `{show:'age'}` gives latest '' and the age; `{fields:[...]}` keeps only those values; a made-up set proves it with no code change. Left for V8b: a validator entry for `view.board` (show in the closed list, fields are field ids of the set) and a line in VIEWS.md at V8c.*

### V6. Handover becomes a pathway

#### [x] V6a. Seed `pathway.emr.handover` (data only)
**File:** element-sets.js, emr-views.test.js | **Paste:** the handover example from section 9
```text
Add pathway.emr.handover as in section 9. Test: validates; rules []; seeds read-only.
```
*V6a result (20 Nov 2026): `pathway.emr.handover` is in `element-sets.js` after the ward board (version 1, contexts ['emr'], members [], rules [], surface case_tab id 'ho' label 'Handover' print true; sections in order: narrative, activePathways, latestValues scope 'applied', ackedAlerts hours 24, newRows since 'lastHandover'; title and description added like the ward board). Copied from the `handover()` example in `views.test.js` so it matches what already validates. `emr-views.test.js` has V6a checks: no database (once in the list, shape, validates, no banned key, names no other set or field) and database (seeds read-only with source 'seed'; POST, PATCH and DELETE refused 403 `read_only`, row unchanged). Not run by me (no database): run `npm test`. The section params (scope, since, hours) are not read by any code yet; V6b1 and V6b2 make `hours` drive the narrative and acked-alerts parts, and decide how `scope` and `since` are read. Watch: a test that counts seed sets or seed pathways may now fail.*

#### [x] V6b1. Section registry: narrative, activePathways, ackedAlerts
**File:** enhancer.html | **Paste:** handoverData
```text
Add SECTIONS={} and move three parts of handoverData into pure functions (case, spec, ctx): narrative, activePathways, ackedAlerts (hours from spec). handoverData still works, calling them. handover-data.test.js passes unchanged.
```
*V6b1 result (20 Nov 2026): in `enhancer.html`, `const SECTIONS` just before `handoverData` holds `narrative(c)`, `activePathways(c)` and `ackedAlerts(c,spec,ctx)` (window = `spec.hours`, now = `ctx.now`; 24 when the spec has no hours, so the old 24 h result is kept). `handoverData` calls them and returns the same object (key `acks24h` kept). It passes `{hours:24}` as a literal for now; V6b2 replaces that with the seed pathway's `ackedAlerts` section. Not run by me: run `npm test`. If `handover-data.test.js` loads functions from enhancer.html by name, add `SECTIONS` to its list (the test itself should not change).*

#### [x] V6b2. Section registry: latestValues, newRows, sectionsData
**File:** enhancer.html | **Paste:** handoverData (current), the SECTIONS block from V6b1
```text
Move latestValues and newRows into SECTIONS the same way. Add sectionsData(c, sections, ctx). handoverData(c, sinceMs) becomes sectionsData with the seed pathway's sections and returns the same object. handover-data.test.js passes unchanged.
```
*V6b2 result (20 Nov 2026): in `enhancer.html`, `SECTIONS` now also has `latestValues(c)` (applied sets, newest timed row each) and `newRows(c,spec,ctx)` (rows stamped after `ctx.since`; the cut-off is used only when `spec.since==='lastHandover'`, otherwise every stamped row). `sectionsData(c,sections,ctx)` runs the listed sections in order and returns `{sectionType: result}`; unknown types are skipped. `handoverData(c,sinceMs,nowMs)` takes its sections from `emrSurfaces('case_tab')[0]` (the seed `pathway.emr.handover`, added to `EMR_ACTIVE_TEMP` until V7b) and maps the result to the old shape {narrative, pathways, latest, acks24h, newRows}. `HANDOVER_FALLBACK` (same five sections) is used only when that pathway is not in the registry; V7 removes it. `scope` is read by nothing yet (only applied sets exist). Not run by me: run `npm test`; `handover-data.test.js`, `handover-view.test.js` and `handover-print.test.js` should pass unchanged. If they load functions by name, add `sectionsData`, `HANDOVER_FALLBACK`, `emrSurfaces`, `isEmrView`, `EMR_ACTIVE_TEMP` and `SECTIONS` to their lists.*

#### [x] V6c. Render by section type
**File:** enhancer.html | **Paste:** handoverHtml and handoverRender
```text
Render each section by type from a SECTION_HTML registry in the order the pathway lists. No colours, flags or judgement text. Print CSS from 37d3 stays. Add a made-up pathway in a test with only two sections and check only those two show. handover-view.test.js passes.
```
*V6c result (20 Nov 2026): in `enhancer.html`, `SECTION_HTML` has one drawer per type (narrative, activePathways, latestValues, newRows, ackedAlerts), each `(d, spec, x)` -> html with the same markup and texts as before. `handoverHtml(d,hrs,ruleText,secs)` keeps the 8/12/24 h buttons, then draws the sections in the order of `secs` (default `handoverSections()`, the case_tab pathway's list or the fallback); unknown types are skipped. The acknowledged-alerts title now takes its hours from the section (24 in the seed). Checked against the old `handoverHtml` with sample data: identical when the sections are given in the old order. **One visible change:** the seed lists ackedAlerts before newRows (as in section 9), so the Handover tab now shows "Alerts acknowledged" above "Entered in the last N h". To keep the screen exactly as before, swap those two entries in the seed (and in the V6a test's order check); say so and I will do it. Not run by me: run `npm test`. Still to add to `handover-view.test.js`: a made-up pathway with only two sections shows only those two (`handoverHtml(d,12,rt,[{type:'latestValues'},{type:'narrative'}])` gives those two headings in that order and no others); add `SECTION_HTML` and `handoverSections` to its function list if it loads by name.*

### V7. Surfaces: tabs and columns come from active pathways

#### [x] V7a1. Active view pathways: read (server)
**Files:** api.js | **Paste:** the app_settings read code for the AI switch (36a), the /me route
```text
Add key emr_views (list of pathway ids, default ["pathway.emr.ward_board","pathway.emr.handover"]) to app_settings reads. GET /emr-views (existing read action, all roles) and the same list in /me. Test: default list returned; /me carries it.
```
*V7a1 result (20 Nov 2026): in `api.js`, `emrViewsActive()` reads `app_settings` key `emr_views` (stored as `{ids:[...]}`; missing, or not a list of text ids, gives the default `["pathway.emr.ward_board","pathway.emr.handover"]`). `GET /emr-views` returns `{ids}`; `GET /me` carries `emrViews` (same list). `permissions.js`: `'GET /emr-views': 'ref.read'` (all roles, no new action). `emr-views.test.js` has three V7a1 tests (default list, `/me`, stored list wins and a bad value falls back); they insert into `app_settings (key,value)` as the owner. Not run by me (no database): run `npm test`. If the settings insert fails because the table has other required columns, paste `\d app_settings` and I will fix the test. If an audit-coverage test lists every route, add `GET /emr-views` as a read with no audit row (like `GET /prefs`). V7a2 adds the write route and the version check; the stored value shape `{ids}` is the one it will write. The AI switch routes live in `llm.js`, which I did not see, so the setting is read the same way `/me` reads the AI switch.*

#### [x] V7a2. Active view pathways: write (server)
**Files:** api.js, permissions.js | **Paste:** the AI switch PUT route (36a), the audit-coverage list
```text
PUT /emr-views: admin only, new action views.admin; checks each id is an existing pathway with contexts "emr"; carries the version (409); one audit row in the same transaction. Add the role-matrix and audit-coverage entries. Tests: nurse refused, bad id refused, audit row exists.
```
*V7a2 result (20 Nov 2026): `permissions.js`: new action `views.admin` (admin only, with a label) and `'PUT /emr-views': 'views.admin'`. `api.js`: `PUT /emr-views` takes `{ids, expectedVersion}` (ids: up to 20, no repeats; expectedVersion is a text version or null for the first save). In one transaction it checks that each id is a pathway in `element_sets_latest` whose contexts include 'emr' (else 400 `validation`, naming the bad ids), locks the settings row, compares the version (else 409 `conflict` with `current`), writes `{ids}` to `app_settings` key `emr_views` and writes one audit row `emr_views.set` (before and after hold the id lists; before is the default list on the first save). The version is `updated_at` to the microsecond as text, because `app_settings` has no version column (no migration added). `GET /emr-views` now returns `{ids, version}` (version null until first saved); `/me` still carries `emrViews` ids only. An empty list is allowed (every view pathway off). Tests: `emr-views.test.js` (nurse refused 403 and still reads; bad ids, repeats and a missing version refused 400 with nothing stored or audited; admin save, stale version 409, version moves, audit rows and before/after; the V7a1 default test now expects `version: null`) and `audit.test.js` (new coverage entry `PUT /emr-views` -> `emr_views.set`, sent with an empty list so no seed set is needed). Not run by me (no database): run `npm test`. **Not done:** the role matrix test in `permissions.test.js`, which I have not seen. If it lists every action or checks every route against a table, it will fail on `views.admin`; paste `Select-String -Path permissions.test.js -Pattern "ai.admin"` and I will add the entry.*

#### [x] V7b. Client reads the list
**Files:** store.js, enhancer.html | **Paste:** how `/me` AI flag is read in Store
```text
Store.emrViews() returns the active ids (server mode from /me; Demo mode uses the default list). emrSurfaces(type) uses it instead of the temporary rule from V5b.
```
*V7b result (20 Nov 2026): `store.js`: `Store.emrViews()` returns a copy of the ids in `Store.me.emrViews` (server mode, text entries only); no list, an older server, a bad value, no `/me` yet or Demo mode gives the default `["pathway.emr.ward_board","pathway.emr.handover"]`; an empty list means all off. `enhancer.html`: `emrSurfaces(type)` keeps only pathways whose id is in `Store.emrViews()`; `EMR_ACTIVE_TEMP` is gone. With no `Store` defined (a test that loads only these functions) every EMR view pathway in the registry counts as active, as before. New `store-emr-views.test.js` (no database or browser; 5 tests, all pass here). **Add `store-emr-views.test.js` to the `npm test` script.** Not run by me: the full `npm test`. If a test loads `emrSurfaces` and also defines a `Store` without `emrViews`, it gets the same no-restriction behaviour. Note: with the ward board switched off, `boardColumnIds` falls back to `pinListFor`, so the board looks the same; with Handover switched off, the tab is removed by V7c1/V7c2, not here. The list is read when the app loads; V7d must refresh `Store.me.emrViews` after an admin saves.*

#### [x] V7c1. Build extra tab buttons and panes from surfaces
**File:** enhancer.html | **Paste:** the tab button row (line ~187), the shell tab switch code
```text
After the fixed tabs, add buttons and empty panes from emrSurfaces('case_tab') (id, label from the data). Leave the old fixed Handover button and pane in place for now. Keep keyboard shortcuts for the fixed tabs.
```
*V7c1 result (20 Nov 2026): in `enhancer.html`, `surfaceTabsBuild()` (after the fixed-tab click wiring) removes any earlier generated buttons and panes, then for each `emrSurfaces('case_tab')` entry adds a button (`data-shell-t` and `data-surface-tab` = surface id, text = surface label) after the Export button and an empty `.pane` (`data-surface-pane`) after the `ex` pane. It skips an id that is not lowercase letters, digits, `_` or `-` (max 24) and any id already on the page, so the fixed Handover (`ho`) is skipped and nothing new shows yet. It runs at load and again when the chart opens (so it sees `/me` once loaded). Alt+1 to Alt+6 unchanged. Not run by me: run `npm test`; if a test loads functions by name, nothing new is needed unless it calls `surfaceTabsBuild`. V7c2 removes the fixed `ho` button, pane and `handoverRender()` call, after which the tab comes from data and must be drawn by the dispatcher (the new panes are empty until then). Note for V7c2: `showShellTab` still calls `handoverRender()` for id `ho`; the generated pane has the same id, so `hob` and the click handler on `$('ho')` must be created by the renderer.*


#### [x] V7c2. Dispatch and remove the fixed Handover markup
**File:** enhancer.html | **Paste:** the Handover pane (~459), the dispatcher line (~981), handoverRender
```text
The dispatcher draws a surface tab by calling the section renderer for its pathway. Delete the fixed Handover button, pane and the handoverRender() call by name. If the pathway is switched off the tab is absent.
```
*V7c2 result (20 Nov 2026): in `enhancer.html` the fixed Handover button and the `#ho` pane are deleted. `surfaceTabsBuild()` now draws the pane (heading from the surface label, the 'Display only' line, an empty `data-surface-body`), sets `data-surface-print` when the surface has `print true`, and does nothing when the list of surfaces has not changed (so a drawn pane is not wiped when the chart opens); the load-time call is wrapped in try/catch because the registry may not be ready then. New `surfaceRender(id)` finds the active `case_tab` pathway with that surface id and calls `handoverRender(el, secs)` with that pathway's `sections` (handoverRender no longer reads `#hob` and takes the element and section list). `showShellTab` calls `surfaceRender` for any generated pane, and the save refresh redraws the open surface pane; no code calls `handoverRender()` by name any more. The 8/12/24 h buttons use one delegated click handler on `.pane[data-surface-pane]`. With Handover switched off there is no button or pane. Not run by me: run `npm test` and check in the browser (Handover tab present, same content, hour buttons work, print view as before). **Watch:** (1) tests that read the `ho` button or `#hob` from the markup will fail (they should use `surfaceTabsBuild`/`surfaceRender` or be updated); tests that load functions by name need `surfaceRender`, `surfaceTabsBuild` and `handoverRender(el,secs)`. (2) `handoverData` still reads `emrSurfaces('case_tab')[0]` and the print CSS (`body:has(#ho.on)` lines about 152 to 163) still names the id `ho`; V8a must allow or fix that CSS (it can switch to `.pane[data-surface-print]`). (3) `HANDOVER_FALLBACK` stays until V8.*


#### [x] V7d. Settings: choose view pathways
**File:** enhancer.html | **Paste:** the Settings AI switch block
```text
Admin-only list in Settings: every EMR view pathway with a checkbox and its description; Save calls the V7a route with the version; plain error text. Non-admins see the list read-only.
```
*V7d result (20 Nov 2026): in `enhancer.html` Settings has a new block `#evBox` (title, note, checkbox list `#evList`, Save `#evSave`) after the AI switch. `evPaint()` (run when Settings opens) lists every EMR view pathway from the registry (`isPw` and `isEmrView`) with its title and description; in server mode it reads `GET /emr-views` for the active ids and the version. Admins (`mayDo('views.admin')`) can tick and press Save; everyone else sees the same list disabled with no Save button; Demo mode shows the default list read-only. Save sends `PUT /emr-views {ids, expectedVersion}`, then sets `Store.me.emrViews` (so `Store.emrViews()` is current), rebuilds the tabs (`surfaceTabsBuild`), returns to Summary if the open tab vanished, redraws the patient board and re-reads the list. Errors are plain text: 409 'Someone else changed this list...', 403 'Only an administrator...', otherwise 'Could not save: ' plus the server message. Not run by me: run `npm test`, then in the browser as admin: untick Handover and save (tab goes, ward board unchanged), tick it again (tab returns); as a nurse the list is read-only. Not done: a test for this block (it needs a browser); `store-emr-views.test.js` is unchanged. If the Settings text lists the same ids twice or shows no titles, the seed pathways may use a different title field than `title`.*


### V8. Keep it that way

#### [x] V8a. No-hand-code guard test
**File:** new `no-handcode.test.js` | **Paste:** the V0b table
```text
Test: read element-sets.js, collect every seed set id and every seed field id (skip generic ids shorter than 4 characters). Scan enhancer.html, store.js and api.js for those strings as quoted words or property names (r.<id>). Fail on any hit not on ALLOW (an array of "file:line-pattern" strings). Start ALLOW from the V0b table (ana() lines only). The test prints the ALLOW size so it can only shrink.
```
**Done when:** the test passes and ALLOW holds only analytics lines.

*V8a result (20 Nov 2026): `no-handcode.test.js` (3 tests, no database) reads `element-sets.js` (set and field ids of 4 or more characters), skips view pathways (contexts 'emr', which are configuration names, so `store.js` and `api.js` may name them) and the field id `plan` (the FHIR CarePlan word), blanks inlined `element-sets.js` and `cds-rules.js` script blocks and comment lines, and scans `enhancer.html`, `store.js` and `api.js` for each id as a quoted word or `.id` property. First real run found 44 hits on 19 lines (all in `enhancer.html` plus the `EMR_VIEWS_DEFAULT` lines now exempt). They are on ALLOW as **debt** entries, each grouped under the task that removes it (V8d1 to V8d8); `ALLOW_MAX = 19`, the test fails if ALLOW grows or an entry matches nothing. **Changed from the first plan text:** 'Done when ALLOW holds only analytics lines' now applies to the Phase V gate, not to this task, because removing the hits is eight separate jobs. **Add `no-handcode.test.js` to the `npm test` script.** Checked here against the seed block inlined in `enhancer.html`: same hits as your run, and it passes with the entries.*

**Allow-list starting point (from V0b, 20 Nov 2026; line numbers are in enhancer.html and will move).** The scan showed nothing in store.js or api.js. Lines are cut at 200 characters, so a hit that sits later in a long line is marked "late in line".

| Line | What it names | Removed by |
|---|---|---|
| 1524 `sumByType` | the I/O time field (`io_time`) and, past the cut, the type and volume fields | V4c deletes it; V4a adds `sumBy` with field names from data |
| 1526 `ioSum` | `'care.intake_output'`, the hours 8, 12, 24, the `IOW` state | V4c replaces it with `renderSummaries` |
| 1069 view dispatcher | calls `ioSum` (late in line); `fever` and `tempField` come from the set's view data | V3a2 (registry); the `ioSum` call goes in V4c |
| 1870 `boardRow` | board cell builder; names no set, but gets its column list from pins | V5b, V5c |
| 1912 board in `renderPatients` | `pinListFor` and `.direct` sets (late in line: `boardRow`) | V5b |
| 204 tab button row | fixed Handover button (late in line) | V7c1, V7c2 |
| 476 Handover pane | `id="ho"`, `id="hob"` | V7c2 |
| 998 shell dispatcher | `if(id==='ho')handoverRender()` | V7c2 |
| 1196 refresh | calls `handoverRender` (late in line) | V7c2 |
| 1900 `handoverRender` | whole function | V6c, V7c2 |
| 1903 click handler | `$('ho')`, `HOW.h`, hours 8, 12, 24 | V6c, V7c2 |

No `ana()` lines appeared in this scan, so the V8a ALLOW list may start empty. Seed data (element-sets.js) and tests are outside the scan and stay.

#### [x] V8b. Safety tests for view data
**File:** safety.test.js (new if missing) | **Paste:** nothing
```text
Add tests: every seed view block passes validateView; no view block or surface has a threshold, band, dose, limit, target or default key; every seed pathway with contexts "emr" has rules [] and passes validatePathwayViews; seed view pathways have tier seed and are read-only; removing the whole `summary` key leaves the set usable.
```
*V8b result (20 Nov 2026): new `views-safety.test.js` (5 tests; the plan said `safety.test.js`, a new name is used so nothing existing is overwritten). No database (4 tests, run here against your real `element-sets.js` and `views.js`, all pass): every seed set with a `view` passes `validateView`; no seed `view`, and no EMR pathway `surface` or `sections`, has a key named threshold, band, dose, limit, target, default, auto, eval or function (exact key names, so the existing `thresholdField` and `doseField` view keys are fine); every pathway with contexts 'emr' is kind pathway with `rules []`, `members []` and passes `validatePathwayViews`; removing `view.summary` from every seed set that has one still validates, leaves the rest of the view and the fields unchanged, and `sumBy` with no spec gives `{}`. Database (1 test, own database created and dropped inside the test; **not run by me**): every seeded EMR view pathway is stored with source 'seed', read_only true, kind pathway and `rules []`. **Differs from the plan text:** it does not check tier 'seed', because `seedSets` stores tier 'local-reviewed' for every seed row (noted at V5a); say if you want the code or the plan changed. **Add `views-safety.test.js` to the `npm test` script**, then run `npm test`.*


#### [x] V8c. Docs
**Files:** VIEWS.md, API.md | **Paste:** the new routes from V7a
```text
Update API.md with the emr_views routes and VIEWS.md with the final key and section lists. Replace the Context block in the repo README with the one in this plan (section 12).
```
*V8c result (20 Nov 2026): checked, nearly all already done. API.md already has the `emr_views.set` audit row, both routes in the routes table and the section "EMR view pathways" (GET and PUT, 409 and 400 cases, `emrViews` in `/me`). README.md already holds Context block A identical to `plan-core.md`. VIEWS.md already has the final keys, SURFACE_TYPES, SECTION_TYPES and params. One fix: the `board` row said "validated in V8c2" (no such task); it now says V8b. Docs only, no test change. V8d1 to V8d8 are still open (V8a ALLOW debt) and must be done before the Phase V gate in step 8.*
### V8d. Remove the hand-coded ids (debt on the V8a ALLOW list)

Each task: move the named behaviour into data (a view key, a field flag or a seed pathway) with a generic renderer, a validator entry, a test with a made-up set and a line in VIEWS.md; then delete its ALLOW entries and lower `ALLOW_MAX` in `no-handcode.test.js`. Output must look identical. Paste: `grep -n` for the ALLOW text, then the function.

#### [ ] V8d1. Starter and quick-add set lists from data
**File:** enhancer.html (+ element-sets.js) | **Paste:** the `DEF`, `quickIds` and `template.basic_emr` lines (910 to 971 area, ~1733, ~2332)
```text
The Demo-mode default set list, the quick-add list and the starter template come from a flag on seed sets or a seed pathway, not from ids in code. Same lists, same order.
```

#### [ ] V8d2. Demo sample cases from data
**File:** enhancer.html | **Paste:** the `DEMO`/`DEMO2` line (~910) and where they are used
```text
The two sample cases pick their sets from data (or move to Phase D personas). No set id in code.
```

#### [ ] V8d3. FHIR export: pairing and method text from data
**File:** enhancer.html | **Paste:** the export lines with `bp2`, `bpOk` and `f.id=='route'` (~1389 to 1400)
```text
A field flag or view key says which two fields are one paired reading and which field becomes the Observation method text. Export output unchanged.
```

#### [ ] V8d4. Paired reading in text lines from data
**File:** enhancer.html | **Paste:** the lines with `bp_sys` near 1604 and `rowText` near 1957
```text
Use the same data from V8d3 to join the paired reading in text lines. No field id in code.
```

#### [ ] V8d5. Typed target echo and scale echo from data
**File:** enhancer.html | **Paste:** the lines with `tgt_low` (~1132) and `ssi` (~1135)
```text
The typed target fields and the typed-band echo are named in the set's view block. Still shown as typed, never judged.
```

#### [ ] V8d6. Fever chart extra field from data
**File:** enhancer.html | **Paste:** the line with `includes('pulse')` (~1142)
```text
View `extra` already lists field ids. Draw the overlay for the first listed extra field, with no id in code.
```

#### [ ] V8d7. HbA1c trend and due label from data
**File:** enhancer.html | **Paste:** the lines with `care.hba1c_monitoring` (~1475, 1476, 1614, 1944)
```text
The set, series field and due field come from a view or field flag. Same trend chart, same due badge and label.
```

#### [ ] V8d8. Snake-bite gap from data
**File:** enhancer.html | **Paste:** `gapOf` (~1436) and its callers
```text
The three fields used by gapOf come from the set's view block. Same result.
```

**Release gate for Phase V:** I/O sum, ward board and handover look the same as before; no clinical set or field name remains in code (the V8a ALLOW list is empty); switching the Handover pathway off removes its tab.
