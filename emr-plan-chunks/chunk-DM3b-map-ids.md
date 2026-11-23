# Chunk DM3b: Map EMR envelope names to CCIS names (pure)

_Needs: B5a-2 (envelope shape), CCIS snake fixtures._ **Core rules:** attach `01-core.md`. **Read only:** `envelope.js` (output shape), one CCIS fixture `ccis/fixtures/snake/normal/*.envelope.json`.

**Build:** `scripts/demo-map.js` exporting `mapEnvelope(envelope)`. Pure: no DB, no clock, no network, input never changed (returns a copy).
1. Element id `snake-envenomation-timing` becomes `snake.envenomation-timing`; pathway `snake-envenomation-documentation` becomes `snake.documentation-path`. Versions are left as they are.
2. Concept ids: `snake-envenomation-timing.<field>` becomes `snake.envenomation-timing.<field>` for the 9 demo fields.
3. Select fields become CCIS `kind: "code"` with one unverified `ccis-demo` code and value `{system, code}`: Exact/Estimated, Performed, Given become `exact`/`estimated`/`performed`/`given`; Clotted and Unclotted both become `demo-result-a` (CCIS holds no member list, D-032). Not performed / Not given become no value and `state: "explicitly-negative"`. An explicit unknown stays `state: "unknown"` as kind `code`.
4. Anything not in the tables (unknown set, pathway, field or select word) THROWS. Nothing is guessed.
5. The output validates against `contracts/context-envelope.schema.json`.

**Done when:** tests cover every mapping, every throw, input untouched, and schema validity of a real built envelope.
**Size guard:** 1 script, 1 test. No CLI, no hashing, no HTTP (DM3c, DM3d).
