# Chunk D8a-cohort-package-contract: Cohort data package contract and import acceptance

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: D4d, B5._

**Core rules:** attach `01-core.md` too.

**Read only:** `context.js`; `ccis-cohort.js`.

**Build:**
1. Specify a versioned cohort data package: cohort definition ref, export timestamp, source system, data coverage, record identifiers appropriate to the authorised workflow, terminology and unit information, temporal boundaries, manifest of included records (`ccis/COHORT-PACKAGE.md` + schema).
2. Write the import pipeline (validates, normalises, rejects anything over the declared purpose) and a contract test that accepts a synthetic package from a stub exporter.

**Done when:** a stub-exported synthetic package is accepted by the same import path the real exporter will use.

**Size guard:** 1 spec + schema + import module + tests.
