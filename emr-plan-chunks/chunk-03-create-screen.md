# Chunk 03 — Unified create screen

**Needs:** chunk 02 done.
**Goal:** one create/generate screen with two independent choices: SDC output, and code systems.
**Read only:** the create/generate screen code and the SDC import/export functions.
**Build:**
1. Checkbox "Also author as FHIR SDC Questionnaire". Questionnaire is built deterministically from the internal set; both stored together.
2. Code-system picker (SNOMED, LOINC, RxNorm, ICD, ATC, Local, None), global with per-field override and skip.
3. AI generation proposes bindings only for ticked systems; tagged `source:"llm"`; empty if unsure; same verify step.
4. Before generation in SDC mode, list what SDC cannot express here (enableWhen, calculated expressions, value-set options).
5. Move SDC code to a shared `sdc.js` so app and server use one copy.
**Done when:** same screen creates a set with and without SDC, with and without coding; uncoded set is flagged "uncoded" and still usable.
