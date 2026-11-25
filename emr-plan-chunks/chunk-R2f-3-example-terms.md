# R2f-3: example local terms (docs, written before the build)

Goal: a small, free, synthetic vocabulary so the local-terms feature can be used and shown without any licence. Our own words only: nothing copied from ICD, LOINC, SNOMED CT or any other vocabulary, no numbers, no thresholds, no doses.

- `npm run terms:seed` creates 12 example terms with codes `demo.<name>` through the REAL routes (no SQL): doctor adds and submits, informatician approves with a reason, admin publishes. Needs `npm run seed` users and SEED_PASSWORD, like `demo:seed`.
- Safe to run again: a term already published with the same display is left alone; a term stuck half-way (draft, in review, reviewed) is carried on from where it stopped; a term whose latest version is retired or rejected gets a new version.
- `npm run terms:reset` retires the published example terms (never deletes) and then seeds fresh published versions. Version numbers go up; old versions stay as retired history.
- Covers the words the demo sets use: snake bite timing (fang marks, bite-site swelling, bleeding from gums, whole blood clotting test, antivenom), glucose and DKA, and vital signs. Categories: finding, condition, test, procedure, observation.
- Nothing in the page or in the sets uses these codes yet: binding and verification come in R2f-4, the screen in R2f-5.
- Context impact: none.
