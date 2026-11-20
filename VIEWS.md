# VIEWS.md: how EMR screens are described as data

Every EMR screen is a registered view, section or surface type plus data. Code never names a clinical set, field or option. View data holds ids, labels and display windows only: no doses, thresholds, bands or rules.

## Layers

| Layer | What it is | Status |
|---|---|---|
| Sets | Fields, repeat groups, units (`care.vitals`, `care.intake_output`) | unchanged |
| View blocks | Optional declarative blocks inside a set: how its rows are shown | `view.type` flowsheet / fever / dailygrid exist; new optional keys added in Phase V and 7 |
| EMR view pathways | A pathway (`kind:'pathway'`, `contexts:['emr']`) with a `surface` (where it appears) and optional `sections` (what it lists) | new |

## View block keys

All keys refer to field ids declared in the same set.

| Key | Does | First used by |
|---|---|---|
| `summary:[{type:'sumBy', timeField, keyField, valueField, windowsHours, label}]` | plain sum of entered rows per key in a window; never compared to anything | I/O (V4) |
| `board:{show:'latest'}` | what a ward-board cell shows (default latest value and its age) | V5 |
| `banner:{chipField}` | active (not entered-in-error) values as a chip in the patient banner | allergies (49) |
| `statusboard:{statusField, groups:[{label, values}]}` | read-only grouping of rows by status | orders (48) |
| `actions:[{label, field, to, reasonField?, reasonRequired?}]` | one-click row patch of one field, through the existing row route | orders (48) |
| `crosscheck:{against:{setId, field}, textField, message}` | non-blocking note when two typed texts match | MAR (49) |
| `drives:{...}` | informational only, see decision 15 | ADT (50) |

## Surface types (closed list)

Adding one means a generic renderer plus a test.

| Surface | Where | Sections / content |
|---|---|---|
| `case_tab` | an extra tab in a patient's chart | `sections[]` |
| `patients_columns` | columns on the Patients ward board | members, or `columnsFrom:'pinned'` |
| `patients_panel` | a panel on the Patients screen | one member set with an `upcoming` view |
| `banner_chips` | chips in the patient banner | members with a `banner` block |
| `export_section` | a sub-view in Export | sections for the charge summary |

## Section types for `case_tab`

`narrative`, `activePathways`, `latestValues` (scope applied), `ackedAlerts` (hours), `newRows` (since `lastHandover`), `setTable` (a member set as a table), `statusboard`, `linkedgrid` (MAR).

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

- **E1.** Code (`enhancer.html`, `store.js`, `api.js`) never names a clinical set id, field id or option text. Only seed data and tests do.
- **E2.** Every screen is a registered view, section or surface type plus data.
- **E3.** A new type needs one pure function, a test that uses a **made-up set** (proves it is generic), a validator entry, and one line in this file.
- **E4.** View data holds ids, labels and display windows only. No doses, thresholds, bands or rules. Pathways stay `rules:[]` in seed.
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
