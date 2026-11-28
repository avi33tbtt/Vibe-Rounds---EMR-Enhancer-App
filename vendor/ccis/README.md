# vendor/ccis/

Prototype. Synthetic data only. Not for clinical use.

Byte copies of CCIS modules (validator, canonical JSON, SHA-256, compose) from https://github.com/avi33tbtt/Vibe-Rounds---CCIS at the commit in `SOURCE.json` (the same commit as `contracts/`, D1). Never edit a copy: `test/vendor-ccis.test.js` checks every SHA-256.

- The files are ES modules; `package.json` here says `{"type":"module"}`. Load them only with `await import()` from CommonJS, never `require` (ED-77).
- Root files come from the CCIS repo root; `ccis/validators/ccis-validators.js` is the generated schema bundle from `ccis/validators/`.
- `ccis-rules`, `ccis-exec` and `ccis-bind` are not here yet (row D20).
- To update: copy the new files over, change the commit, regenerate the hashes in `SOURCE.json`, run `npm test`. Keep `contracts/SOURCE.json` on the same commit.
- Needs Node 22 or newer (Docker and CI use 22).
