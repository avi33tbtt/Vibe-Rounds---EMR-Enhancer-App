# Chunk B2r-review-on-versions: Re-point the review workflow (8a–8d) at server versions

_Added 2026-11-22. 8b/8c were built on browser snapshots; once sets live on the server (B2a) the snapshot table is redundant. Needs: B2a, 8a–8d done._

**Core rules:** attach `01-core.md` too.

**Read only:** `lint.js` (8a); the 8b/8c routes and migration; `sets.js` (B2a); `test/safety-routes.test.js`.

**Build:**
1. Make 'submit for review' act on a draft `element_set_version` (status draft → in_review → approved/rejected) instead of a separate snapshot table; lint runs on the server on submit.
2. Migrate existing `set_versions` rows into versions (additive migration; never edit old ones); keep the old table read-only, then mark it deprecated in `DECISIONS.md`.
3. Reviewer rules from 8c (reviewer is not the author, session-derived) apply unchanged; tier badges in the UI read the version status.

**Done when:** review works on server versions; old snapshots remain readable; reviewer rules tests pass unchanged.

**Size guard:** 1 migration + route edits + tests. If more than 3 route files change, split.
