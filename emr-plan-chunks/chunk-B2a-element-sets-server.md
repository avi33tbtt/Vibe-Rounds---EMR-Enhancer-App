# Chunk B2a-element-sets-server: Versioned element sets (server)

_Ch5 slice B2, server half. Needs: B1a._

**Core rules:** attach `01-core.md` too.

**Read only:** `CLINICAL_CONTEXT_MODEL.md`; `migrations/` (list); `app.js` pattern; `sdc.js` exports (schema of a set); `test/safety-routes.test.js`.

**Build:**
1. Migration: `element_sets` (id, slug, title, kind disease|care|template|custom, status), `element_set_versions` (element_set_id, version, schema_version, definition_json, checksum, status draft|reviewed|published|retired, created_by, published_by…), UNIQUE(element_set_id, version). Immutable once published: a trigger rejects UPDATE of definition_json/checksum after publish. In the same migration grant `emr_app` only what the code uses (no DELETE/TRUNCATE; add `forbid_change()` triggers on clinical tables); the grants test must still pass.
2. Routes (new file `sets.js`): list, read, create draft version, publish (permission `sets:publish`, informatician/admin), retire. Checksum computed on the server (sha256 of canonical JSON). Content stays declarative data only; no executable code accepted.
3. Update the permission matrix and audit scenarios in `test/safety-routes.test.js` on purpose; a new route fails the build until you do.
4. Tests: published version cannot be edited; new version increments; checksum mismatch rejected; unknown kind rejected; forged published_by ignored.

**Done when:** a set can be created, versioned and published; a published version is immutable at database level.

**Size guard:** 1 migration, 1 routes file, tests. Import of demo library is B2b.
