# R1e: assessment and plan block (2026-11-25)

**Context impact:** new observation kinds only. The block is one ordinary element set (`ap_block`), so it reaches the envelope through the existing observation path. No new envelope section, no new field type, no CCIS schema change. Limits, stated here on purpose:
- `text` fields (problems, other possibilities, plan items, advice) are WITHHELD from the envelope as narrative (`narrativeObservations`, envelope.js). They stay in the EMR record only.
- `select`, `boolean` and `datetime` fields flow as plain values. Nothing grades, scores or acts on them.

**Scope (data only):** no codes, no doses, no thresholds, no rules, no AI, no suggestions of any diagnosis or treatment. Every plan item is the clinician's own words.

## Decision: the optional code waits for R2
The brief says "free text and optional verified code". A code can only be called verified when the server checks it (R2c to R2e). Today the server cannot verify, and the review lint refuses any unverified binding, so a code field would either be refused at review or be shown as verified when it is not. This row ships the free-text block only. Coding stays optional everywhere (core rule), so nothing is lost; R2e adds the picker to this set through a new version.

## What is built
1. `modules/58-assessment.js`: one element set `ap_block` (title `Assessment and plan`), written out in full, top level plain values only, prefix constant `AP_PREFIX='ap_'`. Fields, all prefixed `ap_`:
   - `ap_problem` (text, repeat): problem or diagnosis, in the clinician's words
   - `ap_status` (select): `Working diagnosis`, `Confirmed`, `Not yet clear`
   - `ap_ddx` (text): other possibilities considered
   - `ap_plan` (text, repeat): plan item, as decided by the clinician
   - `ap_advice` (text): advice and counselling given
   - `ap_discussed` (boolean): plan discussed with the patient
   - `ap_fu_to` (select): `Same clinic`, `Another clinic`, `Not needed`, `Not decided`
   - `ap_fu_on` (datetime): follow-up on (date)
   One status field for the whole block, not per problem: observations are stored per field, so a multi-field row cannot be linked (R1b decision).
2. Page (small): load the module after `56-exam.js`; `BUILTIN.push(...AP_SETS)`; a short "Assessment and plan" card after the Examination card with one button (same `applySet` action, no new handler, no inline handler); `renderAP()` called from `renderAll`; `ap_block` added to `DEMO_IMPORT`.
3. Signing stays where it is: free text of a consult is finalised by signing a note (B3c). This block adds no second signing path. Values follow the existing rules: append-only, corrected by a new row or entered-in-error.

## Not in R1e
- Verified code per problem: R2e.
- Adding the block to the `pw_opd` pathway: needs a pathway version (later row).
- Medication orders, investigation orders, prescriptions: R4. The plan is free text only.
- Quick and detailed mode: R1f.

## Known limit
A server that already holds the demo library gets the new set only through the Library import (new slugs are imported; existing slugs are skipped). Nothing here changes existing set versions.

## Tests (`test/assessment-page.test.js`)
`ap_block` exists as a built-in; passes the shared lint with no codes, doses or digits and needs no second reviewer; field types, order, repeat flags and the two select option lists are as above; ids prefixed and unique across all built-ins; offered in the demo import; module loads after `56-exam.js`; picker shows one button with no inline handler and a click applies the set; hostile title shown as text; a value is recorded through the page (local mode) and an unlisted word is refused; a repeat problem keeps two rows; the envelope carries the selects, boolean and datetime and withholds all text, and validates.
