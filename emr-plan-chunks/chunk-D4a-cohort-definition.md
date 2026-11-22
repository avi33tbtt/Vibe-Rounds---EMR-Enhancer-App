# Chunk D4a-cohort-definition: Cohort definition schema and validator

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: C9._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis-validate.js`; Ch8 section 6 and Ch10 section 4 (supplied).

**Build:**
1. Add `cohort.schema.json`: inclusion/exclusion criteria over typed variables with explicit Boolean logic, index event/date, look-back, washout, follow-up window, censoring, age/eligibility boundaries with units, repeated-event and duplicate handling.
2. Validator rules for cohort definitions (units, temporal coherence, no unbounded windows).

**Done when:** cohort definitions validate; invalid temporal logic gives actionable diagnostics.

**Size guard:** 1 schema + rules + tests.
