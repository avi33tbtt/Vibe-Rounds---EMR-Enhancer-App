# Phase F: FHIR element spine

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 18. Phase F: the FHIR element spine (EMR)

*Sections 6 and 2. F0 to F3 come right after V4 (Gate 1). They are pure functions with tests and no screen. F4 to F9 follow Phase V. This phase is the whole of the EMR's analytics work. Every task is one file and one concern.*

#### [x] F0. Element inventory (no code)
**Run yourself, paste the output:**
```text
grep -c '"fhir"' element-sets.js
grep -n '"type":"\(datetime\|select\|text\)"' element-sets.js | head -60
grep -n "code_bindings\|verified_codes" api.js | head -20
grep -n "gender\|birth\|race\|ethnic" patients.js 005_patients.sql | head -20
```
```text
Do not change code. From this output make three lists: (1) every seed field with its type, unit, whether it has a fhir block, and the role it would get from the table in section 6.4; (2) fields that have no fhir block but should have one to be an element (time and select fields count as elements only when their row feeds an exported value); (3) which patient demographics registration really captures. Reply as tables.
```
**Done when:** the tables are pasted under F2 as the starting data for tests.

*F0 result (20 Nov 2026): inventory kept in `F0-inventory.md` (65 seed fields, 24 with a fhir block; roles per 6.4; five gaps in 6.4 listed there). Give that file in the F1 and F2 chats.*

#### [x] F1. ELEMENTS.md (doc only)
**File:** new `ELEMENTS.md` | **Paste:** sections 6.2 to 6.5 of this plan
```text
Write ELEMENTS.md in the repo root from this text: the glossary, the closed role list, the element key format, the projection rules and the element row shape. End with a "How to add a role" checklist: informatician proposal, admin approval, validator entry, made-up-set test, one line here. No code.
```

#### [x] F2. `elements.js`: roles, element keys, provides (pure)
**File:** new root `elements.js` (browser + Node, ends with `if(typeof module!=='undefined')module.exports=...`) | **Paste:** ELEMENTS.md role table, one seed set (care.intake_output), one `code_bindings` row shape
```text
Create elements.js with roleOf(field), elementKey(set, field, binding) and providesOf(set, bindings) returning [{fieldId, group, role, resource, unit, system, code, key}]. Role comes only from field.type and the optional fhir block (table 6.4); a field with no fhir block still gets a role but resource null. A code appears only from the bindings passed in. Never convert units. Plus elements.test.js using a made-up set (different field ids and units than any seed set): one case per role, one with a binding, one with no fhir block.
```

#### [x] F3a. `compatibility()`: slot matching (pure)
**File:** elements.js | **Paste:** ELEMENTS.md, the slot example in section 7.1
```text
Add compatibility(requires, provides) returning {slots:[{slot, status:'met'|'unmet', matched:[{fieldId, basis}]}]}. A slot is met when resource, role and unit string all match (unit "any" matches every unit; no conversion). Every match carries a basis such as "matched on: quantity, mL". Tests with made-up sets: met, unmet, unit "any". Nothing else.
```

#### [x] F3b. `compatibility()`: partly, manual binding, unused fields (pure)
**File:** elements.js | **Paste:** compatibility() from F3a
```text
Extend compatibility(requires, provides, manualBindings): status 'partly' when role matches but unit or code differs (say which); a manual binding {slot, fieldId} is honoured with basis "bound by hand"; add unusedFields (provided fields no slot matched). Tests with made-up sets: partly (unit differs), manual binding, unused field, and one test proving the function never mentions a set id or field id from element-sets.js.
```
**Done when (Gate 2):** run it by hand over every seed set against the slot example in 7.1 and read the report; it must say what you expect, with a basis on every line.

#### [x] F4. `projectCase(...)`: element rows (pure)
*F4 result (20 Nov 2026): `projectCase` added to `elements.js`; tests in `elements.project.test.js` (6 cases). A field is projected only if it has a role and a fhir block; digits-only strings become numbers, anything else stays text.*

**File:** elements.js | **Paste:** the `case_rows` columns (section 6.3), providesOf from F2
```text
Add projectCase({rows, sets, bindings, patientId, encounterId, caseId}) returning element rows in the shape of 6.5. Rules: skip entered_in_error; keep rows with null row_time but time null; one element row per bound field with a value; value as typed; no unit conversion; code only from bindings. Tests with a made-up set: skipped error row, null time, unbound field absent, a bound code appears, a value typed with a comma is kept as text and not guessed.
```

#### [ ] F5. Read routes for the element index and a case's element rows (server)
**Files:** api.js, permissions.js | **Paste:** one GET route, ROUTE_ACTIONS, the audit-coverage list
```text
Add GET /elements/index (provides list for all active sets and the registration core; existing ref.read action) and GET /cases/:id/elements (existing case.read; same follow-mergedInto and view-audit behaviour as the case read). Both read only. Add the role-matrix and audit-coverage entries. Tests: nurse reads, viewer reads, no write happens.
```

#### [ ] F6. `core.registration` provides list (data only)
**File:** element-sets.js (or a new `core-elements.js`) | **Paste:** the F0 answer on demographics
```text
Add a read-only, non-editable list of what registration provides as elements: only fields that registration really captures (from F0), each with resource, role and a key. It is not a recording set: no one enters data into it. providesOf includes it so analytics can require it. Test: validates; contains no field that registration does not capture.
```

#### [ ] F7a. `deidentify(elementRows, opts)` (pure)
**File:** new root `export-bundle.js` (browser + Node) | **Paste:** the 38b3 text in 15.4 and decision 22, the element row shape (6.5)
```text
Create export-bundle.js with deidentify(elementRows, {salt, encounterStarts}): stable pseudonym per patient id (salted hash), dates replaced by days since the encounter start, patient ids and encounter ids never leaked, no name, MRN, phone or national id fields ever copied. Tests with made-up rows: same input gives same pseudonym, no original id string appears in the output, a row with null time stays null, a merged patient (caller passes the final id) appears once. No FHIR yet.
```

#### [ ] F7b. `buildExportBundle(deidRows)` and `buildManifest(deidRows)` (pure)
**File:** export-bundle.js | **Paste:** buildBundle (first 40 lines), F7a
```text
Add buildExportBundle(rows) returning a FHIR R4 bundle: one resource per element row, resource type from the row's resource, a stable id taken from the row id so a re-export updates by id, codes only if the row carries one. Add buildManifest(rows) returning element keys present with counts and no set or field ids. Tests with made-up rows: stable ids on repeat, unverified code absent, manifest lists no set or field id.
```

#### [ ] F7c. `GET /analytics/export` route (server)
**Files:** api.js, audit.js, permissions.js | **Paste:** one GET route, ROUTE_ACTIONS, the audit-coverage list, projectCase (F4)
```text
Add GET /analytics/export?ward=&from=&to= (doctor, admin; new action analytics.export; the only analytics route in the EMR). It loads cases for the filter, calls projectCase, deidentify and buildExportBundle/buildManifest, and returns both. One audit row with the filter used. Add the role-matrix and audit-coverage entries. Tests: nurse refused; audit row written; no identifier string appears in the response.
```
**Done when:** the bundle imports into the Analytics app as a batch and its Data quality analytic runs on it (manual job, section 14).

#### [ ] F8. Guard test: no analytics in the EMR, and elements.js names no sets (rule E9)
**File:** extend `no-handcode.test.js` (V8a) | **Paste:** that test
```text
Add two checks: (1) elements.js must not contain a seed set id or seed field id as a word or property name (tests excepted); (2) no EMR file may contain an analytics engine: fail if api.js, store.js, enhancer.html or permissions.js define actions or routes named analytics.run, analytics.patients or /analytics/run, or the strings maskCounts or element_rows. Only analytics.export and /analytics/export are allowed.
```

#### [ ] F9a. Retire `ana()`
**File:** enhancer.html | **Paste:** ana() and the card renderers it uses
```text
Remove ana() and every card renderer only it uses. Leave the Analytics tab button and pane in place, empty. Delete the ana() lines from the V8a allow-list so it becomes empty. Test: no r.temp style property access remains in enhancer.html.
```

#### [ ] F9b. "Export for analytics" screen
**File:** enhancer.html | **Paste:** the empty Analytics pane, Store request helper
```text
The Analytics tab becomes an "Export for analytics" screen (doctor and admin): choose ward and dates, press Export, download the bundle and manifest from F7c, with plain text saying analytics are run in the Analytics app (decision 31 for Demo mode).
```
