# Chunk C5c-executor: Runtime: constrained deterministic executor and decision path

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 3. Needs: C5b._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis-runtime.js`; `ccis/schemas/analytics-package.schema.json`, `run-result.schema.json`.

**Build:**
1. Write `ccis-exec.js`: a small interpreter for the expression tree (no `eval`, no `Function`, no dynamic require); operator whitelist (arithmetic, comparison, interval between datetimes, count, min/max, coalesce); explicit three-valued results (true/false/indeterminate); unknown never becomes false or normal.
2. Decision-node walker that records the rule trace (which inputs and rules caused each transition).
3. Validate the output against `run-result.schema.json`; resource limits (steps, depth) enforced.
4. Tests: same input twice gives byte-identical results; undeclared input access fails; step limit triggers a clear error.

**Done when:** the reference package runs on every fixture and reproduces the hand-calculated results with a full trace.

**Size guard:** 1 module + tests.
