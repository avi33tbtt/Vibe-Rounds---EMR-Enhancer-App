# Phase P: free choice of coding, and profile labels

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

**Order of work (see `plan-core.md`):** P0 to P2b, P3, P4a, P4b, P5a at step 5; **P2c** at step 11 (it needs F4); **P5b** at step 16 (it needs AA1 in the Analytics repo); P6 to P9 at step 20 (settle decision 43 first); P10 to P13 at step 21.

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

#### [ ] P1b. Seed the code systems (data only)
**Files:** seed.js, new `code-systems.js` | **Paste:** seed.js loop
```text
Seed code_systems with SNOMED CT, LOINC, ICD-10, ICD-11 and UCUM (id, URI, name, kind standard, licence note). No codes. Test: seeded twice adds nothing; verified_codes still empty.
```
*Note: 009 already created `snomed` and `loinc` with no licence note. Seed with `ON CONFLICT (id) DO UPDATE` to fill the note, and add icd10, icd11 and ucum. Use short ids in the same style.*

#### [ ] P2a. `validateCoding(field)` (pure)
**File:** views.js | **Paste:** one seed field, decision 38
```text
Add field.coding = {allow:[system ids, 'local' or 'none']} and validateCoding(field, knownSystems) returning {errors}: unknown system id; empty allow list; any key named default or auto. A field with no coding block means {allow:['none']}. Tests with a made-up field.
```

#### [ ] P2b. Several codings per field in `code_bindings`
**Files:** new migration, api.js | **Paste:** code_bindings routes and table
```text
Allow more than one binding per (set, field) when systems differ; the unique key becomes (set_id, field_id, system). A binding is refused if the field's coding.allow does not list that system. Tests: two systems on one field accepted; a disallowed system refused with a plain sentence.
```

#### [ ] P2c. `projectCase` emits a list of codings
**File:** elements.js | **Paste:** projectCase and its tests (F4)
```text
Element rows carry codings:[{system, code}] (empty list when none) in place of single system and code. Only codes from bindings. Update the element row shape in ELEMENTS.md. Tests with a made-up set: two systems on one field, none, and a disallowed system absent.
```

#### [ ] P3. Coding tick boxes in the set editor
**File:** enhancer.html | **Paste:** the field editor renderer, P2a
```text
In the field editor show tick boxes for each code system from code_systems plus "My own local codes" and "No code" (default). Save writes field.coding; the server runs validateCoding. Plain note under the boxes: "codes are typed by a person and verified; the app never fills them in". Test with a made-up set.
```

#### [ ] P4a. Local code lists (server)
**Files:** migration, api.js, permissions.js | **Paste:** the verified_codes routes, permissions.js
```text
Table local_codes (system_id, code, display, created_by, created_at) for systems of kind local; routes to create a local system and add codes (informatician, admin; audited). Local codes enter verified_codes only after the same verification step as standard ones. Tests: role matrix, audit rows, a local code is never offered as a standard one.
```

#### [ ] P4b. Local code lists (screen)
**File:** enhancer.html | **Paste:** the Codes tool screen
```text
In the Codes tool add "Local code systems": create a system, add codes, see their verified state. No pre-filled content.
```

#### [ ] P5a. Slot `codeSystem` in `compatibility()`
**File:** elements.js | **Paste:** compatibility() from F3b
```text
A slot may carry codeSystem (default 'any'). 'any' matches with or without codes. A named system is met only if the element has a coding in that system; otherwise 'partly' with the basis "needs a code in <system>". Tests with made-up sets: any, named met, named missing, none.
```
*Note (20 Nov 2026): `elements.js` already matches a slot `codeSystem` (met, or partly with a code-system basis) and already carries several codings in the key. In this chat check it and add only the missing tests; do not rewrite.*

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
