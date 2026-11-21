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

#### [x] F5. Read routes for the element index and a case's element rows (server)
*F5 result (20 Nov 2026): both routes were already in `api.js` and `permissions.js` (`GET /elements/index` is `ref.read`, `GET /cases/:id/elements` is `case.read`). The role-matrix test loops over `ROUTE_ACTIONS` and the audit-coverage test checks non-GET routes only, so no list entry was needed. Tests added: `elements-routes.test.js` (5 cases). A case with real rows, and the null ids for a role without `patient.read`, are covered in the F7c tests.*

**Files:** api.js, permissions.js | **Paste:** one GET route, ROUTE_ACTIONS, the audit-coverage list
```text
Add GET /elements/index (provides list for all active sets and the registration core; existing ref.read action) and GET /cases/:id/elements (existing case.read; same follow-mergedInto and view-audit behaviour as the case read). Both read only. Add the role-matrix and audit-coverage entries. Tests: nurse reads, viewer reads, no write happens.
```

#### [x] F6. `core.registration` provides list (data only)
*F6 result (20 Nov 2026): `core-elements.js` provides sex and birth date only, no codes, `recording: false`; `api.js` already uses it in `/elements/index`. Check that `core-elements.test.js` exists (it should check each `column` against `patients.js` and that no other field appears); if it does not, write it before F7a.*

**File:** element-sets.js (or a new `core-elements.js`) | **Paste:** the F0 answer on demographics
```text
Add a read-only, non-editable list of what registration provides as elements: only fields that registration really captures (from F0), each with resource, role and a key. It is not a recording set: no one enters data into it. providesOf includes it so analytics can require it. Test: validates; contains no field that registration does not capture.
```

#### [x] F7a. `deidentify(elementRows, opts)` (pure)
*F7a result (20 Nov 2026): `export-bundle.js` has `deidentify(rows, {salt, encounterStarts, keepFreeText})`: salted HMAC-SHA-256 pseudonyms for patient, encounter, case and row ids (salt of 8 characters or more is required); dates become decimal `daysFromStart` (null when the row has no time or the encounter has no start); each output row is built from a fixed key list (`KEYS`), so no name, MRN, phone, national id, set id or field id can be copied; values of the roles `text`, `actor` and `link` are withheld unless `keepFreeText`. The caller passes the final (mergedInto) patient id. Tests in `export-bundle.test.js`.*

**File:** new root `export-bundle.js` (browser + Node) | **Paste:** the 38b3 text in 15.4 and decision 22, the element row shape (6.5)
```text
Create export-bundle.js with deidentify(elementRows, {salt, encounterStarts}): stable pseudonym per patient id (salted hash), dates replaced by days since the encounter start, patient ids and encounter ids never leaked, no name, MRN, phone or national id fields ever copied. Tests with made-up rows: same input gives same pseudonym, no original id string appears in the output, a row with null time stays null, a merged patient (caller passes the final id) appears once. No FHIR yet.
```

#### [x] F7b. `buildExportBundle(deidRows)` and `buildManifest(deidRows)` (pure)
*F7b result (20 Nov 2026): `buildExportBundle(rows)` returns a FHIR R4 transaction Bundle, one entry per row, `PUT <ResourceType>/<id>` so a re-export updates by id; only `Observation` gets a value field (`valueQuantity` with the unit as recorded, or `valueString`); `daysFromStart` goes in the extension `urn:emr-enhancer:days-from-encounter-start`; a `code` appears only if the row carries one. `buildManifest(rows)` returns `{elements:[{resource, role, unit, system, code, count}]}`, sorted, with no set or field ids. Tests in `export-bundle.build.test.js` (3 cases). No older `buildBundle` was found in the root `.js` files. Other resource types get no value field yet; F7c will show whether any seed set needs one.*

**File:** export-bundle.js | **Paste:** buildBundle (first 40 lines), F7a
```text
Add buildExportBundle(rows) returning a FHIR R4 bundle: one resource per element row, resource type from the row's resource, a stable id taken from the row id so a re-export updates by id, codes only if the row carries one. Add buildManifest(rows) returning element keys present with counts and no set or field ids. Tests with made-up rows: stable ids on repeat, unverified code absent, manifest lists no set or field id.
```

#### [x] F7c. `GET /analytics/export` route (server)
*F7c result (21 Nov 2026): route in api.js, action analytics.export (admin and informatician; doctors get 403, so F9b must say the same). Salt from EXPORT_SALT (8 or more characters, else 500 export_not_configured). Filter is the encounter's ward and start time; over 2000 cases is 422. Each element is also held to its set's access.export list (default deny). Only the first coding of a field is exported. One audit row is written before the response. Tests in analytics-export.test.js.*

**Files:** api.js, audit.js, permissions.js | **Paste:** one GET route, ROUTE_ACTIONS, the audit-coverage list, projectCase (F4)
```text
Add GET /analytics/export?ward=&from=&to= (doctor, admin; new action analytics.export; the only analytics route in the EMR). It loads cases for the filter, calls projectCase, deidentify and buildExportBundle/buildManifest, and returns both. One audit row with the filter used. Add the role-matrix and audit-coverage entries. Tests: nurse refused; audit row written; no identifier string appears in the response.
```
*Notes from F5: pass `localSystems` to `projectCase` as `GET /cases/:id/elements` does (`SELECT id FROM code_systems WHERE kind='local'`). The audit-coverage test checks non-GET routes only, so a GET export route needs no entry there, but it does need an audit row and a test that proves it. The role-matrix test covers the new `ROUTE_ACTIONS` entry on its own. `permissions.js` already lists `analytics.export` for admin and informatician (R3); the task text above says doctor and admin, so settle which in the F7c chat before editing.*

*Notes from F7a and F7b: F7c must (1) read the salt from configuration, never from the request, and fail if it is missing or shorter than 8 characters; (2) build `encounterStarts` from the encounters of the cases it loads and pass it to `deidentify`; (3) pass the final (mergedInto) patient id, not the original; (4) pass `deidentify` output, not raw element rows, to `buildExportBundle` and `buildManifest`. Check that the element row from `projectCase` has the field names `deidentify` reads (`patientId`, `encounterId`, `caseId`, `rowId`, `resource`, `role`, `unit`, `system`, `code`, `valueNumber`, `valueText`, `time`, `status`): if `projectCase` uses different names (for example `value` instead of `valueNumber`), map them in the route or adjust `deidentify` first, and say which in the chat.*

**Done when:** the bundle imports into the Analytics app as a batch and its Data quality analytic runs on it (manual job, section 14).

#### [x] F8. Guard test: no analytics in the EMR, and elements.js names no sets (rule E9)
*F8 result (21 Nov 2026): three tests in no-handcode.test.js. The word slot is skipped for the elements.js check only (ELEMENT_VOCAB). Allowed names: analytics.export and /analytics/export.*

**File:** extend `no-handcode.test.js` (V8a) | **Paste:** that test
```text
Add two checks: (1) elements.js must not contain a seed set id or seed field id as a word or property name (tests excepted); (2) no EMR file may contain an analytics engine: fail if api.js, store.js, enhancer.html or permissions.js define actions or routes named analytics.run, analytics.patients or /analytics/run, or the strings maskCounts or element_rows. Only analytics.export and /analytics/export are allowed.
```

#### [x] F9a. Retire `ana()`
*F9a result (21 Nov 2026): removed ana() and everything only it used (anScopes, inScope, diseaseCards, careCards, pathwayCards, directCards, med, qt, gapOf, ANS, ANU, SNK, DEMO, one, synth, clearSyn), the synthetic-case buttons and the two other ana() calls. The Analytics tab and an empty pane remain. ALLOW was already empty. The About text on analytics is now untrue: rewrite it in F9b.*

**File:** enhancer.html | **Paste:** ana() and the card renderers it uses
```text
Remove ana() and every card renderer only it uses. Leave the Analytics tab button and pane in place, empty. Delete the ana() lines from the V8a allow-list so it becomes empty. Test: no r.temp style property access remains in enhancer.html.
```

#### [x] F9b. "Export for analytics" screen
*F9b result (21 Nov 2026): the Analytics tab is now "Export for analytics" (`anTool`, `anRender` and one click handler in enhancer.html). Shown only when `Store.can('analytics.export')`; Demo mode shows a plain note and no export (decision 31). Asks `GET /analytics/export?ward=&from=&to=` through `Store.api` and saves two files, bundle and manifest, using `dlf`. Messages for 403, 422 and `export_not_configured`. The About text on analytics (lines about 260, 267, 277, 314, 386 and 424) was rewritten. Checked against api.js: the route answers `{bundle, manifest, counts}`, and the screen shows `counts`. Not covered by a test yet: add a small vm test that the screen shows only with the action. The tab still needs an open case (the shell tab rule), which is a known limit.*

**File:** enhancer.html | **Paste:** the empty Analytics pane, Store request helper
```text
The Analytics tab becomes an "Export for analytics" screen (admin and informatician): choose ward and dates, press Export, download the bundle and manifest from F7c, with plain text saying analytics are run in the Analytics app (decision 31 for Demo mode).
```
