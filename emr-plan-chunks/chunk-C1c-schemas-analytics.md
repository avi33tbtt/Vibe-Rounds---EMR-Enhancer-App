# Chunk C1c-schemas-analytics: Schemas: analytics package, execution manifest, validation record, run result

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 1. Needs: C1b._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis/SPEC.md`; Ch8 section 8 (analytics package contract) text supplied by the user.

**Build:**
1. Add `analytics-package.schema.json` (intent, population, input bindings, cohort rules ref, logic as a whitelisted expression tree, outputs, units, evidence, tests, limitations), `execution-manifest.schema.json` (declared inputs, permissions none-by-default, resource limits), `validation-record.schema.json` (names exact version, population, setting, intended use) and `run-result.schema.json`.
2. Logic is data (expression tree), never code strings. Tests as before.

**Done when:** all eight schemas compile and are versioned together as CCIS 0.1.

**Size guard:** 4 schemas + tests.
