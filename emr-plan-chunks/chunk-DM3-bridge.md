# Chunk DM3-bridge: Demo bridge script (envelope to CCIS CLI to import)

_Needs: DM2a, CCIS DS4._ **Core rules:** attach `01-core.md`.
**Read only:** `scripts/seed-demo.js`; the CCIS CLI usage in its README.

**Build:**
1. `scripts/demo-bridge.js` (not part of the server): given a case id, calls the EMR export code to write the envelope file, runs the sibling CCIS checkout's `ccis-cli.js run` as a child process (path from `CCIS_PATH`, no shell string concatenation), then imports the resulting run record through the DM2a route using a session token.
2. No network between the two products; the only link is files and a child process.
3. Optional button "Run CCIS (demo)" is NOT added; the demo uses the script or manual file steps. Keeps the boundary visible.
4. Test with a stub CLI that returns a fixture run record.

**Done when:** `npm run demo:run -- <case id>` leaves a run in the insights panel.
**Size guard:** 1 script, 1 test.
