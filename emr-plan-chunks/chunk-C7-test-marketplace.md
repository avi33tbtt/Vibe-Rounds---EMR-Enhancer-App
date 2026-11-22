# Chunk C7-test-marketplace: Local test marketplace: publish, resolve, pin

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 4 (minimum). Needs: C4._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis-compile.js`; `ccis/examples/`; Ch6 marketplace sections.

**Build:**
1. Write `ccis-market.js` plus a `market/` folder layout: `index.json` listing packages (id, version, checksum, status, compatibility metadata). `publish` requires a passing validator report and a checksum; `resolve(id, range)` pins an exact version.
2. Lint: published packages must contain no patient records or cohort membership data.
3. A GitHub-backed index is a later row; keep the index format ready for it.

**Done when:** a package is published, resolved by version and refused when the validator fails or patient data is present.

**Size guard:** 1 module + sample index + tests.
