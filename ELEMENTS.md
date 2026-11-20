# ELEMENTS.md: recording to FHIR elements

*Source: plan sections 6.2 to 6.5 (plan-ref-design.md), plus the decisions of 20 Nov 2026 listed under "Decisions recorded in F0/F1". The code is `elements.js` (F2 onward). This file is a document only.*

The rule: analytics is built on FHIR elements and nothing else. An analytic never reads a set id, a field id or a case row. Exactly one piece of code, the projection, knows both worlds. Everything before it is recording and lives in the EMR. Everything after it is analytics and lives in the Analytics app. The export is the only bridge.

## Glossary (one meaning each)

| Word | Meaning in this project |
|---|---|
| **Element** | A field of a set that is bound to FHIR: a resource, a value type, a unit, and optionally a verified code. |
| **Element key** | Text that identifies an element for matching: `Resource.path \| role \| unit \| system:code`. |
| **Element row** | One recorded value of one element: patient, encounter, time, key, value, status. Produced by the projection. Never stored by hand. |
| **Provides** | What a recording offers: its list of element keys. Derived from the set, never typed by hand. |
| **Requires** | What a summary, order set or analytic needs: a list of slots. A slot is a wished-for element key with parts left open (for example any code, unit mL). |
| **Coverage** | A definition-level check, before any patient data exists: does recording A provide what analytic B requires? met, partly met, unmet. |
| **Readiness** | A data-level check, after data exists: is the data filled in, coded and dated enough for this analytic to return something? |
| **Projection** | The pure function `projectCase(...)` that turns case rows into element rows. |
| **Reference list** | A clinical list an analytic may need (first-line drugs, risky pairs, abnormal limits, goals). Never in a definition. |

Coverage and readiness are different questions and are never merged into one score. Neither is a statement about quality of care.

## Roles (closed list)

A role says what kind of value a field holds, in terms matching can compare. The list is short and closed. A new role needs an informatician's proposal and an admin's approval (decision 25).

| Role | FHIR type | Comes from (set field type) | Matching compares |
|---|---|---|---|
| `time` | dateTime / effectiveDateTime | `datetime`, `date` | role only |
| `quantity` | Quantity | `number`, `integer` (with or without `unit`) | role + unit string (unitless is `-`) |
| `category` | CodeableConcept | `select` | role (+ option list, shown, not required) |
| `status` | code | `select` flagged as status in the view block | role |
| `text` | string | `text` | role |
| `actor` | Reference(Practitioner) | the session user | role |
| `link` | Reference | `text` holding another row's id (decision 14) | role |

### Decisions recorded in F0/F1 (20 Nov 2026)

These extend the type-to-role column only. They add no new role, so decision 25 is not triggered.

| Field type | Rule |
|---|---|
| `date` | role `time` (FHIR dateTime allows date precision) |
| `integer` | role `quantity`, unit as typed |
| `boolean` | no role yet. Not an element until a disease set is made exportable (decision 28) |
| `duration_min` | derived by the app, never recorded: never projected |
| `number` whose unit changes per row (`unitField`) | the unit is taken from that row's own unit field. A row with no unit has unit `-`. No conversion |
| fields marked `meta` (unit selectors, display-only thresholds) | never elements |
| a clinician-typed target (for example `a1c_target`) | has no `fhir` block, so is never an element |

## Element key

One line, human readable:

```text
Observation.value | quantity | mL  | -                      (I/O volume, no code attached)
Observation.value | quantity | Cel | <system>:<verified>    (a temperature with a verified code)
```

Two levels of matching, built in this order:

1. **Structural.** Compare resource, role and unit. Works with zero codes. This ships first.
2. **Concept.** Also compare `system:code`. The concept is the verified code already attached through `code_bindings`, so no new governed list is needed. A field with no verified code still gets structural matching plus manual binding. The software never fills in a code.

Coding is a free choice (Phase P): a field may carry several codings (any code system, a local system, or none), so the last part of the key becomes a list of `system:code` pairs; with none it is `-`. A slot says `codeSystem: any` unless an author asks for one.

Rules that keep matching honest: no unit conversion; every match shows its basis ("matched on: quantity, mL"); a same-role-different-unit pair is shown as "unit differs" with a manual bind button; a manual bind is stored locally and audited (decision 26).

## The projection

`projectCase(caseRows, sets, bindings)` is a pure function in a root file `elements.js` (browser and Node, same pattern as `views.js`). It is the single source of truth for the export. The EMR keeps no analytics table.

1. One element row per active row per bound field. Rows with `status = entered_in_error` are skipped.
2. Time comes from the row's `row_time`. If it is null the element row is kept with no time and counted by the completeness analytic; it still counts for V1 and V2, not for V4.
3. Value as recorded. Units are never converted, doses are never parsed, free text stays text.
4. A coding appears on an element row only if `code_bindings` holds it for that field and the field's `coding.allow` permits it. Unverified codes never appear.
5. Patients are resolved through `mergedInto` by the caller; the function receives the final patient id.
6. Viewing and projecting write nothing (rule E6).

## Element row shape

```json
{"patientId":"<uuid>","encounterId":"<uuid>","caseId":"<uuid>","rowId":"<uuid>",
 "resource":"Observation","role":"quantity","unit":"mL","codings":[],
 "valueNumber":250,"valueText":null,"time":"2026-11-20T08:30:00Z","status":"active",
 "source":{"setId":"care.intake_output","setVersion":2,"fieldId":"io_volume"}}
```

`codings` is a list of `{system, code}`, empty when the field has no code. It holds every binding of the field that the field's `coding.allow` permits (`none` allows no code; `local` allows the local systems the caller names), never a code the software made up. The older single `system` and `code` keys are gone.

`source` is kept only so a person can trace a number back and so a "who uses this field?" check works. **No analytic definition may read `source`** (rule E9). `elements.js` names no seed set id or field id.

## Where the inputs live today

| Input | Where |
|---|---|
| Field to FHIR binding | `fhir:{resource, valueType}` on a field in `element-sets.js` |
| Verified codes | table `verified_codes (system, code, display, verified_live)` |
| Field bindings | table `code_bindings (set_id, field_id, system, code, display)` |
| Recorded values | `case_rows (case_id, set_id, group_id, row jsonb, row_time, status, entered_by)`; `row` is `{fieldId: value}` as typed |

## How to add a role

1. **Informatician proposal.** Name, FHIR type, the set field type it comes from, what matching compares, and one example.
2. **Admin approval.** Recorded in the audit log.
3. **Validator entry.** Add the role to the closed list in `elements.js` and to the slot validator.
4. **Made-up-set test.** A test using a made-up set (not a seed set) with one field of the new role.
5. **One line here.** Add a row to the Roles table above.

A new role is a decision, not a side effect. Adding a type-to-role mapping for an existing role (like `date` to `time`) needs steps 3 to 5 only.
