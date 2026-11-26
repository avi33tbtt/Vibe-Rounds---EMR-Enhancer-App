# R6f-2a decisions (2026-11-26)
| ID | Decision |
|----|----------|
| R6F2A-1 | The same bundle (same canonical hash) is staged once: a second try gives 409 `already_staged` with the first bundle id. This keeps "one proposal, one record" true later. A changed bundle is a new bundle. |
| R6F2A-2 | Stage, list, read and reject all use `import:write` (admin, doctor). The stage route reads up to 2 MB (the 50 kb default is skipped for that one path, like run-record import). |
| R6F2A-3 | Migration 033 already holds the `accepted_*` columns and a database rule that only a READY, non-MedicationRequest proposal can become `accepted`, so R6f-2b and R6f-2c need no new migration. No route accepts yet. |
