# Chunk DM3d: Bridge step 4, import and `npm run demo:run`

_Needs: DM3a, DM3c, DM3b-2, DM2a._ **Core rules:** attach `01-core.md`. **Read only:** `scripts/demo-bridge.js`, the import route in `ccis-runs.js`.

**Built:**
1. `importRun`: log in, POST the run record file bytes unchanged to `POST /api/cases/:id/ccis-runs`; returns `{ runId, status, alreadyImported, httpStatus }`; any refusal becomes a plain error with the server's message.
2. `runDemo`: export, run CCIS, import in one call.
3. `npm run demo:run -- <case id> [--demo-parameters]`. Needs the server running and `SEED_PASSWORD` in `.env`. Optional env: `DEMO_BASE_URL`, `DEMO_USER`, `DEMO_OUT_DIR` (default `demo-out/`, git-ignored), `CCIS_PATH`.
4. Test `test/demo-run.test.js`: stub CLI, real server and database.

**Not built:** no "Run CCIS" button in the page (boundary stays visible); no real-CLI test (that is DM4c).
**Size guard:** same script, 1 test, package.json.
