# F0 inventory (20 Nov 2026)

Roles are taken from table 6.4 of plan-ref-design.md (field type to role). A field type that table does not list is marked GAP. `status`, `actor` and `link` never come from a plain seed field type (status needs a flag in the view block, actor is the session user, link is a text field holding a row id), so they do not appear below.

## 1. Every seed field (65 fields, 24 with a fhir block)

### disease.snake_envenomation

| Field | Type | Unit | fhir block | Role (6.4) |
|---|---|---|---|---|
| bite | datetime | - | none | time |
| arr | datetime | - | none | time |
| asv | datetime | - | none | time |
| gap | duration_min | - | none | GAP (duration_min) |
| wbct | select | - | none | category |
| swell | select | - | none | category |
| neuro | boolean | - | none | GAP (boolean) |
| vials | integer | - | none | GAP (integer) |
| rxn | boolean | - | none | GAP (boolean) |
| out | select | - | none | category |

### disease.dka

| Field | Type | Unit | fhir block | Role (6.4) |
|---|---|---|---|---|
| arr | datetime | - | none | time |
| ins | datetime | - | none | time |
| gap | duration_min | - | none | GAP (duration_min) |
| glu | number | mg/dL | none | quantity |
| ph | number | - | none | quantity |
| hco3 | number | mmol/L | none | quantity |
| k | number | mmol/L | none | quantity |
| ket | select | - | none | category |
| gcs | integer | - | none | GAP (integer) |
| fl | integer | mL | none | GAP (integer) |
| edema | boolean | - | none | GAP (boolean) |
| out | select | - | none | category |

### care.vitals

| Field | Type | Unit | fhir block | Role (6.4) |
|---|---|---|---|---|
| vit_time | datetime | - | none | time |
| temp | number | °C | Observation / valueQuantity | quantity |
| hr | number | bpm | Observation / valueQuantity | quantity |
| rr | number | /min | Observation / valueQuantity | quantity |
| bp_sys | number | mmHg | Observation / valueQuantity | quantity |
| bp_dia | number | mmHg | Observation / valueQuantity | quantity |
| spo2 | number | % | Observation / valueQuantity | quantity |
| weight | number | kg | Observation / valueQuantity | quantity |

### template.basic_emr

| Field | Type | Unit | fhir block | Role (6.4) |
|---|---|---|---|---|
| cc | text | - | Observation / valueString | text |
| hx | text | - | Observation / valueString | text |
| exam | text | - | Observation / valueString | text |
| assess | text | - | Observation / valueString | text |
| plan | text | - | Observation / valueString | text |

### care.hba1c_monitoring

| Field | Type | Unit | fhir block | Role (6.4) |
|---|---|---|---|---|
| a1c_date | date | - | none | GAP (date) |
| a1c | number | % | Observation / valueQuantity | quantity |
| a1c_target | number | % | Observation / valueQuantity | quantity |
| a1c_due | date | - | none | GAP (date) |
| cbg_time | datetime | - | none | time |
| cbg | number | mg/dL | Observation / valueQuantity | quantity |

### care.sliding_scale_insulin

| Field | Type | Unit | fhir block | Role (6.4) |
|---|---|---|---|---|
| ssi_time | datetime | - | none | time |
| ssi_glucose | number | mg/dL | Observation / valueQuantity | quantity |
| ssi_dose | text | - | MedicationAdministration / valueString | text |
| ssi_by | text | - | none | text |

### care.fever_chart

| Field | Type | Unit | fhir block | Role (6.4) |
|---|---|---|---|---|
| ft_time | datetime | - | none | time |
| temp | number | per row (temp_unit) | Observation / valueQuantity | quantity |
| temp_unit (meta) | select | - | none | category |
| route | select | - | Observation / valueString | category |
| pulse | number | bpm | Observation / valueQuantity | quantity |
| antipyretic | text | - | MedicationAdministration / valueString | text |
| fever_thr (meta) | number | - | none | quantity |
| fever_thr_unit (meta) | select | - | none | category |

### care.daily_insulin_monitoring

| Field | Type | Unit | fhir block | Role (6.4) |
|---|---|---|---|---|
| ins_time | datetime | - | none | time |
| slot | select | - | none | category |
| ins_glucose | number | mg/dL | Observation / valueQuantity | quantity |
| ins_dose | text | - | MedicationAdministration / valueString | text |
| ins_by | text | - | none | text |
| ins_note | text | - | none | text |
| tgt_low (meta) | number | mg/dL | none | quantity |
| tgt_high (meta) | number | mg/dL | none | quantity |

### care.intake_output

| Field | Type | Unit | fhir block | Role (6.4) |
|---|---|---|---|---|
| io_time | datetime | - | none | time |
| io_type | select | - | none | category |
| io_volume | number | mL | Observation / valueQuantity | quantity |
| io_note | text | - | none | text |

Role count over all 65 fields: time 11, GAP (duration_min) 2, category 10, GAP (boolean) 3, GAP (integer) 3, quantity 22, text 12, GAP (date) 2.

## 2. Fields without a fhir block that should have one to be an element

| Field | Role | Why |
|---|---|---|
| vit_time, ft_time, ins_time, ssi_time, cbg_time, io_time | time | Row time of a repeat group whose other fields are exported. Needed to place each value. |
| a1c_date | GAP (date) | Same job as the row times, but type date is not in 6.4. |
| io_type | category | Says whether io_volume is intake or a kind of output. Without it the volume cannot be told apart. |
| slot (daily insulin) | category | Says which daily check a glucose reading belongs to. |
| route (fever chart) | category | Already has a fhir block (Observation / valueString). Listed because select fields count only when their row feeds an exported value: it does. |
| temp_unit | category (meta) | Per-row unit of temp. Better carried as the unit of the value than as its own element (see gap 4). |
| ssi_by, ins_by | text | Type text, so role text. Role actor is the session user, not a typed name, so these are not actors. Leave off unless you want a recorded-by text element. |
| a1c_due | GAP (date) | A next-due date (a plan, not an observation). Stays off. |
| Disease sets (snake_envenomation 10 fields, dka 11 fields) | mixed | No fhir block, so nothing in them can be exported. Decision 28 and F4 settle this; not needed before AA7. |
| fever_thr, fever_thr_unit, tgt_low, tgt_high (meta) | - | Clinician-typed display lines, not data. Stay off. |
| io_note, ins_note | text | Free notes. Leave off unless a slot needs them. |

**Flag (decide before F4):** a1c_target has fhir Observation / valueQuantity but is a clinician-typed target, not a reading. As it stands it would export as an Observation. Suggest removing its fhir block.

## 3. Registration demographics really captured (patients.js, 005_patients.sql)

| Captured | Notes |
|---|---|
| MRN, name, sex, date of birth, phone, national id | Columns in PCOLS. Phone and national id are never exported. |
| Date of birth with age_estimated flag | An estimated age is stored as a birth date; the export gives the year only. |
| Race, ethnicity, gender identity | Not captured: the grep found no such field (gender appears only as the FHIR key for sex). |
| Ward and bed | Live on the encounter record (decision 15); not in this grep. |

For F6 the registration provides list is therefore: sex (as gender) and birth date (year only when estimated). MRN, name, phone and national id are identifiers, not elements.

## 4. Gaps in table 6.4 found by this inventory (for F1 and F2)

Table 6.4 maps only four set field types to roles. Four types used in the seed sets are not in it:

| # | Field type | Seed fields | Proposed mapping (needs your OK) |
|---|---|---|---|
| 1 | date | a1c_date, a1c_due | role time (FHIR dateTime allows date precision) |
| 2 | integer | vials, gcs, fl | role quantity, unit as typed |
| 3 | boolean | neuro, rxn, edema | no role yet. Either add a mapping to category or leave out of elements until a disease set is made exportable (decision 28) |
| 4 | duration_min | gap (in both disease sets) | derived by the app, not recorded: do not project. Mark derived fields as never elements |
| 5 | number with unitField (per-row unit) | fever_chart temp | unit differs by row, so matching on the unit string needs the row's unit. Say how to handle it in F2: take the unit from the row, or treat the element as unit varies |

Mappings 1 and 2 only extend the type-to-role column; they add no new role, so decision 25 (new role needs informatician proposal and admin approval) is not triggered. Do record them in ELEMENTS.md (F1).

## Code binding tables (from api.js)

code_bindings (set_id, field_id, system, code, display); verified_codes (system, code, display, verified_live). These are the row shapes F2 takes.
