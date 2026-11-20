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

#### [ ] D0. Inventory of existing demo and synthetic code (no code)
**Run yourself, paste the output:**
```text
grep -n "demo\|synthetic\|Demo" enhancer.html store.js | head -60
grep -n "createPatient\|createEncounter\|mergedInto" patients.js | head -20
sed -n 1,45p seed.js
```
```text
Do not change code. From this output list: (1) what Demo mode already generates (synthetic-case buttons, demo patients), (2) the smallest set of existing functions that create a patient, an encounter, a case, apply a set and append a row with a time, (3) whether patients can carry a "synthetic" marker today or need a column. Reply as a short table.
```

#### [ ] D1. DEMO-DATA.md and persona schema (doc only)
**File:** new `DEMO-DATA.md` | **Paste:** 27.1 and 27.2 of this plan
```text
Write DEMO-DATA.md from this text: the rules, the ten personas, the anchor-date idea, the persona file schema (sets, fields, schedule, generation spec, entered-in-error and missing-time rules, merge links) and the expected-results file. No code.
```

#### [ ] D2a. `demo-data.js`: deterministic generator (pure)
**Files:** new root `demo-data.js`, `demo-data.test.js` | **Paste:** DEMO-DATA.md schema, one seed set
```text
Create demo-data.js with generateDemo({seed, anchor, personas}) returning patients, encounters, cases and rows with timestamps, entered_by placeholders, status and error reasons, all derived from the persona data. The code must not name any set or field id. Seeded random numbers only. Tests with a made-up persona file: determinism (same seed and anchor, identical output), offsets applied to the anchor, a missing-time row, an entered-in-error row, a merge link.
```

#### [ ] D2b. `demo-personas.json`: D-01 to D-04 (data only)
**File:** new `demo-personas.json` | **Paste:** DEMO-DATA.md schema, the pathway member lists for DKA, snakebite, fever
```text
Add personas D-01 to D-04 (the four short stays) as data only, using the schema. Generation ranges only make plausible-looking numbers; no clinical range, band or target. Test: the file validates against the schema and generateDemo runs on it.
```

#### [ ] D2c. `demo-personas.json`: D-05 to D-09 (data only)
**File:** demo-personas.json | **Paste:** the file from D2b, DEMO-DATA.md schema
```text
Add personas D-05 to D-09: two long follow-ups (18 and 24 months, with missed visits), the readmission shell, the merged duplicate pair, the data-quality case. Data only. Test: validates and generateDemo runs on it. D-10 comes in D6.
```

#### [ ] D3a. `seed-demo.js`: write through the real paths
**File:** new root `seed-demo.js` | **Paste:** the D0 functions, create-admin.js (as a script model)
```text
Add a script that writes generateDemo output through the existing create and append paths (so version and audit rows are written) and prints a summary. Nothing else yet.
```

#### [ ] D3b. Guards and idempotency for `seed-demo.js`
**Files:** seed-demo.js, test | **Paste:** seed-demo.js, the test database setup
```text
Refuse unless ALLOW_DEMO_SEED=true and NODE_ENV is not production; skip patients whose synthetic MRN already exists. Test on the test database: counts equal demo-expected.json; running twice adds nothing; production refused.
```

#### [ ] D4. Demo mode loader (browser, localStorage)
**Files:** store.js, enhancer.html | **Paste:** the Demo mode demo-patient migration code
```text
Add "Load 10 demo patients" in Demo mode, using the same generateDemo output with a fixed anchor, so Demo mode and the server show the same data. Server mode never shows this button. Test: Demo mode count equals demo-expected.json.
```

#### [ ] D5a. Longitudinal checks
**File:** `demo-data.test.js` | **Paste:** the persona schema only
```text
Tests on the real generated data: timestamps increase within a group; D-05 and D-06 span at least their stated months; D-07 has two encounters with the stated gap; counts equal demo-expected.json.
```

#### [ ] D5b. Merge and data-quality checks
**File:** `demo-data.test.js` | **Paste:** projectCase (F4) once it exists
```text
Tests: D-08 appears once in projectCase and in the export; D-09's error rows and missing-time rows are skipped or flagged as designed; no demo value or name matches a real-looking pattern (phone, long digit runs).
```

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

**Gate D:** after D5 the ten patients load on a fresh database and in Demo mode and match `demo-expected.json`; after D7 the same data reaches the Analytics app and its wave 1 results match the expectations.
