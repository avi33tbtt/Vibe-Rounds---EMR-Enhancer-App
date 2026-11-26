# Chunk R3i: envelope 0.2.0 sections `problems` and `allergies` (written 2026-11-26)

**Context impact:** adds two OPTIONAL envelope sections, `problems` and `allergies`. CCIS agreement is done: CCIS rows E1a to E1c are DONE (schema, importer, paperwork; amendment A-004). `orders` and `results` stay with R4j.

**Rules (decided here, see DECISIONS.md):**
1. Items use CCIS `contextItem`. The EMR keeps problems and allergies as the clinician's FREE TEXT (`label`, `substance`, `reaction`) and never binds a code, so every item is sent with the reserved concept `unclassified` and `codes: []`. NO text travels: label, substance, reaction, severity, resolution reason and error reason are never selected by the route.
2. `active` -> lifecycle `active`; `resolved` -> `resolved`. `entered_in_error` is never sent, only counted in `x-emr.withheld`. status is `final`, sourceClass `clinician-entered`, `provenance.verified` false.
3. Date-only onset -> `effective` at 00:00 with zone `unknown` (E1a limitation). No `period` is sent: the EMR only knows when the resolution was RECORDED, not when the condition ended, and never invents it.
4. A section is sent only when it has at least one item. An empty or missing section means NOTHING (it is not "no known allergies"). Version is `0.2.0` when any section is sent, else `0.1.0` (a case with no problems and allergies exports exactly as before).
5. Problems and allergies belong to the PATIENT: the route exports those of the case's patient, in the same read-only snapshot.
6. Ids are `pr-<rank>` and `al-<rank>`, rank by row id among all rows of that kind (stable whether or not some are withheld).

**Files:** `contracts/context-envelope.schema.json` (copied from CCIS, never edited) and `contracts/README.md`; `envelope.js` (pure); `context.js` (two reads); tests in `test/envelope.test.js` and `test/context.test.js`.

**Size guard:** envelope.js about 40 lines, context.js about 10, tests about 8 cases. If it grows past that, STOP and split the route from the builder.
