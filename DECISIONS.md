# Decisions

## R6f-3 (2026-11-26)
| ID | Decision |
|----|----------|
| R6F3-1 | New tab **Import** (`navBundles`, shown only with `import:write`), module `modules/89-bundles.js`. "Pick the patient chart" = the chart that is OPEN in the Case tab: no second patient picker, nothing matched from the file; every accept button and confirm box names that chart (name and MRN). Say if you want an explicit picker instead. |
| R6F3-2 | An Observation is accepted into the open case by choosing one applied set + field of that case from a list (derived fields never offered). A Condition or Allergy needs only a registered patient's chart; the open case is sent as `originCaseId` when there is one. |
| R6F3-3 | The read route returns no accepter or accept time, so an accepted proposal shows only "Accepted into a chart. Final." Server unchanged; add the columns to the read route in a later row if wanted. |

## R6f-2b (2026-11-26)
| ID | Decision |
|----|----------|
| R6F2B-1 | "Chart" is the case: the person names `caseId`, `appliedSetId` and `fieldKey`; nothing is matched from the imported label. The patient on the proposal is taken from that case. The server needs an applied set and a field to store a value, so the field is always a person's choice. |
| R6F2B-2 | Units are never assumed or converted: a unit-bearing field refuses a value with no unit or another unit. A whole `number` fits an integer field (shapeValue refuses a fraction); text fits text or select; unknown fits any field. |
| R6F2B-3 | Accept needs `import:write` AND `cases:write` (admin and doctor hold both). It records `source_ref = import:<bundle>/<key>` (no content), leaves a normal `observation.record` audit row plus `import.proposal_accept`, and adds the usual timeline event. |

## R6f-2c (2026-11-26)
| ID | Decision |
|----|----------|
| R6F2C-1 | New route `POST /api/import/proposals/:id/accept-to-patient` (body: `rowVersion`, `patientId`, optional `originCaseId`). Problems and allergies belong to the patient, so the chart is the patient the person names; the 2b `accept` route is unchanged and points other kinds here. |
| R6F2C-2 | Needs `import:write` AND the kind's own permission (`problems:write` for Condition, `allergies:write` for AllergyIntolerance), checked after the proposal's kind is known; a denial is audited like any other. MedicationRequest is refused by both routes. |
| R6F2C-3 | The existing label, date, reaction and severity rules are reused (exported from problems.js and allergies.js). The record starts active even when the source said otherwise (the parser warned); a person resolves it afterwards with a reason. |
