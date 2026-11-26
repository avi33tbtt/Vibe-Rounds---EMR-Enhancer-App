# R5h decisions (2026-11-26)
| ID | Decision |
|----|----------|
| R5H-1 | Tests added to `test/envelope.test.js` (4 cases) and `test/context.test.js` (1 route case), as the chunk lists, not a new file. |
| R5H-2 | Withheld counts use the chunk's names: `administrationsEnteredInError`, `administrationsOrderNotSent`. They appear only when the patient has administration rows. |
| R5H-3 | Schema copy in `contracts/` is the CCIS 0.3.0 file verbatim (diff vs the old copy is additions only: `administrationItem`, the version gate, the section). The `unknown` outcome is never produced by the EMR. |
