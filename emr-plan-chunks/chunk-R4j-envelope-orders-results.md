# Chunk R4j: envelope 0.2.0 sections `orders` and `results` (written 2026-11-26)

**Context impact:** adds two OPTIONAL envelope sections. CCIS agreement is done (rows E1a to E1c DONE; schema already vendored in R3i, nothing to copy). Rules of R3i (no text, unclassified, a missing section says nothing, 0.2.0 only when a section is sent) carry over.

**Orders** = medication orders and investigation orders (CCIS `contextItem`). Referrals and procedures are NOT exported (not in the brief; a later row if wanted).
1. Concept `unclassified`, `codes: []`; medication name, dose, route, frequency, indication, test name, clinical info, priority and all reasons are never selected. Only id, status, ordered_at (as `recorded`), orderer role.
2. Lifecycle: medication `active`, `stopped`, `changed` -> `replaced`; investigation `active`, `cancelled`. `entered_in_error` is never sent, only counted. No `effective` and no `period` (an order has no clinical time the EMR can state; ordered_at is a recording time). No `correctionOf`: a change is a replacement, not a correction.
3. Ids `om-<rank>` (medication) and `oi-<rank>` (investigation), rank by row id among all rows of that table.

**Results** = investigation results (CCIS `observation`, as for observations).
1. Concept `unclassified`. A result is sent only when ALL hold: value text is strictly a plain number (`-12.5`), the unit is one token without spaces, and its specimen has a collection time (that is the `effective` time; recording time is never copied into it). Anything else is withheld and counted (`resultsNotNumeric`, `resultsWithoutUnit`, `resultsWithoutSpecimen`). Nothing is guessed from words, ranges or symbols.
2. kind `quantity`, value number, unit; status `final`, or `corrected` for a replacement result with `correctionOf` the original (kept, `provenance.corrected` true); sourceClass `clinician-entered`; `verified` false. The normal/abnormal flag and the reference range have no member in the schema and are not sent.
3. Ids `rs-<rank>`.

**Scope:** the case's patient, same read-only snapshot as R3i. Version `0.2.0` when any section is sent, else unchanged. `x-emr.withheld` gains the counts only when the patient has such rows.

**Files:** `envelope.js`, `context.js`, `test/envelope.test.js`, `test/context.test.js`. **Size guard:** about 60 lines of builder, 15 of route, 8 test cases. If more, STOP and split results from orders.
