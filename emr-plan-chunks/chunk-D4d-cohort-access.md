# Chunk D4d-cohort-access: Population-level access, purpose limitation and small-cell control

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: D4c, B5._

**Core rules:** attach `01-core.md` too.

**Read only:** `permissions.js`, `audit.js`, `test/safety-routes.test.js`; `ci.js`.

**Build:**
1. New permission `cohort:run` (admin and named roles only; running a single-patient analytic does not imply it). Every cohort request carries a purpose (enumerated list) and is audited with purpose, definition checksum and counts only.
2. Minimum-necessary: cohort outputs are aggregate by default; patient-level output needs a second permission and is audited per patient count. Small-cell suppression: counts below a configurable threshold (default 5, reviewable by the clinical owner) are masked.
3. Update the permission matrix and audit scenarios in `test/safety-routes.test.js` on purpose; a new route fails the build until you do.
4. Tests: forbidden role refused; suppression applied; purpose required; audit contains no patient identifiers.

**Done when:** cohort runs are permissioned, purposeful, audited and suppress small cells.

**Size guard:** 1 routes file + permissions + tests.
