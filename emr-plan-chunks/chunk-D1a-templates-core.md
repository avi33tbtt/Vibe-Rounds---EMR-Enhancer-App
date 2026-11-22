# Chunk D1a-templates-core: Analytics template contract and first three templates

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9)._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis/schemas/analytics-package.schema.json`; reference template; Ch8 section 2.

**Build:**
1. Add `ccis/templates/` with a template contract (purpose, population, required/optional inputs, terminology bindings, units, time semantics, missingness rules, output schema, evidence refs, contraindications, version, fixtures).
2. Build and fully test: threshold interpretation, trend detection (slope over a window), score calculation (transparent weighted sum). Parameters, bands and weights arrive disabled and are supplied by a local clinician; nothing from a model.
3. Each template ships fixtures for normal, boundary, missing, conflicting, out-of-scope, unit-conversion.

**Done when:** three templates validate, run and match independently calculated fixtures.

**Size guard:** 3 templates, each under about 150 lines of JSON + fixtures.
