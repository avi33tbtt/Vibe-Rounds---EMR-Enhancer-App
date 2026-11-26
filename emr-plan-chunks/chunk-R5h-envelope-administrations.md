# Chunk R5h: envelope 0.3.0 section `administrations` (written 2026-11-26)

**Context impact:** adds ONE OPTIONAL envelope section. CCIS agreement is done (CCIS rows E2a to E2c DONE: schema, importer, fixture `administrations-01`). Vendor the 0.3.0 schema copy the same way R3i did (copy from the CCIS repo, do not edit it). Rules of R3i and R4j carry over: no free text, concept `unclassified` with `codes: []`, a missing section says nothing, entered-in-error is never sent but counted.

**Administrations** = rows of `medication_administrations` (R5d), CCIS `administrationItem`.
1. Never selected: `dose_text`, `reason_text`, `note_text`, drug name, route, site. Only id, outcome, administered_at, recorded_at, status, order link.
2. `outcome` is copied as is (`given`, `held`, `refused`). `unknown` is never produced by the EMR. Held and refused are sent as such, never as given.
3. `effective` = `administered_at` (the EMR's own stated time of the event). `recorded` = `recorded_at`. Never swap them.
4. `orderRef` = the `om-<rank>` id of the linked medication order (same ranking as R4j, rank by id among all medication-order rows). The order is sent only if R4j sends it; if the order is `entered_in_error` (not sent), omit `orderRef` and count `administrationsOrderNotSent`.
5. Ids `ad-<rank>`, rank by row id among all administration rows of the table. No `correctionOf`: the MAR is append-only and an error is `entered_in_error`, not a correction.
6. status `final`, sourceClass `clinician-entered`, `provenance` as in R4j, `verified` false if the schema carries it.
7. Entered-in-error rows: not sent, counted in `x-emr.withheld.administrationsEnteredInError`.

**Scope:** the case's patient, same read-only snapshot as R3i and R4j. Version `0.3.0` when `administrations` is sent, else the lower version rule is unchanged (0.2.0 if only R3i/R4j sections, 0.1.0 if none). `x-emr.withheld` gains counts only when the patient has such rows.

**Files:** `envelope.js`, `context.js`, `contracts/` (schema copy), `test/envelope.test.js`, `test/context.test.js`, a short `docs/R5H-DECISIONS.md` (max 3 rows). Tracker.

**Tests (at most 8 cases, targeted files only):** no rows means no section and the old version; given, held and refused map correctly; no free text appears anywhere in the output (search the JSON for the typed dose and reason strings); effective vs recorded kept apart; `orderRef` resolves to an exported order; error rows withheld and counted; version 0.3.0 only when the section is sent; output validates against the vendored 0.3.0 schema. At most 3 breakages (swap effective and recorded; send dose text; drop the version bump).

**Size guard:** about 40 lines of builder, 10 of route wiring, 8 test cases. If more, STOP and split schema vendoring from the builder.
