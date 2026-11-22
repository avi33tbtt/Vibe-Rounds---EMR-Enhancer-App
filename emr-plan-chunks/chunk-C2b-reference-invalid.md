# Chunk C2b-reference-invalid: Reference artefacts: research-derived candidate, FHIR Mode example, invalid per layer

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 1. Needs: C2a._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis/examples/`; `sdc.js`.

**Build:**
1. Add a research-derived analytics candidate (evidence traceability, cohort rules, fixtures; status draft), one FHIR Mode example with a mapping report that states lossless/conditionally lossless/lossy per mapping.
2. Add one invalid example per validator layer (syntax, structural, reference, semantic, graph, safety, test, governance), each with `expected-diagnostics.json` (rule ID, path).

**Done when:** an invalid example exists for every layer with its expected diagnostics.

**Size guard:** JSON files only; no validator code yet.
