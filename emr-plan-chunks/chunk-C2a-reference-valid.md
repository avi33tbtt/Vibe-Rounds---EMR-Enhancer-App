# Chunk C2a-reference-valid: Reference artefacts (valid) and synthetic fixtures

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 1. Needs: C1c._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis/SPEC.md`; schemas; C0 use case.

**Build:**
1. Under `ccis/examples/`: one contextual element (snake envenomation timing fields with typed fields, verified-only bindings, provenance), one pathway with two decision nodes and an explicit indeterminate branch, one reusable analytics template (a transparent interval/threshold calculation with parameters that arrive disabled).
2. Under `ccis/fixtures/`: synthetic patient contexts (normal, boundary, missing, conflicting, out-of-scope, unit-conversion), each with an independently hand-calculated expected result recorded beside it.
3. Test: every valid example validates against its schema.

**Done when:** valid examples and fixtures exist and validate.

**Size guard:** JSON files only plus 1 test. Keep each file small.
