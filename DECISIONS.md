# Decisions

## R9d-1 (2026-11-26)
| ID | Decision |
|----|----------|
| R9D1-1 | Added a hypertension demo set `htn_ctx` and a combined pathway `pw_dm_ckd_htn` (diabetes, CKD, hypertension); the pathway is also listed under diabetes and CKD in `context-map.js`. Demo content only, no thresholds or codes. |
| R9D1-2 | Urine albumin-creatinine ratio (`uacr`) lives in `ckd_ctx` and creatinine/eGFR/BP fields are `repeat:true`; the page's own `ckd_ctx` has no uacr, so the published server set differs from the page demo set. Glucose is not in this series. |
| R9D1-3 | Unknown = explicit point with no value; missing = no point (uacr, 2025-03); entered in error = one wrong sbp (190) later marked, with a separate corrected row (139). |

## R9c (2026-11-26)
| ID | Decision |
|----|----------|
| R9C-1 | Mapping and membership live together in `context-map.js` (one module, as the row's size guard allows); data stays plain and is changed by pull request. |
| R9C-2 | Problem terms (diabetes, CKD, hypertension names) were listed by me. They place a problem, allergy or medication only on a WHOLE-label match; a clinician should review the list. Hypertension has terms but no set until R9d. |
| R9C-3 | `vitals` and `urine_io` are "no single condition" (shown in All). Case pins are passed in by the caller as `{caseId: [{setSlug, pathwaySlug, active}]}`; R9e must supply them. |

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

## R9e (2026-11-27): longitudinal route

| ID | Decision |
|----|----------|
| R9E-1 | `GET /api/patients/:id/longitudinal` reuses the R3g reader (`readPatientEvents`, now exported from `patient-timeline.js`), then R9b projection and R9c membership. Observations on the old route gain `setSlug` (slug only). No second timeline, no new table, no migration. |
| R9E-2 | `counts` cover the whole window BEFORE the context filter (so every chip shows its number); `total`, `limit`, `offset` apply AFTER it. `hiddenInError` is window-wide. A stored row the projection refuses gives 422, never a guess. |
| R9E-3 | `context` is a comma list of listed keys, each once; unknown, repeated or empty-item values are 400. Pins come from `case_applied_sets` (withdrawn pins no longer place problems by case; observations keep their own set). Encounter, amendment and context-change kinds are still not sent (deferred). |
