# R6g: FHIR export conformance

Scope: the four exports R6a to R6d (Observation, Condition, AllergyIntolerance, MedicationRequest). FHIR is the export boundary only; the internal rows stay the system of record.

## Two layers
1. **Offline (R6g-1, runs in `npm test`)**: `test/fhir-conformance.test.js` on `test/fhir-conformance-fixtures.js` (21 resources, including unknown, zero, false, resolved, stopped, entered in error). Checks required elements, no empty elements, valid dates with a zone, well-formed Codings (never a local code), and the R4 invariants that apply (con-3, con-4, ait-2, obs-6). This is a safety net, **not** the public validator.
2. **Public validator (R6g-2, run by you)**: `FHIR_VALIDATOR_JAR=/path/validator_cli.jar npm run fhir:validate`. Needs Java, the jar and internet (the validator fetches the R4 core package once). Exit 0 = no errors, 1 = errors or the validator could not start its engine (for example no internet to fetch the R4 package), 2 = not run. Terminology is off by default (`FHIR_TX=n/a`) because the exports carry text, not codes.

## What to expect
- Errors: none. Any error is a bug in an exporter: open a row, do not edit the fixture to hide it.
- Warnings or hints are normal: no profile is claimed, codes are text only, and units carry text without UCUM codes by design (no verifier exists yet).
- Record the result (date, validator version, counts) in the R6g-2 tracker row.
