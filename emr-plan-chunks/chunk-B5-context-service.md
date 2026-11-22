# Chunk B5-context-service: Context service: minimal versioned context envelope

_Ch5 slice B5, the input contract for CCIS. Needs: B3a, B4._

**Core rules:** attach `01-core.md` too.

**Read only:** `CLINICAL_CONTEXT_MODEL.md`; `cases.js`, `sets.js`, observations routes; `deid.js` (existing de-identification rules).

**Build:**
1. Write `context.js`: assemble from case, pinned sets/pathways, observations (with status, source_type, effective/recorded times), events and uncertainty/provenance into a versioned envelope `{context_version, case_ref, items[], provenance[]}`. Patient identity and narrative are excluded by default.
2. Route `GET /api/cases/:id/context` (permission `context:read`), audited with a count only. Optional `purpose` parameter; unknown purposes rejected.
3. Tests: envelope excludes name, MRN, DOB and narrative; AI/derived values flagged; same case gives identical envelope bytes (deterministic ordering); entered-in-error excluded unless requested.
4. Update the permission matrix and audit scenarios in `test/safety-routes.test.js` on purpose; a new route fails the build until you do.

**Done when:** the envelope is deterministic, versioned and provably free of identity and narrative.

**Size guard:** 1 module, 1 route, tests.

**Notes:** This envelope is what C5a imports and what D8 exports in batch.
