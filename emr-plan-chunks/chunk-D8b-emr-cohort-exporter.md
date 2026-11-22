# Chunk D8b-emr-cohort-exporter: EMR Enhancer cohort exporter

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: D8a, B3c, D4d. Last row of the plan._

**Core rules:** attach `01-core.md` too.

**Read only:** `context.js`, `cases.js`, `permissions.js`, the D8a package contract.

**Build:**
1. Route `POST /api/cohort-export` (permission `cohort:export`): selects cases by cohort definition, emits only the fields the declared purpose requires, de-identifies by default, writes the manifest, audits purpose and counts.
2. Page: a small export dialog with the purpose and a preview of included fields.
3. Contract test: the real export is accepted by the D8a import path; export never contains narrative or identity unless a separate explicit permission is granted.
4. Update the permission matrix and audit scenarios in `test/safety-routes.test.js` on purpose; a new route fails the build until you do.

**Done when:** an authorised, audited cohort export round-trips through the Intelligence App import with a contract test.

**Size guard:** 1 routes file + page dialog + tests. Split server and page if the page diff is large.
