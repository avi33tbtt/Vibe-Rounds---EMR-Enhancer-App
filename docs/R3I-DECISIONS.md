# R3i decisions (2026-11-26). Paste these 3 rows into DECISIONS.md.

| Decision | Choice | Why |
|---|---|---|
| Concept of exported problems and allergies | Always the reserved id `unclassified` with `codes: []`; no label, substance, reaction, severity or reason is selected or sent | The EMR holds them as free text and binds no code; the schema has no text member by design. CCIS reports them as `unmapped` (never guessed). A real concept arrives only with a later row that binds local terms. |
| Empty or missing section; version | A section is sent only when it has an exportable item; version is `0.2.0` when any section is sent, else `0.1.0`; `x-emr.withheld` gains the problem and allergy counts only when the patient has such rows | An empty `allergies` list could be read as "no known allergies", which is a clinical claim the EMR cannot make. Cases without such rows export byte-for-byte as before. |
| Resolution and onset times | Date-only onset becomes `effective` at 00:00 with zone `unknown`; no `period` is sent for resolved items | A date has no zone. The EMR knows when a resolution was recorded, not when the condition ended, so it does not invent an end. |
