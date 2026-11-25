# R2f-4b: restore local codes on the demo sets (docs, written before the build)

Goal: the demo sets that lost their codes on import (vitals, glucose, DKA) get LOCAL codes back, as new versions taken through the real review rules, so server lint verifies them (R2f-4a). No licensed code is used.

- `npm run terms:bind` (script `scripts/bind-demo-codes.js`). Needs `npm run seed` users, SEED_PASSWORD, the example terms published (`npm run terms:seed`) and the demo library published. Talks to the app over HTTP as doctor1, informatician1 and admin1, like `terms:seed`. No SQL.
- Mapping (field id -> example term), reviewed by the owner before real use:
  - `vitals`: hr -> demo.heart-rate; bp_sys, bp_dia -> demo.blood-pressure; rr -> demo.respiratory-rate; spo2 -> demo.oxygen-saturation. Temperature has no term and stays uncoded.
  - `glucose_ss`: glu -> demo.raised-glucose. `dka_ctx`: dka_glu -> demo.raised-glucose. NEAREST example term only: the term says "raised", the field is a reading. Flagged for the owner; a better term can be added later.
- Each binding is `{system:'local', code, display, version}` with display and version read from the PUBLISHED term. `version` is text ("1").
- Per set: read the latest published version; if its mapped fields already carry exactly these bindings, do nothing ("current"). If the set is missing or unpublished, skip it. If the set has an open version (draft, in review, reviewed), stop with a message, never overwrite. Otherwise POST a new version, submit (doctor), approve (informatician), publish (admin). Safe to run again.
- A set that needs two reviewers stops with a message (the script has one informatician).
- The page built-ins still carry licensed codes in `emr-enhancer.html`; changing them is R2f-4c (page edit, own row).
- Context impact: bindings carry `local` and version; agree with CCIS before the envelope exports any.
