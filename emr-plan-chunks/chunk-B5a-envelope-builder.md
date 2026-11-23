# Chunk B5a-envelope-builder: Pure envelope builder + vendored CCIS schema

_Replaces item 1 of chunk-B5. Needs: B3a, B4, CCIS row 1.4 (done)._

**Core rules:** attach `01-core.md` too.

**Read only:** `CLINICAL_CONTEXT_MODEL.md`; `deid.js`; `observations.js` (row shape); `ccis/schemas/context-envelope.schema.json` in the CCIS repo (copy it in, do not re-invent field names).

**Build:**
1. Vendor the CCIS schemas the envelope needs into `contracts/` (envelope + the `$ref` targets such as `manifest`), with a `contracts/README.md` naming the CCIS commit they came from.
2. Add `ajv` 8.18.0 as a **devDependency** (tests only; same pin as CCIS).
3. `context.js`: pure function `buildEnvelope({ caseRow, pins, observations, events, exportedAt, producerVersion })` returning an object that validates against the schema: top-level `envelope`, `inclusions`, `case`, `applied`, `observations`, `events`. Time is an input. Deterministic ordering.
4. Rules: no name, MRN, DOB or narrative; entered-in-error excluded; the six data states stay distinct (absent, unknown, not collected, not applicable, negative, entered-in-error never merged); pinned set and pathway versions listed exactly.
5. Tests: envelope validates against the vendored schema; excludes identity and narrative (hostile strings in the case are absent from the output bytes); same input gives identical bytes; unknown never becomes false.

**Done when:** a seeded case produces an envelope that passes the CCIS schema and is byte-stable.

**Size guard:** 1 module, `contracts/`, 1 test file, package.json devDependency. No route, no migration.
