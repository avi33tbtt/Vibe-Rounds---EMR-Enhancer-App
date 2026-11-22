# Chunk D5b-fhir-roundtrip: FHIR Mode: round-trip, terminology and negative tests

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: D5a._

**Core rules:** attach `01-core.md` too.

**Read only:** `sdc.js`; `ccis/examples/` FHIR Mode example.

**Build:**
1. Round-trip tests only for mappings claimed lossless; unit and terminology tests; profile validation fixtures; negative fixtures for unsupported structures (must be rejected with a diagnostic, not dropped).
2. Update the matrix when a claim fails a test.

**Done when:** every claimed capability has a passing test; unsupported structures are refused visibly.

**Size guard:** tests + fixtures; edit `sdc.js` only to fix a failing claim.
