# contracts/

Schemas vendored (copied, never edited) from the CCIS repo, https://github.com/avi33tbtt/Vibe-Rounds---CCIS

- Source commit: `f7ed4e13721cf906350334f50ae83dcaa502f320` (path `ccis/schemas/`; the first two files below were byte-identical at the earlier commit `fe16578`).
- `context-envelope.schema.json`: the shape of the file this app exports for one case.
- `manifest.schema.json`: only for the `$ref` targets (`artefactId`, `artefactType`, `semver`) the envelope uses.
- `run-record.schema.json`, `run-result.schema.json` (DM2a): the shape of a CCIS result file. The server validates every imported record against it (`ccis-runs.js`, runtime).
- `analytics.schema.json`, `validation-record.schema.json`, `import-report.schema.json`: only for the `$ref` targets the run record uses.

To update: copy the new files over, change the commit above, run `npm test`. Do not hand-edit these files: the envelope must
validate against the CCIS copy. Used by `envelope.js` (builder), `ccis-runs.js` (record validation, runtime) and the tests.
