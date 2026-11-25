# R2f-4c: built-in sets ship without licensed codes (docs, written before the build)

Goal: no LOINC or SNOMED code is shipped in `emr-enhancer.html` (owner decision 2026-11-25, local terms only).

- Remove the 22 `coding:{system:'loinc'|'snomed',...}` entries from the built-in sets (vitals, intake/output, glucose, HbA1c, diabetes, CKD, DKA context) and from the demo DKA set. Fields stay; coding is optional everywhere.
- Local codes for these fields live on the SERVER as bindings (R2f-4b, `terms:bind`). The page does not carry local codes: it has no way to verify them offline, so unverified bindings would be text only anyway.
- The old code-system registry and its UI (chunk 02) stay as they were. Tests that use sample codes inline (not the shipped sets) are not touched.
- Tests: `codes.test.js` asserts the shipped sets carry no coding and no binding in a licensed system, and no licensed literal remains in the page; `create.test.js` expects the demo DKA set uncoded.
- Context impact: none (the envelope reads stored bindings, not page built-ins).
