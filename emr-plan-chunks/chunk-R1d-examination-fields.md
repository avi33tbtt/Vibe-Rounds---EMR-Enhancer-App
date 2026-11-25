# R1d: structured examination fields (2026-11-25)

**Context impact:** new observation kinds only. The examination fields are ordinary fields of new element sets (types `select` and `text`), so they reach the envelope through the existing observation path. No new envelope section, no new field type, no CCIS schema change. Two limits, stated here on purpose:
- `select` findings (for example `Abnormal finding`) flow into the envelope as plain strings, like the R1b attribute selects. Nothing grades, scores or acts on them.
- `text` fields (the free-text details of a finding) are WITHHELD from the envelope as narrative (counted as `narrativeObservations`, envelope.js). They stay in the EMR record only.

**Scope (data only):** no codes, no doses, no thresholds, no normal ranges, no scores, no rules, no AI, no numbers in labels or options. Measured values (pulse, pressure, temperature, weight) stay in the existing `vitals` set; this row does not duplicate them. A clinician owner is still needed before any rule content.

## What is built
1. `modules/56-exam.js`: five plain element sets recognised by the id prefix `ex_` (no new set kind), written out in full (no generator; the three answers are one shared constant `EX_ANS`), top level plain values only:
   `ex_general` (general examination), `ex_cvs` (heart and circulation), `ex_resp` (chest and breathing), `ex_abdomen`, `ex_neuro` (nervous system).
2. Each set is a list of findings. Every finding is ONE `select` field with the same three answers, in this order: `Not examined`, `Nothing abnormal found`, `Abnormal finding`. A set ends with one `text` field for details in the examiner's words. Field ids are prefixed per set (`exg_`, `exc_`, `exr_`, `exa_`, `exn_`) so two applied sets never share a value, and none clash with an existing built-in set.
3. Page changes (small): load the module after `54-adaptive.js`; `BUILTIN.push(...EXAM_SETS)`; a short "Examination" card under the complaint picker with one button per set (same `applySet` action, no new handler, no inline handler); `renderExam()` called from `renderAll`; the five ids added to `DEMO_IMPORT`.
4. "Not examined" is an explicit answer so a blank is never read as normal. A blank is still sent nowhere (B3b-2 rule); the page's `Unknown` button stays for "cannot say".

## Not in R1d
- Adding the exam sets to the `pw_opd` pathway: that changes a published pathway and needs a pathway version row. The picker is the way in for now.
- Linking findings to complaints, suggesting findings from a complaint, or scoring anything: not planned.
- Codes for findings: wait for R2 (server terminology).

## Known limit
The demo import skips a slug that already exists on the server, and there is no draft editor. New sets reach a server that already holds the demo library only through the Library tab import (new slugs are not skipped). Nothing here changes existing set versions.

## Tests (`test/exam-page.test.js`)
Five sets exist as built-ins with the `ex_` prefix; each passes the shared lint with no codes and needs no second reviewer; no digits in labels or options; every finding is a select with the same three answers in order; each set ends with one text field; ids unique across all built-ins; offered in the demo import; module loads after `54-adaptive.js`; picker shows five buttons with no inline handler and a click applies the set; a finding is recorded through the page (local mode); two exam sets keep separate values; the envelope maps selects and withholds the text field (using `envelope.js`).
