# R1c: adaptive history (2026-11-25)

**Context impact:** none. Display logic only. Which questions are SHOWN changes; what is stored does not. No set definition, field, observation kind, envelope section, route or migration changes.

**Scope:** no thresholds, no scoring, no clinical inference, no AI. A rule says only: "show this follow-up question once this earlier question has one of these answers".

## What is built
1. `modules/54-adaptive.js`: a plain table `ADAPT_RULES` (child field, parent field in the SAME set, answers that reveal it) and small functions: `adaptHidden`, `adaptIsParent`, `adaptNote`. State `ADAPT_ALL` (the "Show all questions" switch).
2. Rules in this row, all on existing fields (no new fields, so no new set versions):
   - `opd_allergy_detail` shown when `opd_allergy` is "Known (describe in the details field)".
   - `adm_allergy_detail` shown when `adm_allergy` is the same answer.
   - `opd_referral` shown when `opd_dispo` is "Referred".
3. `renderForms` skips a hidden follow-up and adds one line to the set card: how many are hidden, and a "Show all questions" checkbox.
4. Safety rules of the display:
   - A follow-up that already holds a value (or Unknown, or an entered-in-error row) is ALWAYS shown, whatever the parent says. Nothing recorded is ever hidden.
   - "Show all questions" is one click away on every card that hides something.
   - A rule whose parent is not in the same applied set is ignored (the question is shown).
   - No complaint-set question is gated (R1a/R1b fields are safety-relevant history; hiding them behind an answer is not decided here).
5. Changing a parent answer in local mode re-draws the form (`setVal` calls `renderForms` for a parent field). Signed in, saving already re-draws.

## Not in R1c
- Follow-ups inside the complaint sets: they need new fields, which means new set versions, and a decision by a named clinician on which questions may be gated. Later row.
- Rules stored in set definitions (a `showIf` key): the server and lint reject unknown keys, so that needs a server change and its own row.

## Tests (`test/adaptive-page.test.js`)
Every rule points at real fields of one built-in set, parent is select or boolean, answers are real options; follow-up hidden then shown then hidden; recorded value stays visible; Show all; Unknown and signed-in value keys (`srvAs`); no complaint field is ever hidden; no inline handler.
