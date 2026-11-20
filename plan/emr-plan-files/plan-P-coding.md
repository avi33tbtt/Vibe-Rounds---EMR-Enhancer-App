# Phase P: free choice of coding, and profile labels

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

**Order of work (see `plan-core.md`):** P0 to P2b, P3a to P3d, P4a to P4d, P5a at step 5; **P2c** at step 11 (it needs F4); **P5b** at step 16 (it needs AA1 in the Analytics repo); P6 to P9 at step 20 (settle decision 43 first); P10 to P13 at step 21.

## 28. Phase P: free choice of coding, and profile labels

*Why: forms made in the app must not be tied to SNOMED CT and LOINC. An author can choose any mix of standard systems, local codes or no code, and can label a form as built for a profile (a national or local FHIR profile, or a hospital-group one) without the app knowing any particular profile. Labels are claims that have been checked, not guarantees of compliance. Decisions 38 to 41 apply.*

*Prerequisites: P0 to P5 need F2 and F3. P6 to P9 need Phase M. P10 to P13 need F7 and Phase 6. Each task is one file and one concern.*

### 28.1 What the user sees
- On each field: tick boxes for SNOMED CT, LOINC, ICD-10, ICD-11, My own local codes, No code. Any mix; "No code" is the default.
- Standard codes are typed by a person and verified in the official browser, as now. Local codes are typed into the facility's own list.
- A form with no codes works fully: it records, shows summary cards, exports as text values, and its coverage says "needs a code" only for analytics that ask for one.
- In the marketplace: a profile label on each item and a filter "built for profile ...". An item can carry several profile labels.

### 28.2 Tasks

#### [x] P0. CODING.md (doc only)
**File:** new `CODING.md` | **Paste:** 28.1 and decisions 38 to 41
```text
Write CODING.md: the coding choices, that no code is always allowed, that the software never fills a code in, local systems, the profile idea and the wording rule (never "compliant"). No code.
```

#### [x] P1a. Migration: `code_systems`
**File:** new migration | **Paste:** the verified_codes table and its check constraint (001_core.sql, 51a1)
```text
Add table code_systems (id, uri, name, kind 'standard' or 'local', licence_note, created_by, created_at). Replace the closed check on verified_codes.system with a foreign key to code_systems. Existing rows keep working. Migration test: fresh and upgrade both pass.
```
*P1a result (20 Nov 2026): `verified_codes.system` had no check constraint (plain text), so nothing was replaced; `009_code_systems.sql` adds `code_systems`, seeds `snomed` and `loinc` (ids match the existing `sysEnum`), keeps any other existing system as a local one, adds the foreign key and grants `emr_app`. Test: `code-systems.test.js`. `/api/codes` still accepts only snomed and loinc until `sysEnum` is widened.*

#### [x] P1b. Seed the code systems (data only)
**Files:** seed.js, new `code-systems.js` | **Paste:** seed.js loop
```text
Seed code_systems with SNOMED CT, LOINC, ICD-10, ICD-11 and UCUM (id, URI, name, kind standard, licence note). No codes. Test: seeded twice adds nothing; verified_codes still empty.
```
*Note: 009 already created `snomed` and `loinc` with no licence note. Seed with `ON CONFLICT (id) DO UPDATE` to fill the note, and add icd10, icd11 and ucum. Use short ids in the same style.*

#### [x] P2a. `validateCoding(field)` (pure)
**File:** views.js | **Paste:** one seed field, decision 38
```text
Add field.coding = {allow:[system ids, 'local' or 'none']} and validateCoding(field, knownSystems) returning {errors}: unknown system id; empty allow list; any key named default or auto. A field with no coding block means {allow:['none']}. Tests with a made-up field.
```
*P2a result (20 Nov 2026): `validateCoding(field, knownSystems)` and `codingAllow(field)` are in `views.js` (exported). `none` and `local` are always allowed; any other id must be in `knownSystems` (ids from `code_systems`). Also refused: unknown keys inside `coding`. Tests: `validate-coding.test.js` (no database). Not yet called anywhere: P2b and P3 use it.*

#### [x] P2b. Several codings per field in `code_bindings`
**Files:** new migration, api.js | **Paste:** code_bindings routes and table
```text
Allow more than one binding per (set, field) when systems differ; the unique key becomes (set_id, field_id, system). A binding is refused if the field's coding.allow does not list that system. Tests: two systems on one field accepted; a disallowed system refused with a plain sentence.
```
*P2b result (20 Nov 2026): `010_code_bindings_multi.sql` changes the key to (set_id, field_id, system). `PUT /bindings` refuses (422, `coding_not_allowed`) a system the field's `coding.allow` does not list. A field with NO coding block, or a set not on the server, behaves as before (accepted), so existing seed fields and tests keep working; making a missing block mean "none only" is a later decision, once P3 lets authors tick systems. `DELETE /bindings/:setId/:fieldId?system=x` removes one binding; without `system` it removes all of the field's bindings. No new route, so permissions.js and the audit-coverage test are unchanged. Tests: `bindings-multi.test.js`.*

#### [x] P2c. `projectCase` emits a list of codings
**File:** elements.js | **Paste:** projectCase and its tests (F4)
```text
Element rows carry codings:[{system, code}] (empty list when none) in place of single system and code. Only codes from bindings. Update the element row shape in ELEMENTS.md. Tests with a made-up set: two systems on one field, none, and a disallowed system absent.
```
*P2c result (20 Nov 2026): `projectCase` in `elements.js` now sets `codings:[{system,code}]` on every element row and no longer sets `system` and `code`. It reads the bindings itself, so `providesOf` and `compatibility()` are unchanged (they still use the first binding for the key). Duplicates are dropped; a field with `coding.allow` drops a binding whose system is not listed (`none` allows nothing; `local` allows only the system ids passed in the new optional argument `localSystems`, because `elements.js` cannot know which systems are local); a field with no coding block keeps all its bindings. `ELEMENTS.md` row shape and rule 4 updated. Tests in `elements.project.test.js`: the old single-code test replaced, two new tests. **The F7c route must pass `localSystems`** (ids of kind local from `code_systems`) or local codes will not be exported. Anything that read a row's `system` or `code` must read `codings` (none yet: F7 is not built).*

#### [x] P3a. Read route: `GET /code-systems` (server)
**Files:** api.js, permissions.js | **Paste:** `r.get('/codes')` in api.js, ROUTE_ACTIONS, the audit-coverage list
```text
Add GET /code-systems returning [{id, uri, name, kind, licenceNote}] from code_systems (existing ref.read action, all roles; read only). Add the role-matrix and audit-coverage entries. Tests: every role reads; seeded systems listed; no write happens.
```
*P3a result (20 Nov 2026): `GET /code-systems` added to api.js and to ROUTE_ACTIONS as `ref.read`. A GET needs no audit-coverage entry (audit.test.js checks only non-GET routes). Standard systems come first, local ones after. Tests: `code-systems-route.test.js`.*

#### [x] P3b. Server checks `coding` when a set is saved
**File:** api.js | **Paste:** the set create/update route where validateView is called (V2b)
```text
In the set create and update routes call validateCoding(field, ids from code_systems) for every field; 422 with the error list. Seeds call it too in seed.js. Tests: a set with an unknown system in coding.allow refused; a legacy {system,code,display} coding and no coding both pass.
```
*P3b result (20 Nov 2026): `validateSetCoding(set, knownSystems)` added to `views.js`. `POST /element-sets` refuses with 422 `bad_coding` and an error list; `seed.js` refuses a seed set the same way and now seeds the code systems before the sets. Known systems come from the `code_systems` table, so a local system added later is accepted. Tests: `set-coding.test.js` (database) and one more case in `validate-coding.test.js`.*

#### [x] P3c. Store: `Store.codeSystems()`
**File:** store.js | **Paste:** where Store loads codes at boot (~line 584), `Store.codes`
```text
Load GET /code-systems at boot into S.codeSystems and add Store.codeSystems() returning a copy. Demo mode returns the five standard systems from a constant list (ids, names only). Test with the existing store.test.js pattern.
```
*P3c result (20 Nov 2026): `store.js` has `S.codeSystems`, a constant `DEMO_CODE_SYSTEMS` (snomed, loinc, icd10, icd11, ucum; each `{id, name, kind: 'standard'}`; `kind` added so Demo mode has the same shape as the server rows) and `Store.codeSystems()` (returns a copy). Server mode loads `GET /code-systems` after `/me`, in its own call: if it fails, boot still completes and the constant list is used. Demo mode makes no call. Sign-out empties it. Tests in `store.test.js`: the existing "init loads" call list now includes `/code-systems`; four new P3c tests (Demo list and copy, server list with a local system, fallback on failure, sign-out clears). Note: the 34d tests read `enhancer.html` from the repo; run them from the repo root.*

#### [x] P3d. Coding choices in the Codes tab (user sets only)
**File:** enhancer.html | **Paste:** `codesUI()` and the `id="fh"` pane
```text
In each Codes row add tick boxes for each Store.codeSystems() id, "My own local codes" and "No code" (default). Saving writes field.coding = {allow:[...]} through Store.saveSet as a new set version. Seed sets show their choices read-only. Plain note: "codes are typed by a person and verified; the app never fills them in".
```
*P3d result (20 Nov 2026): the Codes table in `enhancer.html` has a new column "Coding choices". A user set shows tick boxes (every standard system from `Store.codeSystems()`, "My own local codes", "No code") and a Save button per field; Save writes `field.coding = {allow:[...]}` and a new set version through `Store.saveSet`. "No code" and a system exclude each other; nothing ticked means No code, and the coding block is removed. Seed sets, and an older version of a user set, show their choices as read-only text. Refused with a plain message: a field with a draft code (`coding.code`) and a field whose attached code's system would be unticked (detach it first). `applyBinds()` and `unbind()` now keep `allow` when they attach or detach a code. Systems of kind local are not listed as separate boxes; "My own local codes" covers them. The note under the table says codes are typed by a person and verified and the app never fills them in. Checked: syntax of all inline scripts, and the new functions against stubs (cell output, save, refusals, tick rules). Not checked: clicking in a browser, so do the manual check below.*

*P3 was split (20 Nov 2026) after reading enhancer.html and store.js. Findings: (1) there is no manual field editor; "Set builder" is only the AI schema draft, and the only per-field screen is the Codes tab. (2) The client already uses `field.coding` in memory for one attached code, `{system, code, display}` (`applyBinds()`); P2a and P2b ignore that shape, so the new choice block is `coding.allow`. (3) Seed sets are read-only on the server (403), so choices on a seed field are changed by bumping the set's version in `element-sets.js`, not from the screen. (4) The screen needs a `code_systems` read route and a save-time check, which are P3a and P3b. If you want a real manual field editor, add it as its own task after P3d.*

#### [x] P4a. Local code lists (server)
**Files:** migration, api.js, permissions.js | **Paste:** the verified_codes routes, permissions.js
```text
Table local_codes (system_id, code, display, created_by, created_at) for systems of kind local; routes to create a local system and add codes (informatician, admin; audited). Local codes enter verified_codes only after the same verification step as standard ones. Tests: role matrix, audit rows, a local code is never offered as a standard one.
```
*P4a result (20 Nov 2026): `011_local_codes.sql` adds `local_codes` (system_id, code, display, created_by, created_at). It holds codes of kind local only: `code_systems` gets a unique (id, kind) and a composite foreign key enforces it in the database. In api.js: `POST /code-systems` (create a local system; id is a lowercase slug, `local`, `none` and `any` are reserved because `coding.allow` uses them; uri defaults to `urn:local-code-system:<id>`), `GET /code-systems/:id/codes` (with verified state), `POST /code-systems/:id/codes` (added unverified) and `POST /code-systems/:id/codes/:code/verify` (the code then joins `verified_codes`, once; a second verify is 409). In permissions.js a new action `codesystem.write` (admin, informatician) covers creating and adding; verifying uses `code.write` (admin, doctor, informatician), listing uses `ref.read`. Audit actions: `codesystem.add`, `localcode.add`, `localcode.verify`. `POST /codes`, the live check and `PUT /bindings` still accept snomed and loinc only, so a local code is never treated as a standard one. Tests: `local-codes.test.js` (nothing pre-filled, role matrix, input checks, verify flow, never offered as standard, audit rows, a new local system is accepted in `coding.allow`) and three entries in the audit-coverage list of `audit.test.js`. Not run by me (no database in my sandbox): run `npm test`; the last test in `local-codes.test.js` guesses a minimal set body shape, so if only that one fails, adjust the body.*

#### [x] P4b. Local code lists (screen)
**File:** enhancer.html | **Paste:** the Codes tool screen
```text
In the Codes tool add "Local code systems": create a system, add codes, see their verified state. No pre-filled content.
```
*P4b result (20 Nov 2026): the Codes tab in `enhancer.html` has a "Local code systems" block under the SNOMED / LOINC form. It lists only systems of kind local (from `GET /code-systems`), a Codes button per system shows its codes with the state "typed, not verified" or "verified" and the date, and an add-code row. A create-system form shows for roles with `codesystem.write`; a Verify button shows only for roles with `code.write` and asks for a confirmation ("checked against your own list") first. In Demo mode the block says local code systems need the server and makes no call. The screen calls the P4a routes through `Store.api` directly, not through the store cache, and nothing is pre-filled. Known limit: after Verify, `Store.codes()` does not know the new verified code until the page is reloaded; P4d must refresh it when it attaches a local code. Checked: syntax of all inline scripts, and the new functions against stubs (Demo and server modes, role-based controls, create, add, verify, refusals). Not checked: clicking in a browser.*

#### [x] P4c. Bind a verified local code to a field (server)
**File:** api.js | **Paste:** `bindPut`, `PUT /bindings`, `codingAllowOf` (found while doing P4a: no route can bind a local code yet)
```text
Let PUT /bindings take system = the id of a local code system, but only for a (system, code) already in verified_codes; otherwise 422 with a plain sentence. The snomed and loinc format check stays for those two only. The field's coding.allow must list 'local' or that system id. Tests: verified local code binds; unverified refused; a field allowing only snomed refuses it; DELETE with ?system= works for a local id.
```
*P4c result (20 Nov 2026): `PUT /bindings` takes a local system id (`bindPut.system` is a slug, code up to 50 characters). A local system must exist in `code_systems` with kind local, else 400; the (system, code) must be in `verified_codes`, else 422 `code_not_verified`; the verified display is stored, not the client's. `coding.allow` must list `local` or that system id (422 `coding_not_allowed`). snomed and loinc keep their format check; other standard systems (icd10 and so on) still get 400 until a later task. `DELETE ?system=` accepts snomed, loinc or a known local system, else 400. The P4a test "never offered as standard" now uses icd10. Tests: three new cases at the end of `local-codes.test.js`. Not run by me (no database in my sandbox): run `npm test`. If a local bind fails with a database error 23514, `code_bindings.system` still has a check on snomed and loinc and needs a small migration. Next: P4d.*

#### [x] P4d. Attach a verified local code in the Codes tab (screen)
**File:** enhancer.html | **Paste:** `addCode()`, `applyBinds()`, `SYSU`, P4c
```text
The Codes tab can attach a verified local code to a field, and applyBinds() keeps a local binding (it now ignores any system outside SYSU). Show it as a local code, never as SNOMED CT or LOINC. No pre-filled content.
```
*P4d result (20 Nov 2026): in `enhancer.html` the "add code" form's system list now also shows each local code system from `Store.codeSystems()` (as "<name> (local)"). Choosing one and pressing Add runs `attachLocal()`: a field must be chosen, the code must already be in the verified list (`Store.codes()`), and the field's `coding.allow` (when it has one) must list `local` or that system id; the verified display is the one kept, nothing typed creates a code. `applyBinds()` now keeps a local binding (`SYSU[x.system] || lsys(x.system)`). A local code shows as "<system name> (local code)", never as SNOMED CT or LOINC (`sysLabel()`), and goes into the FHIR bundle with the system's URI (`sysUri()`); `liveCheck()` skips local codes (no external check). `codingSave()` accepts a field that has a local code attached when `local` stays ticked. In `store.js`: new `Store.refreshCodes()` (server mode: re-reads `/codes` and `/code-systems`, adds and updates only; Demo mode does nothing), called after a local system is created and after Verify, which closes the P4b limit. `Store.saveBinds()` now sends `DELETE /bindings/:set/:field?system=<old>` before the PUT when a field's binding changes system, so the server does not keep both. Checked: syntax of all inline scripts and `store.js`; the new store functions and screen functions against stubs (attach refusals, attach, allow rules, label, URI, refresh, delete-then-put, unchanged binding sends nothing). Not checked: clicking in a browser, and no tests were added to `store.test.js` (not given to me): run `npm test`, and the manual check below. Known limit: the app keeps one binding per field, so if the server holds two bindings for one field (P2b), the screen shows the last one and Detach removes all of them.*

#### [x] P5a. Slot `codeSystem` in `compatibility()`
**File:** elements.js | **Paste:** compatibility() from F3b
```text
A slot may carry codeSystem (default 'any'). 'any' matches with or without codes. A named system is met only if the element has a coding in that system; otherwise 'partly' with the basis "needs a code in <system>". Tests with made-up sets: any, named met, named missing, none.
```
*Note (20 Nov 2026): `elements.js` already matches a slot `codeSystem` (met, or partly with a code-system basis) and already carries several codings in the key. In this chat check it and add only the missing tests; do not rewrite.*
*P5a result (20 Nov 2026): checked `compatibility()` in `elements.js`; no code change. A slot with no `codeSystem`, an empty one or 'any' matches with or without codes. A named system is met by a field that carries a coding in it (any one of several codings; local system ids work the same way); otherwise the slot is 'partly', and each field's reason reads "code system differs (slot needs X, field has none / has a, b)" and the basis "role matches; ...". This wording differs from the task text ("needs a code in <s>"); it was kept so existing tests and screens that show it do not change. Unit and code system are judged separately and both reasons are listed; a manual binding still wins. Tests: new `elements-codesystem.test.js` (7 tests, no database, made-up set), run against the real `elements.js`: all 7 pass. Check that `npm test` picks the file up (if `package.json` lists test files by name, add it). Step 5 is complete.*

#### [ ] P5b. Analytics app: SNOMED CT and LOINC only for now (Analytics repo)
**File:** defs.js | **Paste:** validateAnalytic (AA1), the slot rules
```text
Allow slot.codeSystem only as 'any', the SNOMED CT URI or the LOINC URI; refuse any other value with a plain sentence ("this app analyses SNOMED CT and LOINC codes for now"). Other codings in an import are kept as recorded but counted as uncoded by analytics. Selftest: valid, invalid, ICD coding treated as uncoded. Widening this list is a later task (decision 42).
```

#### [ ] P6. `validateProfile(profile)` (pure)
**File:** views.js | **Paste:** the slot example in 7.1, decision 40
```text
Add validateProfile(p) for kind 'profile' packages: id, version, title, requires (slots exactly as in 7.1, with optional codeSystem), optional notes. Errors: slot names a set id or field id; key named eval, function, threshold, limit, band, dose, target; no requires. No national profile is built in. Tests with a made-up profile.
```

#### [ ] P7. Profile labels on packages and the index
**Files:** package-lint.js, registry `scripts/build-index.js` | **Paste:** lintPackage, build-index.js
```text
A package may declare profiles:[{id, version}]. Lint checks the shape; the index entry carries it. Test: a malformed profiles list fails lint; the index lists the profiles.
```

#### [ ] P8. Marketplace filter by profile (EMR)
**File:** enhancer.html | **Paste:** the marketplace list (46b1)
```text
Add a filter "built for profile" (list from the index) and a profile chip on each item. Wording: "built for", never "compliant". An item with several labels shows them all.
```

#### [ ] P9. Profile as a requires list: coverage report
**File:** elements.js | **Paste:** compatibility(), P6
```text
Add profileCoverage(profile, provides) using compatibility(): per required element met, partly or unmet with the basis, plus a list of fixed parts (registration, encounter) the profile asks for that a pathway cannot supply. Tests with a made-up profile and set.
```

#### [ ] P10. Show profile coverage on a pathway
**File:** enhancer.html | **Paste:** the pathway card renderer, P9
```text
On the Pathway tab and in the marketplace preview show profile coverage for each label: met, partly met, unmet. Plain words, no judgement of care.
```

#### [ ] P11. Export readiness list
**File:** export-bundle.js | **Paste:** buildExportBundle (F7b), P9
```text
Add readinessFor(profile, rows) listing what the profile would not accept from this export (a required element empty, a required system missing). Reported only; the exporter never adds or changes a code. Tests with a made-up profile and rows.
```

#### [ ] P12. Checked-against label: validator run in CI
**Files:** registry `ci.yml`, one script | **Paste:** ci.yml, a synthetic export fixture
```text
CI exports a synthetic fixture, runs an external FHIR validator against the profile package named by the item, and records "checked against <id> <version> on <date> with <validator version>" in the index. A failing check removes the label, nothing else. The label text never says compliant or certified.
```

#### [ ] P13. Safety tests
**Paste:** nothing
```text
Tests: a field with no coding block records, projects and exports; no seed holds a code; no code is ever added by the software; a disallowed system is refused; a profile package holds no clinical list or threshold; no screen or index text contains the words compliant or certified.
```

**Gate P:** a form is made with no codes, one with a local system and one with SNOMED CT plus ICD; all three record, export and show coverage; a profile label is added to one and its checked-on date shows.
