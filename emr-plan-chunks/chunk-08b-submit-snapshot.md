# Chunk 08b: Server: submit a set for review (snapshot)

_Part of original chunk 08. Assumes sets stay in the browser; only a snapshot is sent (see DECISIONS.md, 2026-11-22 audit row)._

**Core rules:** attach `01-core.md` too.

**Read only:** `app.js`, `permissions.js`, `audit.js`, `migrations/` (list), `lint.js` from 8a, `test/safety-routes.test.js` (matrix), `test/helpers.js`.

**Build:**
1. Migration (next free number) for `set_versions`: id, set key, version number, content (jsonb), lint result, status (`draft`, `in_review`, `approved`, `rejected`), author id, created at (server time). No DELETE (same approach as the other clinical tables).
2. `POST /api/sets/submit`: needs a new permission; runs `lint.js` on the server; errors block submit, warnings are stored; author and time come from the session and the server. A body carrying author/status/time is rejected. Audited.
3. `GET /api/sets` and `GET /api/sets/:id` for reading.
4. Update the permission matrix and audit scenarios in `test/safety-routes.test.js` on purpose; add tests for submit and the rejected body keys.

**Done when:** a submit stores a snapshot with the session author and server time; lint errors block it.

**Size guard:** One migration, one routes block, tests. Keep route code in a new file to avoid growing `app.js`.
