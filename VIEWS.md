# VIEWS.md: how EMR screens are described as data

Every EMR screen is a registered view, section or surface type plus data. Code never names a clinical set, field or option. View data holds ids, labels and display windows only: no doses, thresholds, bands or rules.

## Layers

| Layer | What it is | Status |
|---|---|---|
| Sets | Fields, repeat groups, units (`care.vitals`, `care.intake_output`) | unchanged |
| View blocks | Optional declarative blocks inside a set: how its rows are shown | `view.type` flowsheet / fever / dailygrid exist; new optional keys added in Phase V and 7 |
| EMR view pathways | A pathway (`kind:'pathway'`, `contexts:['emr']`) with a `surface` (where it appears) and optional `sections` (what it lists). Seed: `pathway.emr.ward_board`, `pathway.emr.handover`. An admin switches them on or off in Settings (`GET`/`PUT /emr-views`, see API.md) | built (Phase V) |

## View block keys

All keys refer to field ids declared in the same set. The closed list is `VIEW_KEYS` in `views.js`; `validateView` refuses an unknown key, an unknown `type`, any key named eval, function, threshold, band, dose, limit, target or default, and any `*Field` key (or `extra` entry) that is not a field of the set.

**View types (`view.type`):** `flowsheet`, `fever`, `dailygrid`.

**Keys used by those types:** `type`, `timeField`, `tempField`, `unitField`, `thresholdField`, `thresholdUnitField`, `extra` (field ids), `slotField`, `glucoseField`, `doseField`, `byField`, `slots`. (`thresholdField` and `doseField` name a field where a clinician types a value; the view never holds a number.)

**Display keys added in V8d (all optional, all display or export only; ids and labels, never values):**

| Key | Does |
|---|---|
| `methodField` (fever view) | the field whose value becomes the method text of the temperature reading in FHIR export (that field is not exported on its own) |
| `targetLowField`, `targetHighField` (dailygrid view) | fields where the clinician types the display band; the band is drawn only when both are typed. Shown as typed, never judged |
| `echo:{setId, label}` (dailygrid view) | a note that points to the card of another set; both parts are required text |
| `extra:[field ids]` (fever view) | the first listed field is drawn as a second series |

**Blocks added in Phase V and later:**

| Key | Does | Status |
|---|---|---|
| `summary:[{type:'sumBy', timeField, keyField, valueField, windowsHours, label}]` | plain sum of entered rows per key in a window (up to 8 windows, positive whole hours); never compared to anything. `timeField` must be a datetime, `valueField` a number or integer, `keyField` text or select. Removing the key leaves the set usable. | built (V4, validated) |
| `board:{show, fields?}` | what a ward-board cell shows: `show` `'latest'` (default, latest value and its age) or `'age'` (age only); optional `fields` keeps only those field ids. The "No reading for N min" text still comes only from an approved rule. | built (V5c, validated in V8b: only the keys `show` and `fields`; `show` in the closed list; `fields` a non-empty list of field ids of the set) |
| `banner:{chipField}` | active (not entered-in-error) values as a chip in the patient banner | allowed key, not built (allergies, 49) |
| `statusboard:{statusField, groups:[{label, values}]}` | read-only grouping of rows by status | allowed key, not built (orders, 48) |
| `actions:[{label, field, to, reasonField?, reasonRequired?}]` | one-click row patch of one field, through the existing row route | allowed key, not built (orders, 48) |
| `crosscheck:{against:{setId, field}, textField, message}` | non-blocking note when two typed texts match | allowed key, not built (MAR, 49) |
| `drives:{...}` | informational only, see decision 15 | allowed key, not built (ADT, 50) |

**Pure helpers in `views.js`:** `validateView`, `validatePathwayViews`, `fieldsById`, `rowsInWindow(rows, timeField, fromMs, toMs)` (skips entered-in-error rows and unreadable times), `sumBy(rows, spec, fromMs, toMs)`; coding helpers `validateCoding`, `validateSetCoding`, `codingAllow` (see CODING.md).

## Field and set flags (V8d)

| Where | Flag | Does |
|---|---|---|
| field | `pair:{with, code, short}` | this field and the field `with` (same group) are one paired reading: joined in flowsheet lines, text lines and FHIR export as one reading. `code` is the export text, `short` the short label in text lines. Validated by `validateView` (even when the set has no `view`) |
| field (date) | `followUp:{label, history?:{group, valueField, dateField}}` | this date field is the "next due" date of a follow-up: it gets the due badge in the case, the due label in the patient list (`label` + days) and, with `history`, a "days since last reading" line in Care pathway analytics from the named repeat group. One per set. Validated by `validateView` (date field, not repeat; `history` fields in the same group, a number and a date). Display only; no target or interval |
| set | `quick.order` | order in the quick-add and pin lists |
| set | `quick.summary` | shown as a quick-add button on Summary |
| set | `quick.suggest` | position in the Demo-mode default suggestion list (lowest first) |
| set | `starter:true` | the set used by "new note from template" |
| set | `demoCases:true` | the set the Demo-mode sample cases are made for |

## Surface types (closed list)

Adding one means a generic renderer plus a test. The closed list is `SURFACE_TYPES` in `views.js`; an unknown type is refused when the pathway is seeded or saved.

| Surface | Where | Sections / content |
|---|---|---|
| `case_tab` | an extra tab in a patient's chart, after the fixed tabs. Needs `id` (lowercase letters, digits, `_` or `-`, up to 24, not already used on the page) and `label`; `print: true` marks a print layout. Built from `emrSurfaces('case_tab')`, so the tab is absent when its pathway is switched off | `sections[]` |
| `patients_columns` | columns on the Patients ward board | members, or `columnsFrom:'pinned'` |
| `patients_panel` | a panel on the Patients screen | one member set with an `upcoming` view |
| `banner_chips` | chips in the patient banner | members with a `banner` block |
| `export_section` | a sub-view in Export | sections for the charge summary |

## Section types for `case_tab`

The closed list is `SECTION_TYPES` in `views.js`. Built (V6): `narrative`, `activePathways`, `latestValues` (scope applied), `ackedAlerts` (`hours`, a positive whole number; 24 if absent), `newRows` (`since: 'lastHandover'`; otherwise every stamped row). Sections are drawn in the listed order; an unknown type is skipped by the screen and refused by the validator. A section may also carry `windowsHours` (up to 8 positive whole numbers). Allowed but not built: `setTable` (a member set as a table), `statusboard`, `linkedgrid` (MAR). The `scope` value is not read by any code yet.

## Worked examples (data only, no clinical values)

```json
{"setId":"care.intake_output", "view":{"type":"flowsheet","timeField":"io_time",
 "summary":[{"type":"sumBy","timeField":"io_time","keyField":"io_type","valueField":"io_volume",
             "windowsHours":[8,12,24],"label":"sum of entered rows"}]}}

{"setId":"pathway.emr.ward_board","kind":"pathway","contexts":["emr"],"members":[],"rules":[],
 "surface":{"type":"patients_columns","columnsFrom":"pinned"}}

{"setId":"pathway.emr.handover","kind":"pathway","contexts":["emr"],"members":[],"rules":[],
 "surface":{"type":"case_tab","id":"ho","label":"Handover","print":true},
 "sections":[{"type":"narrative"},{"type":"activePathways"},{"type":"latestValues","scope":"applied"},
             {"type":"ackedAlerts","hours":24},{"type":"newRows","since":"lastHandover"}]}
```

## Engine rules

- **E1.** Code (`enhancer.html`, `store.js`, `api.js`) never names a clinical set id, field id or option text. Only seed data and tests do. `no-handcode.test.js` enforces it by scanning the code for every seed set and field id; ids of EMR view pathways (configuration names) are exempt. Its ALLOW list holds the hand-coded lines still to be moved into data (tasks V8d1 to V8d8; all done, it is now empty); it may only shrink and must be empty at the Phase V gate.
- **E2.** Every screen is a registered view, section or surface type plus data.
- **E3.** A new type needs one pure function, a test that uses a **made-up set** (proves it is generic), a validator entry, and one line in this file.
- **E4.** View data holds ids, labels and display windows only. No doses, thresholds, bands or rules. Pathways stay `rules:[]` in seed. `views-safety.test.js` checks this on every seed view, surface and section.
- **E5.** View pathways are ordinary content: versioned, tiered, forkable, read-only when from the marketplace.
- **E6.** Viewing writes nothing. Writes use the existing row routes with the existing permissions, versions (409) and audit.
- **E7.** The fixed frame stays fixed: patient banner, Summary, Flowsheets, Notes, Pathway, Alerts, Export, Settings and Tools. Safety-critical screens (alerts, notes signing, audit) are not data-driven.
- **E8.** Every element (set, view pathway, order set, analytic) starts with an `access` block. No block, no seed, no install.
- **E9.** The EMR contains no analytics. Analytic definitions, engine and screens live only in the Analytics app. `elements.js` names no seed ids.

## Access block (every element starts here)

Before anything is built or installed, write down who may do what with it. The server enforces it; the screen only mirrors it. Every element (set, view pathway, order set, analytic) carries an `access` block: for each action, a list of roles.

| Action | Meaning |
|---|---|
| `view` | see its data or its output |
| `enter` | add rows or values |
| `amend` | correct a row (own or others', stated per element) |
| `approve` | approve, verify, enable or sign what it contains |
| `configure` | edit its definition, install it, switch it on or off |
| `export` | take its data out of the system (CSV, FHIR, de-identified) |

```json
"access":{"view":["viewer","nurse","doctor","informatician","admin"],
          "enter":["nurse","doctor"],"amend":["doctor"],
          "approve":["doctor"],"configure":["admin"],"export":["informatician","admin"]}
```

Rules:

- Roles come only from the role table in `permissions.js` (viewer, nurse, doctor, informatician, admin). A new role is a decision, not a side effect.
- **Default deny.** An element with no `access` block is refused by lint, seed and install. A missing action means no role has it.
- **Narrow, never widen.** An element can only restrict what a role already has in `permissions.js`. It cannot give a viewer the right to enter.
- Every route checks it on the server, with the normal version check (409) and audit row. Hidden buttons are only a mirror.
- Changing an element's access is audited (who, before, after) and, for reviewed content, creates a new version.
- Marketplace packages carry a suggested `access`; the admin confirms or narrows it at install and the narrowest result is stored.
- Tested as a matrix: every element, every action, every role, generated from the data.

## How to add a new type

**Step 0: write the access block first** (see "Access block" above). Nothing else is built until it is written down.

1. **Pure function.** Write the function that does the work (for example `sumBy`) in `views.js`, with no DOM and no set ids.
2. **Made-up-set test.** Add a test that uses a made-up set, not a seed set, to prove it is generic.
3. **Validator entry.** Add the new key or type to `validateView` or `validatePathwayViews`, including its error cases.
4. **Doc line.** Add one line to the matching table in this file.
