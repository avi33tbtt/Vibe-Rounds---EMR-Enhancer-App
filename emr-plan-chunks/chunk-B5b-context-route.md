# Chunk B5b-context-route: Context route, export log, permission, audit

_Needs: B5a._

**Core rules:** attach `01-core.md` too.

**Read only:** `permissions.js`; `cases.js`; `audit.js`; `test/safety-routes.test.js`; `context.js` from B5a.

**Build:**
1. Migration (next free number): `context_exports` (case_id, envelope_sha256, purpose, exported_by from session, exported_at server time). Append-only: `forbid_change()` trigger, grants without UPDATE/DELETE/TRUNCATE for `emr_app`.
2. Permission `context:read` (admin, doctor). Route `GET /api/cases/:id/context?purpose=` returns the envelope as a downloadable JSON file; unknown purpose rejected; audit logs counts and the hash only, never content.
3. Add a "Download context envelope" button to the case screen (all text through the escaper, no inline handlers).
4. Update the permission matrix and audit scenarios on purpose.

**Done when:** a doctor downloads an envelope, an export row with its hash exists, a nurse is refused.

**Size guard:** 1 migration, 1 route, 1 button, tests. Split page button off (B5c) if large.
