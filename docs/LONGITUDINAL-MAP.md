# Longitudinal explorer: source-to-timeline map (task R9a)

_Docs only. Written 2026-11-26 from the refreshed repo (after R3h). Synthetic data only; not for clinical use. Nothing here changes code, schema or the envelope (context impact: none)._

## 1. What exists today

`GET /api/patients/:id/timeline` (R3g, `patient-timeline.js`, permission `cases:read`) already merges one patient's records across all their cases. The R3h page (`modules/79-timeline.js`) shows it. R9 **reuses this route** and adds to it; it does not add a second timeline.

| Timeline kind | Source table(s) | Route sends | Time used as `at` | Effective time | Recorded time | Status values | Case link |
|---|---|---|---|---|---|---|---|
| `observation` | `observations` (append-only, 011) | `fieldKey`, `valueType`, `value`, `unit`, `appliedSetId`, `sourceType`, `correctsId`, `by` | `effective_at` | `effective_at` | `recorded_at` | `entered_in_error` plus others (see 011) | `case_id` |
| `note` | `case_notes` (012), signed only | `encounterId`, `by` (no text) | `signed_at` | `signed_at` | `created_at` | `signed` | `case_id` |
| `problem` | `patient_problems` (018) | `label`, `by` | `recorded_at` | `onset_date` (date) | `recorded_at` | `active`, `resolved`, `entered_in_error` | `origin_case_id` (may be null) |
| `allergy` | `patient_allergies` (019) | `label` (substance) | `recorded_at` | `onset_date` | `recorded_at` | same idea | `origin_case_id` |
| `medication` | `patient_medications` (020), recorded list only, no orders | `label` | `recorded_at` | `start_date` | `recorded_at` | `active`, `stopped`, `entered_in_error` | `origin_case_id` |

Route features already there: `from`/`to` window, `limit` (max 500) / `offset`, `includeErrors`, `hiddenInError` count, `truncated` flag at 5000 rows per source, one audit row (`patient.timeline_view`). Same-time order: time, then kind, then source id.

## 2. Event kinds the chunk wants that have NO source yet

Listed, not invented (chunk rule):

- **Encounter events** (`case_encounters`, 006, and `clinical_events.encounter_id`): the table exists but the timeline route does not read it. Needs a small addition in R9b/R9e if wanted. Decision for R9b: include encounter start/end as kind `encounter` only if one query on `case_encounters` is enough; otherwise leave it out and list it as deferred.
- **Note amendments** (`case_note_amendments`, 012): exist, not in the route. Same treatment: add as kind `note_amendment` (no text, reason not sent) or defer.
- **Applied set / pathway events** (`clinical_events` event types `set_applied`, `set_upgraded`, `set_withdrawn`, plus `case_applied_pathways`): exist, not in the route. Good for "context milestones". Add as kind `context_change` in R9b, ids and titles only.
- **Orders, results, IPD events**: no source until R4/R5. Not added.
- **Cases themselves** (`clinical_cases`, opened/archived): not in the route; optional.

## 3. Where context membership comes from (diabetes, CKD, hypertension)

There is **no stored condition code on observations**. Membership must be derived from explicit links, in this order of strength:

| Source of membership | How it is explicit | Gives context for |
|---|---|---|
| Applied set pin (`case_applied_sets` -> `element_sets.slug`) | An observation carries `applied_set_id`; the pin names the set slug | Any observation recorded under that set |
| Pathway source (`case_applied_pathways`, pins with `from_pathway_version_id`) | A pin created from a pathway links back to its pathway version | Same observations, plus the pathway name as the reason |
| Problem list (`patient_problems.label`, `local_term_code`) | Clinician-entered problem | The problem event itself; an observation is NOT assigned to a problem by this |
| Mapping table (new, small, reviewed) | Slug -> context key | The only place that says "this set belongs to diabetes" |

**Current demo set slugs** (in `emr-enhancer.html` demo data, imported as published v1): `dm_ctx`, `hba1c_mon`, `glucose_ss`, `foot_ulcer`, `dka_ctx` (diabetes side); `ckd_ctx`, `urine_io` (kidney side; `urine_io` is fluid balance, used in the DM+CKD pathway, so it is NOT mapped to CKD by default); `vitals` (shared, maps to no single condition). Pathways: `pw_dm`, `pw_dm_ckd_foot`, `pw_dka`.
**Hypertension: no set or pathway exists.** R9d must add one through review (open question in the tracker).

## 4. Proposed mapping (decision for R9a, owner may change)

**Home: a small code module `context-map.js` (plain data, in the repo), not a database table.** Reasons: reviewed by pull request, no migration, no new write route, same content for tests and seed. Move to a table only if a clinician-editable mapping is later wanted (then it needs the review workflow).

Shape (data only):

```
context key  ->  { label, setSlugs[], pathwaySlugs[], problemTerms[] }
diabetes     ->  dm_ctx, hba1c_mon, glucose_ss, foot_ulcer, dka_ctx ; pw_dm, pw_dm_ckd_foot, pw_dka
ckd          ->  ckd_ctx ; pw_dm_ckd_foot
hypertension ->  htn_ctx ; pw_dm_ckd_htn   (added in R9d-1; pw_dm_ckd_htn also listed under diabetes and ckd)
```

Rules for R9c:
1. An event belongs to a context when its set slug (via `appliedSetId`) is listed. Reason stored per membership: `set:<slug>` or `pathway:<slug>`.
2. A pathway lists the contexts it implies, but only the **sets** of that pathway give observation membership. A pathway name alone never moves an observation into a context.
3. Problems, allergies, medications and notes get context only by an exact, listed `problemTerms` match on `label` (case-insensitive, whole label) or by their case having an active pin of a listed set. If neither, the event is `unmapped`.
4. One source record can sit in several contexts; the combined view dedupes by `kind + sourceId`.
5. No free-text guessing, no NLP, no AI. Terms are the clinician's own words, listed by hand.
6. `vitals` and other shared sets map to nothing: shown in "All", label "no single condition".

## 5. Gaps found that affect later rows

1. **Applied set slug is not in the timeline response.** Events carry `appliedSetId` (pin id), not the slug. R9c/R9e need the slug (join `case_applied_sets` -> `element_sets`). Add it in R9e as `setSlug`, ids and slug only.
2. **Field ids clash across sets** (B0 finding): always key a lane by set slug + field key, never field key alone.
3. **`at` mixes meanings**: effective time for observations and notes, recorded time for lists. Keep both fields in every event; the date axis for R9 should use `at` as today and always show the other time in the drawer.
4. **Problems and meds have only a date for effective time** (no clock), so same-day order is by `at` (recorded time). Show the date only; no invented clock time.
5. **Timeline route reads up to 5000 rows per source then cuts**: fine for synthetic 3 to 5 years, `truncated` stays visible.
6. **No "as known then" cut-off** exists in the route; R9j would add a `recordedBefore` filter on `recorded_at` (all five sources have it). Optional.
7. **No patient-level encounter list in the timeline**; see section 2.

## 6. Effects on the next rows

| Row | Consequence of this map |
|---|---|
| R9b | Pure `timeline-projection.js` takes the route's existing events; adds kinds `encounter`, `note_amendment`, `context_change` only if their query fits; otherwise lists them as deferred. |
| R9c | Uses `context-map.js` (section 4). Needs `setSlug` on events (gap 1). |
| R9d | Needs a hypertension set and pathway through review; may split. |
| R9e | Extends `patient-timeline.js` (context filter, `setSlug`, optional `recordedBefore`); permission stays `cases:read`; matrix and audit tests updated on purpose. |
| R9f to R9h | Extend `modules/79-timeline.js` or a sibling module; keep SYNTHETIC banner. |

## 7. Open decisions for you

1. Accept a code module `context-map.js` as the mapping home (default) or want a reviewed table instead.
2. Add hypertension demo set/pathway (R9d) through review: yes/no.
3. Include encounters and note amendments in the explorer: default yes if the query is cheap (R9b decides).
