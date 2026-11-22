# Chunk C5a-runtime-import: Runtime: import a context envelope

_Ch9. CCIS libraries are pure JS with no database access (decision 2026-11-22) so they can move to a separate repo later. Phase 3. Needs: B5, C4._

**Core rules:** attach `01-core.md` too.

**Read only:** `context.js` (B5); `ccis/fixtures/`.

**Build:**
1. Write `ccis-runtime.js` part 1: `importContext(envelope)` validates the B5 envelope version, normalises units, keeps source_type and status, rejects entered-in-error by default, and returns a canonical patient context with an input trace.
2. No network, no file access, no clock reads: the evaluation time is an input.
3. Tests with the C2a fixtures.

**Done when:** fixture envelopes import deterministically with a trace.

**Size guard:** 1 module + tests.
