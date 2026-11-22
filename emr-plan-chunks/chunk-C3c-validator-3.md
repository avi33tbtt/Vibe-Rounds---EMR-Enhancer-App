# Chunk C3c-validator-3: Validator layers 6–8: executable safety, test verification, governance

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 2. Needs: C3b._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis-validate.js`; `ccis/schemas/execution-manifest.schema.json`, `validation-record.schema.json`.

**Build:**
1. Layer 6: logic uses only whitelisted operators and declared inputs; no code strings; resource limits present; permissions empty by default.
2. Layer 7: run the package's own fixtures through the runtime stub (interface only until C5c) and compare to expected outputs; missing edge-case classes (boundary, missing, conflicting) are warnings.
3. Layer 8: every validation claim names the exact package version, population, setting and intended use; software conformance never implies clinical safety (separate field).
4. Add a validation report writer so reports can be stored with a package.

**Done when:** all eight layers have tests and every invalid example fails with its expected diagnostic.

**Size guard:** 1 module + tests. If layer 7 needs the runtime, ship it as a skipped test until C5c.
