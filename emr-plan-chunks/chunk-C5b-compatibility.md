# Chunk C5b-compatibility: Runtime: compatibility resolver

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 3. Needs: C5a._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis-runtime.js`; package examples.

**Build:**
1. Write `ccis-compat.js`: given a context and a package set, report each package as compatible, partially compatible (missing optional inputs) or incompatible, with reasons (missing field, unit mismatch, unmapped code, version pin).
2. Never guess a mapping: unknown stays unknown and is reported.
3. Tests: all fixture classes.

**Done when:** compatibility reports match expected for every fixture.

**Size guard:** 1 module + tests.
