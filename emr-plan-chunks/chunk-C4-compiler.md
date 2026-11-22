# Chunk C4-compiler: Compiler: canonical form, checksum and equivalence

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 3. Needs: C3c._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis-validate.js`; examples.

**Build:**
1. Write `ccis-compile.js`: normalise an artefact to canonical JSON (sorted keys, defaults filled), compute `sha256` checksum, and emit a compiled form with its source checksum.
2. Equivalence test harness: take the same artefact from three sources (hand-written JSON, a builder function, an LLM-draft fixture) and assert identical canonical form and identical validator outcome. GUI and LLM routes plug in later (D2); this row proves the contract.

**Done when:** same artefact from different routes yields the same canonical bytes and checksum.

**Size guard:** 1 module + tests.
