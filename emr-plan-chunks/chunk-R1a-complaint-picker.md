# R1a: complaint picker screen + OPD complaint sets (2026-11-25)

**Context impact:** none. Complaint sets are ordinary element sets, so they reach the envelope only through the existing observation path. No new observation kind, no envelope section, no CCIS schema change. R1b adds structured attributes (new observation kinds) and states its own impact.

**Scope (data only):** no terminology codes, no doses, no thresholds, no red-flag rules, no AI. Fields are neutral history questions (select, yes/no, short text). Nothing here says what an answer means. A clinician owner is needed before any rule content (see the tracker).

## What is built

1. `modules/52-complaints.js`: `COMPLAINT_SETS` (six sets, ids start with `cc_`), the `CC` filter state and the picker (`ccList`, `renderComplaints`). A classic script like the other modules: top level is plain values and function declarations only.
2. Six sets, kind `template`: fever, cough or breathing difficulty, abdominal pain, headache, chest pain, back or joint pain. About six fields each. Field ids are prefixed per set (`fev_`, `cgh_`, `abd_`, `hdc_`, `cpn_`, `jnt_`) so they never clash with any other built-in set.
3. The sets are added to `BUILTIN` (page) and to `DEMO_IMPORT` (library module), so an admin or doctor sends them for review with the other demo sets (v1, no codes, not usable until approved and published).
4. Picker card in the case workspace, above the form area: a search box and one button per complaint set. A click runs the existing `applySet` (local demo mode adds it; signed in, it pins the exact published version through the server). Applied sets show as "Added" and are disabled.
5. Signed in, only PUBLISHED complaint sets appear (the page library is read from the server). With none published the picker says so and does not invent any.

## Not in R1a

- Onset, duration, severity as fields: R1b.
- Follow-up fields shown by earlier answers: R1c.
- Examination fields, assessment and plan block, quick/detailed mode: R1d to R1f.
- Linking a complaint to a pathway or to the OPD note's "Presenting complaint(s)" field: not planned; the picker only adds sets.

## Decisions

- A complaint set is recognised by the id prefix `cc_`, not by a new set kind. The server's kinds are fixed (`disease`, `care`, `template`, `custom`); a new kind would need a migration and server change that R1a does not need.
- The picker reuses `applySet`, so pins, pathways and permissions behave exactly as for any set.

## Tests (`test/complaints-page.test.js`)

Six sets exist with `cc_` ids; each passes the shared lint with no codes and no second reviewer needed; field ids unique across all built-ins; the picker lists six, filters by text, and a click applies the set and marks it Added; hostile titles are shown as text; signed in with an empty server library the picker says none are published; the sets are in `DEMO_IMPORT`.
