# DEMO-DATA.md: synthetic demo patients

Ten synthetic patients with longitudinal records, generated from data. This file is the contract for `demo-data.js` (the generator), `demo-personas.json` (the people), `demo-expected.json` (what they must produce), `seed-demo.js` (server) and the Demo mode loader. Written in task D1, 20 Nov 2026. Rules E1 to E9 in VIEWS.md apply: the generator names no set id, no field id and no option text.

## 1. Rules

1. **Synthetic only.** Names are "Demo Patient 01" to "Demo Patient 10". No phone, no national id. Every demo patient carries a synthetic marker (section 5) so it can be told from a real one at a glance (decision 35).
2. **Deterministic.** The same `seed` and the same `anchor` give byte-identical output. Seeded random numbers only (no `Math.random`, no `Date.now` inside the generator).
3. **Generated from data.** Everything a persona records is in `demo-personas.json`: which sets, which fields, how often, with what plausible-looking values. The generator code only interprets that file.
4. **Plausibility ranges are not clinical.** A value range in a persona only makes numbers look believable. It is never a normal range, band, target or limit, nothing compares against it, and the persona validator refuses keys named `min`, `max`, `threshold`, `band`, `target`, `limit`, `dose` or `default` (the ranges use the key `plausible`).
5. **Real paths.** The server loader writes through the app's own routes, so versions, audit rows, `entered_by`, entered-in-error reasons and `row_time` behave exactly as in use (section 4). The Demo mode loader writes the same data through `Store` into localStorage.
6. **No rules fire.** Seeds hold no rules and demo data adds none. Screens show data as recorded.
7. **Codes are a manual job.** Demo elements stay uncoded until the owner verifies codes. Coverage then shows "needs a code".
8. **Throwaway databases only.** Patients and encounters are never deleted in this system. Seeding needs `ALLOW_DEMO_SEED=true`, is refused when `NODE_ENV` is `production`, and is meant for a database you can drop (decision 36).
9. **Never a package.** Demo data is not published to the registry (the lint rejects patient-like content, 47a2).
10. **Volume comes from the Analytics app's generator** (decision 37, task D8). Nothing here is a second generator.

## 2. The ten patients

| # | Persona | Span | Exercises | Needs |
|---|---|---|---|---|
| D-01 | Ward patient, I/O and vitals | one 3-day stay | flowsheets, I/O sums per window, ward board, handover | Phase V |
| D-02 | Diabetic emergency pathway | one 5-day stay | DKA pathway sets, daily insulin grid, sliding-scale free text, HbA1c, no rule fires | Phase V |
| D-03 | Snake envenomation pathway | one 2-day stay | second disease pathway, notes with sign and amend | Phase V |
| D-04 | Fever monitoring | one 4-day stay | fever chart, vitals trend, daily grid | Phase V |
| D-05 | Chronic diabetes follow-up | 18 months, about 6 visits | long series, HbA1c every few months, summary cards over time | Phase V, F4 |
| D-06 | Chronic blood-pressure follow-up | 24 months, about 8 visits | long series, missed visits, two yearly points | Phase V, F4 |
| D-07 | Readmission | two stays about 3 weeks apart | encounter utilisation, time to event, ADT transfers, one open encounter per bed | Phase 7 (ADT) |
| D-08 | Duplicate registration, merged | two records merged | `mergedInto`, rows on both records counted once in projection and export | Phase 5, F4 |
| D-09 | Data-quality case | 6 weeks | rows with a missing or invalid time, entered-in-error rows with reasons, amended rows, text-only elements, a recorded conflict | Phase V, F4 |
| D-10 | Orders, allergy and MAR | one 4-day stay | order statuses, a discontinued row kept, allergy chips, MAR cross-check note, free-text doses never summed | Phase 7, Phase O (added in D6) |

## 3. Anchor date and offsets

All times are **offsets from one anchor** (an ISO date-time in UTC, default `2026-11-01T08:00:00Z` for tests). The anchor is the **end** of the data: offsets are zero or negative ("-72h" is three days before the anchor). Moving the anchor moves every record by the same amount, so the data can be made to "end today" without changing it. No generated time is later than the anchor, and the loader refuses an anchor in the future (the server refuses future dates of birth and future encounter starts).

Offset units: `h` (hours), `d` (days), `m` (minutes). A date of birth is an offset in years from the anchor (`"ageYears"`), never a typed date.

## 4. What the real paths allow (from D0)

The server loader runs these in order for each patient, as a named demo user per role:

1. `POST /patients` (name, sex, ageYears). The MRN is made by the server and a client MRN is refused, so demo MRNs look like any other. A second record with the same name and age (D-08) gets a 409 `possible_duplicate` unless `confirmDifferent: true` is sent, which is part of that scenario.
2. `POST /patients/:id/encounters` (type, startAt, ward, bed). `startAt` must not be in the future. One open encounter per bed.
3. `POST /cases` with a client id, the applied sets and the pathways, then `POST /cases/:id/link` to the patient and encounter.
4. `POST /cases/:id/rows` for each row, with a client-made row id (a re-run finds the stored row) and `rowTime`. A row with no time sends no `rowTime`; a row with an invalid time is sent as text the server keeps with a null time.
5. Amend (PATCH row) with a reason, entered-in-error (POST `.../error`) with a reason, notes with sign and amend.
6. `POST /encounters/:id/close` with `endAt` for every finished stay.
7. `POST /patients/:id/merge` for D-08 (admin).

**One limit to state plainly:** `entered_at` is always the server's clock at seeding time. Seeded history has a historical `row_time` but an `entered_at` of "when the seeder ran". Anything that uses entered-at (the handover "entered since" list, entered-at analytics) shows seeding time for demo rows. The Demo mode loader sets `__at` itself and has no such limit.

## 5. Synthetic marker

A migration adds `patients.synthetic_key text` (nullable, unique). Only the demo seeder sets it (`demo-01` to `demo-10`); no route accepts it. Screens show a "synthetic" tag where the patient is shown when it is set. The seeder skips a patient whose `synthetic_key` already exists, so running it twice adds nothing. The marker is separate from the MRN, which stays server-made. In Demo mode the typed demo fields carry the name and a `synthetic:true` flag.

## 6. Persona file: `demo-personas.json`

```json
{
  "schemaVersion": 1,
  "anchor": "2026-11-01T08:00:00Z",
  "seed": 20261101,
  "actors": { "nurse": "demo-nurse", "doctor": "demo-doctor", "admin": "demo-admin" },
  "personas": [ { "...": "see below" } ]
}
```

One persona:

```json
{
  "id": "D-01",
  "title": "Ward patient, I/O and vitals",
  "patient": { "key": "p1", "name": "Demo Patient 01", "sex": "female", "ageYears": 54, "syntheticKey": "demo-01" },
  "extraPatients": [],
  "encounters": [
    { "key": "e1", "patient": "p1", "type": "admission", "start": "-72h", "end": "-2h", "ward": "Ward A", "bed": "A1" }
  ],
  "cases": [
    { "key": "c1", "patient": "p1", "encounter": "e1", "applied": ["<set id>"], "pathways": [], "narrative": "text" }
  ],
  "series": [
    {
      "case": "c1", "setId": "<set id>", "groupId": "<repeat group id>", "timeField": "<time field id>", "timeAs": "date",
      "by": "nurse",
      "schedule": { "start": "-72h", "every": "4h", "count": 18, "jitter": "15m" },
      "fields": {
        "<number field id>": { "gen": "int", "plausible": [60, 100] },
        "<select field id>": { "gen": "cycle", "options": ["one", "two"] },
        "<text field id>":   { "gen": "text", "options": ["free text one", "free text two"] },
        "<date field id>":   { "gen": "rowDate" }
      },
      "noTime": [4],
      "badTime": [5],
      "skip": [9],
      "inError": [{ "index": 7, "by": "doctor", "reason": "wrong patient" }],
      "amend": [{ "index": 2, "by": "doctor", "field": "<number field id>", "gen": "int", "plausible": [60, 100], "reason": "transcription error" }]
    }
  ],
  "values": [
    { "case": "c1", "setId": "<set id>", "fieldId": "<single-value field id>", "at": "-72h", "gen": "date", "offset": "+90d" }
  ],
  "notes": [
    { "case": "c1", "at": "-48h", "by": "doctor", "text": "free text", "sign": true, "amend": { "by": "doctor", "reason": "typo", "text": "free text" } }
  ],
  "merge": null
}
```

**Meaning of the keys**

| Key | Rule |
|---|---|
| `patient.key`, `encounters[].key`, `cases[].key` | local names, used only to link entries inside the file |
| `syntheticKey` | `demo-NN` with an optional letter (`demo-08b`), unique; written by the seeder only |
| `extraPatients` | optional further records of the same persona (D-08's duplicate): same fields as `patient`, same name and age so the server's duplicate warning is part of the scenario |
| `cases[].encounter` | may be `null`: the chart is linked to the patient with no encounter (used for the long follow-ups D-05 and D-06) |
| `series.timeAs` | optional, only `"date"`: the time field is a date field, so the row gets a date and not a date-time |
| `encounters[].end` | omitted means the encounter stays open (at most one open encounter per bed) |
| `cases[].applied` | set ids as data; the generator never names one. `pathways` lists pathway ids the same way |
| `series.timeField` | the data names the repeat group's time field; the generator only copies the value there |
| `schedule` | `start`, `every`, `count`, optional `jitter` (a seeded random shift within the stated size). `count` is the number of rows planned before `skip` |
| `skip` | row indexes not recorded (a missed visit or a missed reading) |
| `noTime` | row indexes recorded with no time (kept, shown "no time") |
| `badTime` | row indexes recorded with text that is not a time (the server keeps the row with a null time) |
| `inError` | row indexes marked entered in error, with who and a reason (3 to 1000 characters) |
| `amend` | row indexes amended once, with who, which field, a new generated value and a reason |
| `fields.<id>.gen` | `int`, `decimal` (with `places`), `cycle` (options in turn), `pick` (seeded choice), `text` (seeded choice of the listed texts), `rowDate` (the row's own date), `date` (an offset date), `datetime` (a date-time at an offset from the row or value time, e.g. `"offset": "-3h"`), `blank` (left empty). Every option, text and range is in the file, not in code |
| `fields.<id>.plausible` | `[low, high]` for making numbers; never compared with anything |
| `values` | single (non-repeat) values written once at `at` |
| `notes` | optional, with sign and amend steps; sign is by a doctor or admin |
| `merge` | `null`, or `{ "from": "p2", "into": "p1", "by": "admin", "reason": "duplicate registration" }`; `from` and `into` are two different patients of this persona (the second one is in `extraPatients`) and both exist before the merge |

**Validation (the generator's schema check, tested with a made-up file):** unique persona ids, `syntheticKey` pattern and uniqueness (including `extraPatients`), `timeAs` only `"date"`, every link key resolves, offsets are zero or negative and parse, indexes are within `count` and not both `skip` and `inError`, no banned key names, no phone or national id keys, at most one open encounter per ward and bed, merge is between two different patients of the persona, and the persona contains no key that names a set (`setId` and `fieldId` appear only as data values in `series`, `values`, `cases`).

## 7. Expected results: `demo-expected.json`

States what each persona must produce, so tests and the analytics acceptance run have something to compare with.

```json
{
  "schemaVersion": 1,
  "totals": { "patients": 10, "encounters": 0, "cases": 0, "rows": 0, "activeRows": 0, "enteredInErrorRows": 0, "rowsWithoutTime": 0, "amendedRows": 0, "signedNotes": 0 },
  "personas": {
    "D-01": { "patients": 1, "encounters": 1, "openEncounters": 0, "cases": 1,
              "rowsBySet": { "<set id>/<group id>": 18 },
              "enteredInErrorRows": 0, "rowsWithoutTime": 0, "amendedRows": 0 }
  },
  "events": {
    "D-07": { "readmissionGapDays": 21 },
    "D-08": { "mergedInto": "demo-08", "mergedFrom": "demo-08b", "rowsOnDuplicate": 8, "rowsOnKept": 8 }
  }
}
```

The numbers above are an example. The file is **derived** by `expectedOf(generateDemo(...))` in `demo-data.js` (from the generated data, not the persona file) and committed, so a change to a persona shows up as a reviewed diff in `demo-expected.json`, and a test fails when the two disagree. The server run (D3b) and the Demo mode run (D4) are both checked against it.

## 8. Files and who writes them

| File | Written in | Holds |
|---|---|---|
| `DEMO-DATA.md` | D1 (this), extended in D8 | the contract |
| `demo-data.js`, `demo-data.test.js` | D2a, D5a, D5b1, D5b2 | pure generator, schema check, `expectedOf`; tests for longitudinal shape, merge, data quality and real-looking text (D5b1), projectCase and export (D5b2, after F4) |
| `demo-personas.json` | D2b (D-01 to D-04), D2c (D-05 to D-09), D6 (D-10, ADT, allergy, order, MAR rows) | the ten people |
| `demo-expected.json` | D2c, D6 | expected counts and events |
| `seed-demo.js` | D3a, D3b | server loader (guards, idempotency) |
| Demo mode loader | D4 | "Load 10 demo patients" in `store.js` and `enhancer.html` |
| migration for `patients.synthetic_key` | D3a | the marker (section 5) |
| fixtures and the Analytics comparison | D7a, D7b | export check |
| `DEMO-WALKTHROUGH.md` | D9 | one-page walkthrough |

## 9. Later changes this schema expects

D6 adds orders, allergy, MAR and ADT rows by adding `series` and `amend` entries only; an order moving through its listed statuses is an `amend` on the status field with a reason, a discontinued order stays as a row. MAR doses are free text and never summed. If D6 finds it needs a new key, it adds it here first.
