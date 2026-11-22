# Chunk D4b-cohort-evaluator: Cohort evaluator on synthetic datasets

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: D4a._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis-exec.js`; `ccis/fixtures/`.

**Build:**
1. Write `ccis-cohort.js`: three-valued eligibility (eligible, ineligible, indeterminate), per-patient explanations, and a reproducible cohort manifest (counts per state, reasons, data-coverage notes).
2. Synthetic dataset of about 30 patients covering transfers, duplicates, incomplete histories and conflicts; expected counts hand-calculated.
3. Tests: indeterminate is never folded into ineligible or eligible; a single count never hides data-quality limits.

**Done when:** manifest matches hand-calculated expectations and reruns byte-identically.

**Size guard:** 1 module + fixture file + tests.
