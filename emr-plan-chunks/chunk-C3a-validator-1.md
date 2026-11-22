# Chunk C3a-validator-1: Validator layers 1–3: syntax, structure, reference integrity

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 2. Needs: C2b._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis-schema.js`; `ccis/schemas/`; invalid examples for layers 1–3.

**Build:**
1. Write `ccis-validate.js` (library + CLI `node ccis-validate.js <file>`): returns `{valid, diagnostics[]}` where each diagnostic has `severity`, `ruleId` (CCIS-V-nnn, stable), `path` (JSON pointer), `message`, `hint`.
2. Layer 1 syntax/encoding; layer 2 structure by schema and declared version; layer 3 reference integrity (elements, nodes, terminology sets, dependencies resolve within a package set).
3. Tests compare diagnostics to `expected-diagnostics.json`.

**Done when:** layers 1–3 pass the valid examples and produce the expected diagnostics for the invalid ones.

**Size guard:** 1 module + CLI + test file.
