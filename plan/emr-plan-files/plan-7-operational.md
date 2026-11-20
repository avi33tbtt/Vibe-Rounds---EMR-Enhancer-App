# Phase 7: allergies, MAR, ADT, charge summary

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 25. Phase 7: operational components, rewritten as data

Orders, allergies, MAR, ADT and charge summary are **seed sets plus EMR view pathways plus a few generic view types**, using the Phase V engine. No `orders` or `mar` screen exists in code. Each generic type is proven with a made-up set (rule E3).

Rules for every Phase 7 chat: zero pre-filled doses, thresholds or rules; discontinuing never hard-deletes; doses free text only; unverified billing codes omitted; Context block from section 12 applies.

Prerequisite: Phase V finished (V8 gate).

(Task 48, Orders, is in `plan-O-orders.md`.)

### 49. Allergies and MAR

#### [ ] 49a1. `care.allergies` seed (data only)
**File:** element-sets.js | **Paste:** one care set
```text
Add care.allergies, repeat group "allergies": substance text, reaction text, severity select (Mild, Moderate, Severe), recorded_at datetime. View block: {"type":"flowsheet","timeField":"recorded_at","banner":{"chipField":"substance"}}. No entries, no rules.
```

#### [ ] 49a2. Generic `banner` chips
**Files:** views.js, enhancer.html | **Paste:** the patient banner renderer, patientView
```text
After validating the banner key, the banner shows one chip per active row's chipField from every applied set that has a banner block (skip entered_in_error; text escaped). Display only. Test with a made-up set.
```

#### [ ] 49b1. `care.mar` seed (data only)
**File:** element-sets.js | **Paste:** one care set
```text
Add care.mar, group "admin": mar_time datetime, mar_item text, mar_order_id text, mar_result select (Given, Held, Refused), mar_reason text, dose_given text (free text), mar_by session user, mar_note text. View block: {"type":"flowsheet","timeField":"mar_time","crosscheck":{"against":{"setId":"care.allergies","field":"substance"},"textField":"mar_item","message":"Review allergy list before administering"}}. No dose values, no rules.
```

#### [ ] 49b2a. `linkedgrid`: validator and list of source rows (pure)
**File:** views.js | **Paste:** the section list in VIEWS.md
```text
Add the section {"type":"linkedgrid","source":{"setId","field","filterField","filterValue","statusField","statusValues"},"into":{"setId","itemField","idField"}} to validatePathwayViews, and a pure function linkedRows(caseRows, source) returning active source rows (skip entered_in_error). Tests with two made-up sets.
```

#### [ ] 49b2b. `linkedgrid`: render and add row
**File:** enhancer.html | **Paste:** linkedRows, rows append in Store, the section renderer registry
```text
Render the source rows with an "Add entry" button that opens a new row in the target set with the item text copied and the source row id in the id field (decision 14). Doses are never calculated, converted, summed or auto-filled. Test with two made-up sets.
```

#### [ ] 49b3. Generic `crosscheck` (non-blocking note)
**File:** enhancer.html | **Paste:** the form for adding a row
```text
When a typed text in textField contains (case-insensitive) a value from the against set's active rows, show the message from the data under the field. Never blocks saving. Test with a made-up set.
```

#### [ ] 49b4. Seed `pathway.emr.mar` (data only)
**Files:** element-sets.js, emr-views.test.js | **Paste:** the handover example
```text
Add pathway.emr.mar: members care.orders, care.allergies, care.mar (not optional), surface case_tab {id "mar", label "MAR"}, sections [{"type":"linkedgrid",...as in 49b2...},{"type":"setTable","setId":"care.mar"}]. Add to the optional list in V7a (not on by default). Tests: validates; rules [].
```

### 50. ADT and schedule

#### [ ] 50a1. `care.adt_schedule` seed (data only)
**File:** element-sets.js | **Paste:** one care set
```text
Add care.adt_schedule, group "adt": adt_time datetime, adt_event select (Admission, Ward Transfer, Discharge, Outpatient Visit, Follow-up Scheduled), adt_ward text, adt_bed text, adt_clinician text, adt_status select (Scheduled, Arrived, Completed, Cancelled). View block: {"type":"flowsheet","timeField":"adt_time"}. No rows, no rules.
```

#### [ ] 50a2. "Apply to encounter" (decision 15)
**Files:** enhancer.html | **Paste:** Store.patients.updateEncounter signature, the bed_occupied message code
```text
In the ADT table, for a latest Admission or Ward Transfer row whose ward/bed differs from the open encounter, show a button "Apply to encounter" calling the existing encounter route (the server keeps one open encounter per bed; show bed_occupied in plain words). The banner and board keep reading the encounter record. Nothing changes silently. Server mode only.
```

#### [ ] 50b1. Generic `upcoming` view and `patients_panel` surface
**Files:** views.js, enhancer.html | **Paste:** the Patients screen render function
```text
Add view type "upcoming": rows of one set whose time is in the future and whose event field is in a listed set of values, ordered by date. Add the patients_panel surface that shows it across the ward's patients. Test with a made-up set.
```

#### [ ] 50b2. Seed `pathway.emr.schedule` and FHIR Encounter from ADT
**Files:** element-sets.js, enhancer.html | **Paste:** buildBundle Encounter part
```text
Add pathway.emr.schedule (surface patients_panel, member care.adt_schedule, upcoming view with events Follow-up Scheduled and Outpatient Visit). buildBundle Encounter status (planned, in-progress, finished) and location come from a "fhir" block on care.adt_schedule; a Discharge row changes the exported status without deleting data.
```

### 51. Charge capture

#### [ ] 51a1. Migration: allow icd10 and cpt in verified_codes
**Paste:** the verified_codes check constraint
#### [ ] 51a2. Codes tool and validation for icd10 and cpt; unverified codes stay out of every export; tests
#### [ ] 51b1. Charge summary aggregate (server): verified Condition codes, completed orders, stay length from ADT, read from the bindings in `pathway.emr.charge_summary`
#### [ ] 51b2. Seed `pathway.emr.charge_summary` (surface export_section, sections verifiedConditions, completedItems, stayLength) and its renderer from the section registry
#### [ ] 51b3. JSON and CSV export, audited, formula-safe; billing never touches notes or alerts
```text
(one file per task) Data and generic code only; no billing code is pre-filled; unverified codes omitted. Return edits only.
```

### 52. Tests

#### [ ] 52a. care.orders seed has no doses/thresholds/rules; actions need a reason where declared; row kept after Discontinue
#### [ ] 52b. MAR never sums doses; mar_by from session; allergies seed empty; crosscheck never blocks
#### [ ] 52c. ADT seed empty; Discharge changes exported Encounter status without deleting data; no silent encounter change
#### [ ] 52d. Unverified ICD-10/CPT omitted; export audited; CSV formula-safe
```text
Tests only. Return only the new test blocks, not the whole file. Paste only the test helpers and the code under test.
```
