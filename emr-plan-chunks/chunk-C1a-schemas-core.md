# Chunk C1a-schemas-core: Schemas: package manifest, contextual element, terminology binding

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 1. Needs: C0._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis/SPEC.md`; `sdc.js` (existing field model); the code-system registry in `emr-enhancer.html` (`grep -n CODESYS`).

**Build:**
1. Add `ccis/schemas/manifest.schema.json`, `element.schema.json`, `terminology-binding.schema.json` (JSON Schema 2020-12, `$id` with version, `additionalProperties:false` on critical objects, `x-` extension keys allowed).
2. Add dev dependency Ajv (pinned exact; record the version in `DECISIONS.md`) and `ccis-schema.js` that loads and compiles schemas.
3. Tests (`test/ccis-schemas.test.js`): good fixtures pass, a missing required field, bad semver, unknown critical field and unknown system each fail.

**Done when:** three schemas compile and their tests pass.

**Size guard:** 3 schemas + 1 module + 1 test file.
