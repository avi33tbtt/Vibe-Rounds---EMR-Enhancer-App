# R1b: structured symptom attributes (2026-11-25)

**Context impact:** new observation kinds only. The attributes are ordinary fields of the existing complaint sets (types `select`, `datetime`, `number`), so they reach the envelope through the existing observation path. No new envelope section, no new field type, no CCIS schema change. Two limits, stated here on purpose:
- `number` fields with no unit are WITHHELD from the envelope (counted as `unitlessNumbers`, envelope.js). The duration amount is unitless because its unit is a separate select, so it stays in the EMR record only. The `Started on` datetime does flow into the envelope.
- Select words (for example `Gradual`, `Mild`) are labels the patient or clinician chose. Nothing grades, scores or acts on them.

**Scope (data only):** no codes, no doses, no thresholds, no scores, no rules, no AI. A clinician owner is still needed before any rule content.

## What is built
1. Each of the six R1a complaint sets (`cc_fever`, `cc_cough`, `cc_abdo`, `cc_headache`, `cc_chest`, `cc_joint`) starts with the same six attribute fields, ids prefixed per set (`fev_`, `cgh_`, `abd_`, `hdc_`, `cpn_`, `jnt_`) so two applied complaints never share a value:
   `_onset` (select), `_start` (datetime), `_dur` (number, amount), `_dur_u` (select, unit of time), `_course` (select), `_sev` (select, patient's own words).
2. Written out in full in `modules/52-complaints.js` (no generator): module top level stays plain values, as the module tests expect.
3. No page change: the form already renders select, datetime and number fields and records them through the server as typed values.

## Not in R1b
- Follow-up fields shown by earlier answers: R1c. Examination fields: R1d.
- Linking duration to the start time or computing it: not planned (no derived values from clinical text).

## Known limit
The demo import skips a slug that already exists on the server. If the R1a `cc_*` sets were already sent for review, their v1 stays WITHOUT these fields (there is no draft editor). On a scratch database, wipe and import again; on one you keep, the new fields arrive only with a new version, which needs a later row.

## Tests (`test/complaints-page.test.js`, added)
Every complaint set carries the six attribute fields with the right types and its own prefix; options contain no digits; selecting a value works through the page in local mode; the lint still passes with no second reviewer; the types the envelope maps (`select`, `datetime`, `number`) are the only ones used.
