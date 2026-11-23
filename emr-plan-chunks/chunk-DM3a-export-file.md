# Chunk DM3a: Bridge step 1, export the envelope file

_Needs: DM1, B5b._ **Core rules:** attach `01-core.md`. **Read only:** `context.js` (the route), `scripts/seed-demo.js` (the client style).

**Build:** in `scripts/demo-bridge.js` (new, not part of the server) export `exportEnvelope({ base, username, password, caseId, outDir })`:
1. Log in over HTTP as a user with `context:read` (session cookie, `x-emr` header, like `seed-demo.js`).
2. `GET /api/cases/:id/context`. Keep the RESPONSE BYTES exactly as sent (no parse and re-stringify before writing).
3. Write them to `outDir/<filename from Content-Disposition>` and return `{ path, sha256, bytes }`.
4. The SHA-256 must equal `context_exports.envelope_sha256` for that export. Any non-200 throws with the server message (never a stack with data).
5. No clinical data in logs: print the path and the hash only.

**Done when:** a test seeds the demo, exports, and shows file hash = returned hash = `context_exports` row; the file validates against `contracts/context-envelope.schema.json`; a bad login, an unknown case and a viewer-without-permission throw.
**Size guard:** 1 script, 1 test. Mapping (DM3b), CLI (DM3c), import and npm script (DM3d) are NOT in this row.
