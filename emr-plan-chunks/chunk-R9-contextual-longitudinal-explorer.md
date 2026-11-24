# Chunk R9 — Contextual Longitudinal Patient Explorer

_Status: planned / LOCKED. Patient-level feature for EMR Enhancer. Synthetic data only; not for clinical use._

## Purpose

Build an interactive way to review one patient's longitudinal clinical record. The clinician should be able to move from the overall patient journey into disease-specific and combined-condition timelines, click an event, inspect its evidence and navigate to related context without losing the selected date.

**This belongs in EMR Enhancer.** It is a patient-record review and navigation feature. CCIS is a separate product and will receive a different cohort-level feature (see the CCIS plan).

## Repository grounding and existing foundations

Repository inspection on 2026-11-23 found these foundations:

- `CLINICAL_CONTEXT_MODEL.md`: a case belongs to a patient and can span encounters; observations are append-only; `effective_at` and `recorded_at` are distinct; cases pin exact element-set and pathway versions.
- B3a/B3b: server-backed observations, repeat observations/trajectories, clinical events, correction and entered-in-error handling; timeline retrieval already exists at case level.
- B3c: server-backed notes and amendments.
- B4a/B4b: immutable pathway versions and pathway composition on a case.
- B5a/B5b: context envelope builder and export.
- R3 in `EMR_TASK_TRACKER.md`: planned cross-case longitudinal record (problems, allergies, medication history, results and encounter timeline).
- R0: split the large `emr-enhancer.html` before adding substantial screens.

Do not recreate these capabilities. First inspect the refreshed repository's actual routes, adapter, migrations and page implementations. Reuse server-owned records and source identifiers.

## Product boundary

- One patient at a time; the patient record remains the source of truth.
- This is not the CCIS cohort explorer and must not implement cohort membership, cohort aggregation or population analytics.
- Do not create a second copy of observations for each disease timeline.
- No new clinical decision support, recommendations, thresholds or causal claims.
- Keep the existing synthetic-data-only and not-for-clinical-use banners.

## MVP experience

Create a **Longitudinal** area within the patient record (or the most appropriate existing patient/case navigation location, decided after inspecting the refactored page).

### A. Overall patient timeline

Show a chronological stream of significant available records, initially limited to data already supported by the EMR:

- Diagnoses/conditions only where already represented in the current model or the R3 implementation.
- Observations and repeated measurements.
- Case/encounter events.
- Notes and note amendments where appropriate.
- Applied pathway/set events and documented changes.

Do not fabricate medication, allergy, order or result event types before their owning EMR workstreams implement them. Add those types later when their source records exist.

### B. Context views

Provide simple context filters/views:

- All patient history.
- One condition/context (e.g. diabetes).
- Another condition/context (e.g. CKD).
- Combined context (e.g. diabetes + CKD).
- Optional third context (e.g. hypertension) if synthetic data and existing sets support it.

These views are projections over the same source records. A source observation may appear in more than one relevant view, but it remains one record with one identity and provenance.

For the MVP, use existing case/pathway/set membership and explicit, inspectable mappings. Do not introduce fuzzy NLP inference or a new ontology engine. If a record's contextual membership cannot be established, show it in the overall timeline and label its context as unknown/unmapped rather than guessing.

### C. Synchronized time navigation

All visible tracks use one shared date range and selected-date anchor.

- Selecting an event on any track selects that event and date.
- Other visible tracks scroll/highlight the same date where possible.
- Switching context preserves the selected date and date range.
- Basic date-range controls are sufficient.

A single combined timeline with condition lanes is acceptable for the first release. Do not build a complex graph canvas.

### D. Clickable event detail

Clicking an event opens a side panel or detail drawer showing:

- Event/result label and value, with unit where applicable.
- Effective time and recorded time separately.
- Status, including entered-in-error/corrected states.
- Source record reference and a direct route back to the original observation, note or encounter.
- Author/actor and provenance available from the source.
- Relevant condition/context memberships and why the item appears in this view.
- Previous/next observations for the same field when available.

The panel must distinguish source facts from derived labels. It must never imply that temporal proximity proves causation.

### E. Basic longitudinal trends

For repeatable numeric observations, allow a simple trend chart with event markers. Reuse the existing trajectory query and field metadata. Keep units explicit; do not combine incompatible units or unverified codings. Missing/unknown/entered-in-error values must not be plotted as zero.

Trend charts are MVP+ if they exceed the size guard; split them into a follow-up row rather than delaying the usable timeline.

## Data and query approach

1. Reuse patient -> cases -> encounters, applied set/pathway pins, observations, clinical events and notes.
2. Use a common **read-model projection** for display; it references source rows and does not become a new system of record.
3. Include stable source identity, patient/case/encounter reference, event kind, effective time, recorded time, status, display metadata and context references in the projection.
4. Resolve condition/context membership from explicit source relationships, pathway/set membership or an approved mapping table. Keep the reason/provenance for each membership.
5. Query by patient and date range on the server; do not load the entire database into the browser.
6. Do not add an event table that duplicates existing observations, notes or clinical events. Add indexes or a materialized/read projection only if measured query performance requires it.
7. Preserve the distinction between clinical effective time and record availability time. A historical "as known then" view must not expose records recorded after the selected knowledge-time cutoff.

Any new envelope-visible data must state the context impact. This initial explorer should consume the existing envelope and existing data. If R3 adds new envelope sections, coordinate the exact schema version with CCIS before implementation.

## Synthetic demonstration data

Add a deterministic, idempotent synthetic longitudinal demo seed (separate from the existing small end-to-end CCIS demo seed):

- One clearly synthetic patient with one longitudinal case spanning multiple encounters.
- Three contexts: diabetes, CKD and hypertension, using existing approved/demo element sets and pathways where available.
- Approximately 3–5 years of dated events.
- Repeated HbA1c/glucose, creatinine/eGFR, urine albumin and blood-pressure observations with realistic-looking but explicitly illustrative values.
- Several documented diagnosis/context milestones and encounter/note events.
- Add medication-related events only if a medication source model exists at implementation time; otherwise omit them rather than inventing a parallel medication table.
- Include missing/unknown values and one entered-in-error/corrected observation to exercise provenance and temporal behavior.
- Seed/reset commands must be repeatable and must not overwrite or delete ordinary user data. Use a dedicated synthetic patient/case marker and safe archive/reset semantics.

Every screen and fixture must say **SYNTHETIC DEMO DATA — NOT FOR CLINICAL USE**. Values are illustrative, not clinical thresholds or recommendations.

## Build sequence

### R9.1 — Inspect and map existing records
- Refresh repo.
- Read R0/R3 plan chunks and inspect current patient/case, observation, event, note and pathway routes.
- Produce a concise source-to-timeline mapping in task notes.
- Identify which R3 record types are available; do not invent absent source tables.

### R9.2 — Define the timeline projection and query contract
- Define supported event kinds and source references.
- Add focused tests for event ordering, same-time events, missing timestamps, status and source identity.
- Ensure effective time and recorded time remain separate.
- Prefer a small pure mapper over a new persistence model.

### R9.3 — Overall patient timeline
- Add a patient-level timeline query across the patient's cases/encounters.
- Reuse server routes/adapters and permissions/audit conventions.
- Add a basic chronological UI grouped by date/year.
- Add source links and pagination/date-window behavior.

### R9.4 — Context filters and combined views
- Add single-context and multi-context filters.
- Reuse explicit pathway/set/context references.
- Deduplicate by source identity in the combined view.
- Keep unmapped events visible in the overall view.

### R9.5 — Click-through detail and synchronized date
- Add detail drawer and source navigation.
- Synchronize the selected date across visible lanes.
- Preserve date/context when switching views.

### R9.6 — Synthetic longitudinal demo seed and reset
- Add deterministic synthetic multi-year data.
- Verify idempotency and safe reset/archive behavior.
- Keep this separate from the existing DM1/DM4 EMR-to-CCIS demo data.

### R9.7 — Trend charts (only if still within scope)
- Add simple charts for supported repeated numeric observations.
- Add unit and missingness safeguards.
- Otherwise split to R9.7a and leave the MVP timeline complete.

### R9.8 — Safety, performance and acceptance
- Route permission matrix and audit tests updated for every new route.
- No hard deletes; source rows remain immutable and traceable.
- Browser test covers timeline, context switching, click-through and synthetic banner.
- Verify patient isolation and cross-case access.
- Test historical knowledge-time behavior if implemented.
- Run the full existing suite once; do not mark DONE on unverified work.

## Acceptance criteria

- A clinician can open one synthetic patient and see a coherent multi-year timeline across the patient's cases/encounters.
- Diabetes, CKD and combined diabetes + CKD views are available from the same source records.
- Clicking an event reveals its source, effective/recorded times, status and related context.
- Selecting a date in one view keeps the same temporal anchor when switching to another view.
- The same observation is never duplicated as a new clinical fact.
- Unknown, absent, missing, corrected and entered-in-error states remain distinct.
- No unsupported causal or clinical recommendation is generated.
- Patient isolation, permissions, audit and append-only guarantees remain intact.
- Synthetic data is clearly labelled and can be seeded/reset without touching ordinary records.

## Dependencies and sequencing

- R0 (page modularization) before major UI work.
- R3 (longitudinal record foundations) before cross-case aggregation.
- R2 terminology improves semantic matching but is not required for the first MVP; use explicit local/context keys until verified terminology is available.
- R4/R5 add medication, order, result and IPD event types later; extend the projection only after those source models exist.
- DM4 and the user's "start roadmap" gate remain prerequisites for starting the advanced EMR roadmap.

## Explicitly deferred

- Patient-level graph visualization.
- AI-generated disease relationships or causal explanations.
- Automated clinical risk scores, alerts or treatment recommendations.
- FHIR-based timeline ingestion.
- Cohort analytics (belongs in CCIS).
- Full ontology-based cross-specialty inference.
