# Chunk D2a-decision-graph-engine: Decision graph: schema extensions, static checks, executor

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: C5c._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis/schemas/decision-node.schema.json`, `pathway.schema.json`; `ccis-exec.js`.

**Build:**
1. Add a `decision-graph` artefact (typed nodes/edges, entry conditions, branch predicates, terminal states, required data, missing-data routes, evidence links, explanation text).
2. Static checks: no dead ends, cycles bounded by a declared max, every input absent/stale/conflicting/out-of-range/uninterpretable has a route; unknown never becomes false/normal.
3. Executor returns the path, the reason for each transition and the data values used. Tests with the snake-envenomation timing graph and one AKI-style graph (questions only, no dosing).

**Done when:** graphs validate, execute deterministically and explain every transition.

**Size guard:** 1 schema + executor extension + tests.
