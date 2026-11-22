# Chunk C1b-schemas-pathway-node: Schemas: pathway and decision node

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 1. Needs: C1a._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis/SPEC.md`; `ccis/schemas/element.schema.json`; Ch8/Ch10 decision-graph sections.

**Build:**
1. Add `pathway.schema.json` (ordered/conditional steps referencing elements, decision nodes, actions) and `decision-node.schema.json` (question, typed inputs, preconditions, logic reference, outcomes including explicit `indeterminate`, next-node edges, evidence refs, missing-data route).
2. Tests: schema-level failures only (graph checks come in C3b).

**Done when:** both schemas compile; invalid fixtures fail for the right reason.

**Size guard:** 2 schemas + tests.
