# Chunk D4c-cohort-analytics: Cohort analytics execution and aggregation

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: D4b, D1a._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis-cohort.js`, `ccis-exec.js`; package schema (aggregation field).

**Build:**
1. Execute a package per eligible patient; aggregate only where the package declares a valid aggregation (count, proportion, median, interval distribution) with missing-data counts.
2. Produce a provenance report: cohort definition checksum, package checksum, engine version, dataset manifest hash.
3. Tests: aggregation over indeterminate patients is reported separately; unsupported aggregation is refused.

**Done when:** a reproducible cohort report with full provenance runs on the synthetic dataset.

**Size guard:** 1 module + tests.
