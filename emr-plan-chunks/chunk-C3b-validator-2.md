# Chunk C3b-validator-2: Validator layers 4–5: semantic and graph/compatibility

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 2. Needs: C3a._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis-validate.js`; `ccis/examples/`; the unit table in `sdc.js`.

**Build:**
1. Layer 4: units, value types, time semantics (effective vs recorded), cardinality, terminology coherence; unverified or unmapped codes flagged explicitly, never assumed.
2. Layer 5: pathway traversability, no dead-end or dangling branch, cycles bounded, every decision node has an explicit `indeterminate` route, analytics requirements compatible with declared contexts.
3. Tests per rule ID.

**Done when:** semantic and graph invalid examples produce their expected diagnostics.

**Size guard:** 1 module (`ccis-rules-semantic.js`) + tests.
