# Chunk C0-ccis-spec: CCIS specification baseline (documentation only)

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 0._

**Core rules:** attach `01-core.md` too.

**Read only:** Ch7 and Ch9 of the book (the user attaches them); `CLINICAL_CONTEXT_MODEL.md`; `01-core.md`.

**Build:**
1. Create `ccis/SPEC.md`, `ccis/CHANGELOG.md`, `ccis/README.md`: normative core with requirement IDs (CCIS-REQ-nnn), versioning policy (semver; breaking = new major; unknown critical fields rejected, extension namespace `x-`), security boundary (packages are declarative data; no network, filesystem or patient data access), and the layer list of the validator.
2. Fix the first slice use case: snake envenomation process metrics (bite-to-ASV interval, 20-minute clotting-test documentation completeness). Thresholds are parameters supplied by the local clinician and arrive disabled; no doses or bands from any model.
3. List the eight artefact types and their required metadata. No code.

**Done when:** the spec is internally consistent, every requirement has an ID, and the user has approved freezing it for prototype work.

**Size guard:** 3 markdown files, no code.
