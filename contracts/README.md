# contracts/

Schemas vendored (copied, never edited) from the CCIS repo, https://github.com/avi33tbtt/Vibe-Rounds---CCIS

- Source commit: `fe1657827966710f28e8f4e06b489328372cc8b8` (path `ccis/schemas/`).
- `context-envelope.schema.json`: the shape of the file this app exports for one case.
- `manifest.schema.json`: only for the `$ref` targets (`artefactId`, `artefactType`, `semver`) the envelope uses.

To update: copy the new files over, change the commit above, run `npm test`. Do not hand-edit these files: the envelope must
validate against the CCIS copy. Used by `envelope.js` (builder) and `test/envelope.test.js` (validation, tests only).
