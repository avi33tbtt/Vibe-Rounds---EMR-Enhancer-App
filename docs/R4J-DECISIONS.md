# R4j decisions (2026-11-26). Paste these 4 rows into DECISIONS.md (the owner may merge them).

| Decision | Choice | Why |
|---|---|---|
| What counts as an order | Medication orders and investigation orders only. Referrals and procedures are not exported. | The brief says orders and results; the other two were never named. A later row if wanted. |
| Order and result concept | Reserved id `unclassified`, `codes: []`; no drug, dose, test name, priority, clinical info, flag, range or reason leaves the database. A change is lifecycle `replaced`, never a `correctionOf`. | Same rule as R3i: free text, no code is bound. CCIS reports all of them `unmapped` (checked with the real CCIS importer). |
| Which results are sent | Only a plain number (`-12.5`), a one-token unit and a specimen collection time (that is `effective`). Others are withheld and counted (`resultsNotNumeric`, `resultsWithoutUnit`, `resultsWithoutSpecimen`). | The schema has no free-text value; a number is read by a strict pattern, never guessed from words or ranges; recording time is never copied into `effective`. |
| Locking in two earlier routes (bug fix) | `investigation-results.js` (correct) and `result-acks.js` (acknowledge) lock the parent ORDER row, not the result row. | `SELECT ... FOR UPDATE` on `investigation_results` needs UPDATE, which the app role rightly does not have (append-only), so every correction and acknowledgement returned 500. |
