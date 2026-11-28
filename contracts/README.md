# contracts/

Schemas vendored (copied, never edited) from the CCIS repo, https://github.com/avi33tbtt/Vibe-Rounds---CCIS

- Source commit: `ccf64202be8bd4c345b8069471b0bc5ff98828bc` (path `ccis/schemas/`, standard 0.2.0). All 13 files share this one commit. `SOURCE.json` holds the commit and the SHA-256 of every file; `test/contracts-pin.test.js` checks it (D1, ED-11, ED-76).
- `context-envelope.schema.json`: the shape of the file this app exports for one case.
- `manifest.schema.json`: the shared header; the other schemas `$ref` its `artefactId`, `artefactType` and `semver`.
- `run-record.schema.json`, `run-result.schema.json`: the shape of a CCIS result file. The server validates every imported record against it (`ccis-runs.js`, runtime).
- `analytics.schema.json`, `validation-record.schema.json`, `import-report.schema.json`: only for the `$ref` targets the run record uses.
- `element.schema.json`, `terminology-binding.schema.json`, `element-group.schema.json`, `pathway.schema.json`, `decision-node.schema.json`, `rule-pack.schema.json` (D1): the 0.2.0 artefact shapes. Nothing reads them at runtime yet; the package import (D5), pathway accept (D8) and rule packs (D19) will.
- Not copied (ED-76): `terminology-package` and `execution-manifest`.

To update: copy the new files over, regenerate `SOURCE.json` (commit and hashes), run `npm test`. Do not hand-edit these files: the envelope must
validate against the CCIS copy. Used by `envelope.js` (builder), `ccis-runs.js` (record validation, runtime) and the tests.
