# Chunk C9-vertical-slice: First conformant vertical slice: acceptance and release baseline

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Needs: C6, C7, C8._

**Core rules:** attach `01-core.md` too.

**Read only:** all CCIS test files; `ccis/SPEC.md`; `CHANGELOG.md`.

**Build:**
1. Write `test/ccis-slice.test.js` covering the Ch9 definition of done end to end: author (code route) → validate → publish → import a real server case envelope → resolve compatibility → run → store → read back → rerun from the stored snapshot gives identical output. Include invalid-package and incompatible-context paths.
2. Package execution cannot reach undeclared network/filesystem/patient data (negative tests).
3. Freeze CCIS 0.1.0: tag in `CHANGELOG.md`, list known limitations, record what the slice did NOT prove.
4. Ask the user to review the limitations list before D-series starts.

**Done when:** a developer can run the whole slice with one command and reproduce the result; baseline frozen.

**Size guard:** 1 test file + docs. Fix findings in new rows; do not widen scope.
