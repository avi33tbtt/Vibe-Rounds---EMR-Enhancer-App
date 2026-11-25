# R1f: quick and detailed mode (2026-11-25)

**Context impact:** none. Display only. Which questions are SHOWN changes; what is stored does not. No set definition, field, observation kind, envelope section, route or migration changes. The envelope and every export are the same in both modes.

**Scope:** no thresholds, no scoring, no inference, no AI. The switch decides only how many questions of a long form are on the screen.

## What is built
1. `modules/59-mode.js`: state `MODE={quick:false}`, a plain table `QUICK_FIELDS` (applied set id to the field ids kept in quick mode), and functions `modeHidden`, `modeNote`, `setMode`, `renderMode`.
2. One entry in this row, on existing fields (no new set versions): `opd_visit` keeps 13 of its 22 questions in quick mode: visit type, presenting complaint, history of present illness, current medicines, allergies and allergy details, impression, treatment and plan, advice, warning signs, referral, disposition, follow-up. Quick mode hides 9: onset and duration, past history, family and social history, review of systems, general and systemic examination, results reviewed, differential, investigations ordered. The examination sets (R1d) and the assessment and plan set (R1e) are the structured way to record those in a short visit.
3. A small Quick / Detailed switch above the complaint picker (two buttons, `aria-pressed`, no inline handler). Default is Detailed, so nothing changes until someone clicks. A card that hides something says how many and offers one button back to Detailed.
4. Safety rules of the display, enforced in `modeHidden`:
   - A question that already holds a value (a scalar value, any row of a repeating field), an explicit Unknown or an entered-in-error row is ALWAYS shown, in either mode. Nothing recorded is ever hidden.
   - Detailed shows everything, and is one click away on every card that hides something.
   - A set with no table entry is never touched; a table entry naming no real field of the set is ignored.
   - Not gated: IPD sets (they hold safety checklist items: clot prevention, falls, consent, escalation), complaint sets (R1a/R1b), examination sets (R1d), the assessment and plan set (R1e). Same caution as R1c.
   - R1c follow-up rules still apply on top: a follow-up held back by an earlier answer stays held back in Quick mode, and "Show all questions" there is unchanged.
5. The mode is kept in the page only (not in browser storage, not on the server) and resets to Detailed on reload. It is a display choice, not a patient record.

## Not in R1f
- Quick lists for other sets, and a per-user saved mode: later rows (need a clinician to choose what a quick visit must keep, and a settings decision).
- A `quick` key in set definitions: the server and lint reject unknown keys, so that needs a server change and its own row.
- Hiding anything in the IPD sets.

## Known limit
The 13/9 split of `opd_visit` is a display choice, not clinical content. A clinician should confirm which questions a quick visit may leave off screen before pilot use.

## Tests (`test/mode-page.test.js`)
Every `QUICK_FIELDS` entry points at real fields of one built-in set; default is Detailed and shows all 22; Quick shows the 13 and the note says 9; switching back shows all; a recorded value, an Unknown, an entered-in-error row and a repeat row are never hidden in Quick; a set with no entry is untouched in Quick (the IPD sets show all their fields); an entry naming no real field is ignored; R1c still holds in Quick (follow-up held back until its parent answer); buttons carry `aria-pressed` and no inline handler; switching mode makes no request and writes nothing to storage (so nothing can reach the envelope); the module loads between 58-assessment and 60-library.
