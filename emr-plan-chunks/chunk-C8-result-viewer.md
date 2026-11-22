# Chunk C8-result-viewer: Result viewer: input trace, decision path, evidence, provenance

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Needs: C6._

**Core rules:** attach `01-core.md` too.

**Read only:** `ci.js`; page patterns in `emr-enhancer.html` (escaper, adapter); `test/ui.test.js`.

**Build:**
1. Add a separate page `ci.html` (served at `/ci`) with a case picker, compatible-package list, Run button, and a result panel: values with units, decision-node path with rule trace, evidence list, provenance (artefact checksums, engine version, run id).
2. All text escaped with the shared escaper; no inline handlers (CSP). Role-based buttons.
3. Tests in jsdom and one real-Chrome smoke step.

**Done when:** a clinician can run the reference package on a synthetic case and read every step of the result.

**Size guard:** 1 page + 1 route for static serving + tests.
