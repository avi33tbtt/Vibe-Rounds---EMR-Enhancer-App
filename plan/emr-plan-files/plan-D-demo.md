# Phase D: synthetic demo data

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 27. Phase D: synthetic and longitudinal demo data (10 patients)

*Why: every gate in 15.3 needs real-looking data to look at, and the analytics need time spread over months, not one afternoon. This phase builds **ten synthetic demo patients with longitudinal records**, loaded through the app's own recording sets, plus a pointer to the Analytics app's own generator for volume. Demo data is **data, never a package**: the registry lint rejects patient-like content (47a2) and nothing here is ever published there.*

### 27.1 Rules for all demo data
- **Synthetic only.** Fixed fake names ("Demo Patient 01" and so on), a clearly synthetic MRN pattern, no real person, no real number. Every demo record can be told apart from a real one at a glance (decision 35).
- **Deterministic.** Same seed and same anchor date give the same data. Tests rely on it.
- **Generated from data, not hand-written code.** Each patient is a persona file (`demo-personas.json`): which sets, which fields, how often, what generation range. The generator code names no set or field (rule E1). Generation ranges are only there to make plausible-looking numbers; they are **not** clinical ranges, bands or targets and nothing compares against them.
- **Goes through the real paths.** Rows are written with the same functions as normal charting, so versions, audit rows, `entered_by`, entered-in-error reasons and `row_time` behave exactly as in use.
- **No rules fire.** Seeds hold no rules; demo data adds none. Screens show data as recorded.
- **Codes are a manual job.** The software never fills in a code. Demo elements are uncoded until the owner verifies codes in the official browsers and attaches them (section 14). Until then coverage shows "needs a code", which is itself a useful demonstration.
- **Throwaway databases only.** Patients and encounters are never deleted in this system, so demo seeding is refused in production and is meant for a database you can drop (decision 36).
- **One expected-results file.** `demo-expected.json` states what each persona must produce (row counts, error rows, rows without time, readmissions, merged records). Tests and the analytics acceptance run check against it.

### 27.2 The ten patients

Time is stored as offsets from one **anchor date**, so the data can be moved to "ending today" without changing it.

| # | Persona (synthetic) | Span | What it exercises | Needs |
|---|---|---|---|---|
| D-01 | Ward patient, I/O and vitals | one 3-day stay | flowsheets, I/O sums per window, ward board, handover, shift view | Phase V |
| D-02 | Diabetic emergency pathway | one 5-day stay | DKA pathway sets, daily insulin grid, sliding-scale free text, HbA1c, "no rule fires" | Phase V |
| D-03 | Snake envenomation pathway | one 2-day stay | second disease pathway, notes with sign and amend | Phase V |
| D-04 | Fever monitoring | one 4-day stay | fever chart, vitals trend, daily grid | Phase V |
| D-05 | Chronic diabetes follow-up | **18 months**, about 6 visits | long time series, HbA1c every few months, summary cards over time, V4 time series | Phase V, F4 |
| D-06 | Chronic blood-pressure follow-up | **24 months**, about 8 visits | long series, missed visits, two yearly points for trends | Phase V, F4 |
| D-07 | Readmission | two stays **about 3 weeks apart** | encounter utilisation, time to event, ADT transfers, one open encounter per bed | Phase 7 (ADT) |
| D-08 | Duplicate registration, merged | two records merged | `mergedInto`, rows on both records counted once in the projection and the export | Phase 5, F4 |
| D-09 | Data-quality case | 6 weeks | rows with a missing or invalid time, entered-in-error rows with reasons, amended rows (history drawer), text-only elements (V1 only), a recorded conflict | Phase V, F4 |
| D-10 | Orders, allergy and MAR case | one 4-day stay | order set with engine statuses, discontinued row kept, allergy chips, MAR with cross-check note, free-text doses never summed | Phase 7, Phase O |

*The two chronic patients are the longitudinal core. The three stays and the readmission give time-to-event data. D-09 is what makes the completeness analytic show something real. D-10 can only be built after Phase O.*

**Volume is not made here.** For hundreds of patients and the five analytics modes, use the Analytics app's own deterministic generator (`synthetic.js`, same seed and end date give the same bundle; options for inpatient detail and uncoded text). Documenting which seeds and options to use is task D8; no second generator is built in the EMR.

### 27.3 Tasks

#### [x] D0. Inventory of existing demo and synthetic code (no code)
**Run yourself, paste the output:**
```text
grep -n "demo\|synthetic\|Demo" enhancer.html store.js | head -60
grep -n "createPatient\|createEncounter\|mergedInto" patients.js | head -20
sed -n 1,45p seed.js
```
```text
Do not change code. From this output list: (1) what Demo mode already generates (synthetic-case buttons, demo patients), (2) the smallest set of existing functions that create a patient, an encounter, a case, apply a set and append a row with a time, (3) whether patients can carry a "synthetic" marker today or need a column. Reply as a short table.
```

*D0 result (20 Nov 2026), from `enhancer.html`, `store.js`, `patients.js`, `api.js`, `001_core.sql`. (1) Demo mode today: localStorage cases (`Store.mode==='local'`), typed demo patient fields on the case (`demo_patient`: name, ageSex, bed, mrn), the `synth()` button "Load 12 synthetic cases" (snake-envenomation cases for the Analytics tab; random, `syn:true`), banners "Demo mode: ... synthetic data only". No demo patients with encounters or longitudinal rows exist. (2) Real paths, all server routes: `POST /patients` (strict body: name, sex, dateOfBirth or ageYears, phone, nationalId; duplicate check gives 409 unless `confirmDifferent`; date of birth cannot be in the future); `POST /patients/:id/encounters` (type, startAt not in the future, ward, bed, attendingId; one open encounter per bed); `POST /encounters/:id/close` (expectedVersion, endAt); `POST /cases` (client id allowed, `applied`, `narrative`, `pathways`); `POST /cases/:id/link` (expectedVersion, patientId, encounterId); `POST /cases/:id/rows` (setId, groupId, row, `rowTime`, client id allowed; checks `canAddRow` and the set's `enter` access); `POST /cases/:id/rows/:rid/error` and PATCH for entered-in-error and amend; `POST /patients/:id/merge` (admin). In Demo mode the same cases are written through `Store` into localStorage. (3) Gaps: **MRN** is made by the server (`patient_mrn_seq`, 7 digits plus Luhn check) and a client MRN is refused, so the "clearly synthetic MRN pattern" of decision 35 cannot be had through the real create path; **no synthetic marker** exists on `patients` (001_core.sql; check later migrations with `grep -n "ALTER TABLE patients" *.sql`); **`entered_at` is the server's `now()`** on every insert, so seeded history has a historical `row_time` but an `entered_at` of seeding time (this affects the handover "entered since" list and any entered-at analytics: state it in DEMO-DATA.md); the seeder needs a user to act as (`entered_by`, `created_by`). **Proposed defaults for D1, tell me if you disagree:** a migration adds `patients.synthetic_key text` (nullable, unique, set only by `seed-demo.js`, never by a route) and the screens show a "synthetic" tag when it is set; names are "Demo Patient 01" to "10"; MRN stays server-made (the marker and the name identify demo patients); `seed-demo.js` idempotency checks `synthetic_key`, not MRN; `seed-demo.js` runs the app's own route handlers as a named demo user.*

#### [x] D1. DEMO-DATA.md and persona schema (doc only)
**File:** new `DEMO-DATA.md` | **Paste:** 27.1 and 27.2 of this plan
```text
Write DEMO-DATA.md from this text: the rules, the ten personas, the anchor-date idea, the persona file schema (sets, fields, schedule, generation spec, entered-in-error and missing-time rules, merge links) and the expected-results file. No code.
```

*D1 result (20 Nov 2026): `DEMO-DATA.md` written: rules, the ten personas, the anchor-date idea (offsets are zero or negative, default anchor `2026-11-01T08:00:00Z`), what the real routes allow (from D0), the synthetic marker (`patients.synthetic_key`, set by the seeder only, migration in D3a), the persona file schema (patient, encounters, cases, series with schedule, skip, noTime, badTime, inError, amend; values; notes; merge), the persona validation list and the derived `demo-expected.json`. Ranges use the key `plausible`, never `min` or `max`. Stated limit: `entered_at` is seeding time on the server. Decisions 35 to 37 applied as defaults.*

#### [x] D2a. `demo-data.js`: deterministic generator (pure)
**Files:** new root `demo-data.js`, `demo-data.test.js` | **Paste:** DEMO-DATA.md schema, one seed set
```text
Create demo-data.js with generateDemo({seed, anchor, personas}) returning patients, encounters, cases and rows with timestamps, entered_by placeholders, status and error reasons, all derived from the persona data. The code must not name any set or field id. Seeded random numbers only. Tests with a made-up persona file: determinism (same seed and anchor, identical output), offsets applied to the anchor, a missing-time row, an entered-in-error row, a merge link.
```

*D2a result (20 Nov 2026): `demo-data.js` (pure; seeded mulberry32, one random stream per persona, one random number per generated field so edits elsewhere do not shift values) exports `generateDemo`, `validatePersonas`, `expectedOf`; `demo-data.test.js` (7 tests, made-up persona only, plus a test that the generator source names no set or field). Bad time is sent as the text `not a time`; a missing time is `rowTime: null`.*

#### [x] D2b. `demo-personas.json`: D-01 to D-04 (data only)
**File:** new `demo-personas.json` | **Paste:** DEMO-DATA.md schema, the pathway member lists for DKA, snakebite, fever
```text
Add personas D-01 to D-04 (the four short stays) as data only, using the schema. Generation ranges only make plausible-looking numbers; no clinical range, band or target. Test: the file validates against the schema and generateDemo runs on it.
```

*D2b result (20 Nov 2026): `demo-personas.json` holds D-01 to D-04. Added to the generator: gen `datetime` (offset from the row or value time) and series key `timeAs: "date"` (for a date-typed time field such as `a1c_date`). Written nowhere: `fever_thr`, `tgt_low`, `tgt_high`, `a1c_target`, `a1c_due`, `gap`, `neuro`, `rxn`, `vials`. Free-text doses hold no numbers. D-04 has no daily grid (the grid set is not in the fever pathway; D-02 covers it). `cases[].pathways` holds pathway ids and `applied` lists the member sets: D3a converts this to whatever `POST /cases` takes. Tests check every set, group and field against `element-sets.js`.*

#### [x] D2c. `demo-personas.json`: D-05 to D-09 (data only)
**File:** demo-personas.json | **Paste:** the file from D2b, DEMO-DATA.md schema
```text
Add personas D-05 to D-09: two long follow-ups (18 and 24 months, with missed visits), the readmission shell, the merged duplicate pair, the data-quality case. Data only. Test: validates and generateDemo runs on it. D-10 comes in D6.
```

*D2c result (20 Nov 2026): D-05 to D-09 added; `demo-expected.json` derived by `expectedOf(generateDemo(...))` and checked by a test. Added to the schema: `extraPatients` (the duplicate record for D-08; both keep the name and age, `syntheticKey` `demo-08` and `demo-08b`, so the key pattern is now `demo-NN` plus an optional letter) and a stricter merge check (two different patients of the persona). D-05 and D-06 have no encounter (`encounter: null`; a chart may be linked with no encounter) and are spans of 550 and 730 days from day offsets. Totals now: 10 patient records, 9 encounters, 11 cases, 348 rows, 4 entered in error, 6 without time, 2 amended, 3 signed notes. **Not in the persona data: "a recorded conflict" for D-09.** The schema has no key for it and a conflict is a 409 between two real writers; raise it in D3a (seeder) or D4. D-10 is added in D6.*

#### [x] D3a. `seed-demo.js`: write through the real paths
**File:** new root `seed-demo.js` | **Paste:** the D0 functions, create-admin.js (as a script model)
```text
Add a script that writes generateDemo output through the existing create and append paths (so version and audit rows are written) and prints a summary. Nothing else yet.
```

*D3a result (20 Nov 2026): `seed-demo.js` runs against a running server's own `/api` routes with a cookie and CSRF client, logged in as the named demo user `demo-seeder` (role admin, random password made at run time, never printed or stored). Order: patients (the D-08 duplicate warning is confirmed on purpose), encounters, cases linked to patient and encounter, rows with their time, entered-in-error where the persona says so, close finished stays, merges. `patients.synthetic_key` is set by direct SQL after each create, because no route accepts it. `--dry` prints the shape of the generated data and touches nothing. Exports `seed`, `client`, `demoUser`. **Still not handled: D-09's "recorded conflict"** (the persona schema has no key for it); decide in D4-era follow-up or leave to D7b.*

#### [x] D3b. Guards and idempotency for `seed-demo.js`
**Files:** seed-demo.js, test | **Paste:** seed-demo.js, the test database setup
```text
Refuse unless ALLOW_DEMO_SEED=true and NODE_ENV is not production; skip patients whose synthetic MRN already exists. Test on the test database: counts equal demo-expected.json; running twice adds nothing; production refused.
```

*D3b result (20 Nov 2026): `seed-demo.js` gained `assertAllowed` (production is checked first and cannot be overridden by the flag; `ALLOW_DEMO_SEED` must be exactly `true`), `seededState` and `run`. **Idempotency keys on `patients.synthetic_key`, not on MRN** (MRN is server-made, D0). All ten keys present: nothing is added. A partly seeded database is refused with a message, because the cases use fixed ids and cannot be resumed safely; use a fresh throwaway database. `seed-demo.test.js`: guard tests (no database needed) and a test on the test database (counts equal the generated data, second run adds nothing, production refused). The counts are checked against the generated data; the match to `demo-expected.json` is done by the existing expectedOf test.*

#### [x] D4. Demo mode loader (browser, localStorage)
**Files:** store.js, enhancer.html | **Paste:** the Demo mode demo-patient migration code
```text
Add "Load 10 demo patients" in Demo mode, using the same generateDemo output with a fixed anchor, so Demo mode and the server show the same data. Server mode never shows this button. Test: Demo mode count equals demo-expected.json.
```

*D4 result (20 Nov 2026): new `demo-local.js` (pure, works in Node and the browser; `toLocalCases(data)` turns generateDemo output into Demo-mode cases) and `demo-local.test.js`. `enhancer.html`: a "Load 10 demo patients" button on the Patients screen, hidden unless Demo mode is on (set in `paintMode`), and a click handler that fetches `/demo-data.js` and `/demo-personas.json`, runs `generateDemo` with seed 1 and anchor `2026-11-01T08:00:00Z` (the same as `seed-demo.js`), replaces earlier demo cases (`demo:true`) and keeps all other cases, then reloads. `server.js`: the three files added to `STATIC_FILES`. `store.js` is unchanged. Demo cases are not `syn:true`, so the Analytics tab's "Clear synthetic" leaves them alone. Demo patients carry a typed MRN such as `DEMO-01` (never a real-looking one). **Limits, state them in DEMO-DATA.md:** a merge is a server idea, so both D-08 charts load in Demo mode; the browser runs `demo-data.js` through a `module` shim, so it must not `require` anything; `demo-expected.json` key names are checked tolerantly in the test (it prints the keys if one is missing). **Check by hand:** `views.js` is not in `STATIC_FILES` (find what serves it and add the three files there if needed).*

#### [x] D5a. Longitudinal checks
**File:** `demo-data.test.js` | **Paste:** the persona schema only
```text
Tests on the real generated data: timestamps increase within a group; D-05 and D-06 span at least their stated months; D-07 has two encounters with the stated gap; counts equal demo-expected.json.
```

*D5a result (20 Nov 2026): five tests added to the end of `demo-data.test.js` (no change to `demo-data.js`). (1) Within every series the rows are in index order, recorded times never go backwards and none is after the anchor; this is stronger than the D2c test, which only compared indexes. (2) Every encounter ends after it starts and not after the anchor; two stays of one patient never overlap. (3) D-05 and D-06 span their stated 18 and 24 months with **one month of slack** (a series starts at its first visit, not on day one), have at least 5 recorded visits, and their charts have no encounter. (4) D-07 has two closed stays of one patient 14 to 28 days apart and the rounded gap equals `demo-expected.json`. (5) `demo-expected.json` totals, per-persona counts and `rowsBySet` equal counts made again from the raw generated rows, not through `expectedOf`, and persona counts add up to the totals. **Not run when written:** the persona and expected files were not available, so only a syntax check was done. If test 3 or 4 fails, say which: fix the persona schedule if the data is wrong, or the stated tolerance here if the plan's "about" is meant loosely.*

#### [x] D5b1. Merge and data-quality checks on the generated data
**File:** `demo-data.test.js` | **Paste:** nothing (the persona schema is enough)
```text
Tests on the real generated data: the merged pair D-08 is one person (row ids unique, every row counted once, both records resolve to the kept one); rows with a missing or invalid time are flagged and never dated; error and amended rows carry who and why; no demo name, value, note or reason matches a real-looking pattern (phone, long digit runs, e-mail).
```

*D5b1 result (20 Nov 2026): four tests and one `test.todo` added to the end of `demo-data.test.js` (no change to `demo-data.js`). (1) A small detector for real-looking text (7 or more digits in a row, a "+" number, "(ddd)", ddd-ddd-dddd, an e-mail), tested on its own; dates and times are removed first. It is a narrow heuristic, not a proof. (2) No name, value, note, narrative or reason is flagged by it, every name is "Demo Patient NN", and no persona has a phone or national id key. (3) D-08: row ids are unique, merges form no chain or loop, rows of both records add up on the kept record and equal `rowsOnDuplicate + rowsOnKept` in `demo-expected.json`, nothing is left on the duplicate. (4) Every row is `ok` (a real time), `none` (null) or `bad` (the text `not a time`); error rows have who (a known actor) and a reason of 3 to 1000 characters; amended rows have who, field, reason and value; the data holds both a missing and an invalid time. **Run only on a stand-in persona file** (the real `demo-personas.json`, `demo-expected.json` and `element-sets.js` were not available): the four tests passed there. If test 4 fails on "both a missing and an invalid time", the personas use only one kind: fix the persona data, not the test.*

#### [ ] D5b2. projectCase and export checks for D-08 and D-09 (after F4)
**File:** `demo-data.test.js` | **Paste:** projectCase (F4)
```text
Replace the `test.todo` named D5b2 at the end of demo-data.test.js with real tests: D-08 appears once in projectCase and once in the export (counted once, not twice); D-09's error rows and missing-time rows are skipped or flagged in projectCase exactly as F4 designs it, and the counts equal demo-expected.json.
```
*Moved out of D5b on 20 Nov 2026: it needs F4 (plan-core step 10), which comes after Gate D's other checks. Do it right after F4. The export half is also covered again by D7a.*

#### [ ] D6. Add D-10 and extend others after Phase 7 and Phase O
**Files:** demo-personas.json, demo-expected.json | **Paste:** the care.orders, care.allergies, care.mar, care.adt_schedule seeds
```text
Add persona D-10 and ADT, allergy, order and MAR rows to D-07 and D-10 as data only. Orders move through listed engine transitions; one is discontinued with a reason and kept; MAR rows carry free-text doses that are never summed. Update demo-expected.json and tests.
```

#### [ ] D7a. Export the demo patients (EMR side)
**File:** EMR test | **Paste:** F7c route test
```text
Test: seed the ten demo patients on the test database, call the export route, save the bundle and manifest as fixtures, and check the manifest counts against demo-expected.json.
```

#### [ ] D7b. Run and compare in the Analytics app
**Files:** Analytics repo script | **Paste:** the Analytics import route, the fixtures from D7a
```text
Import the fixture bundle and manifest as a batch, run each wave 1 definition, and compare with demo-expected.json (the completeness analytic must report the missing-time rows built into D-09; encounter utilisation must show the readmission). A mismatch is a bug in the export, the definition or the expectations; say which.
```

#### [ ] D8. Volume data from the Analytics app (doc only)
**File:** DEMO-DATA.md | **Paste:** the generator and uncoded-data sections of the Analytics README
```text
Document, in DEMO-DATA.md, which generator seeds and options to use for volume demos (batch size, years, inpatient detail on, uncoded partial for the V1 to V5 comparison) and how to import them. Do not add code.
```

#### [ ] D9. Walkthrough
**File:** new `DEMO-WALKTHROUGH.md` | **Paste:** DEMO-DATA.md
```text
Write a one-page walkthrough: for each demo patient, which screen to open and what to see (ward board, handover, flowsheet, summary cards, history drawer, orders, export, then the Analytics app and its coverage and readiness). Plain words, no judgement of care, banner visible in every step.
```

**Gate D:** after D5 (D5a and D5b1; D5b2 follows F4) the ten patients load on a fresh database and in Demo mode and match `demo-expected.json`; after D7 the same data reaches the Analytics app and its wave 1 results match the expectations.
