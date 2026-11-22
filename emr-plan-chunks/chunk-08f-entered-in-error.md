# Chunk 08f: Mark observation rows 'entered in error' instead of deleting

_Added by the audit. Closes known gap (b). Core rule: never hard-delete clinical data._

**Core rules:** attach `01-core.md` too.

**Read only:** `emr-enhancer.html`: `grep -n "delRow"` and the observation table render; `test/safety-data.test.js`.

**Build:**
1. Replace `delRow` splice with a status `entered_in_error` plus who (session) and when; the row stays stored.
2. Rows in error are hidden by default, shown on request with a strike-through, and excluded from the FHIR export as `status: entered-in-error` (or omitted, record which in DECISIONS.md).
3. Convert the matching `test.todo`; add tests that the row is still in the stored data and the export.

**Done when:** no observation row can be removed from stored data from the page.

**Size guard:** Page plus one test file.
