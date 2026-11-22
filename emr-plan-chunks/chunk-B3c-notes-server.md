# Chunk B3c-notes-server: Notes and signing on the server

_Ch5 slice B3, notes. Closes known gaps (a) and (d) for notes. Needs: B3a, 8e done._

**Core rules:** attach `01-core.md` too.

**Read only:** `test/safety-data.test.js` (note rules and the todo tests); `emr-enhancer.html`: `grep -n "signNote\|amendNote\|note"`; `cases.js`.

**Build:**
1. Migration: `case_notes` (case_id, encounter_id nullable, author_id, body, status draft|signed, signed_at, signed_by) and `case_note_amendments` (note_id, reason NOT NULL, body, amended_by, amended_at). Signed note immutable by trigger; amendment requires a reason; author/signer only from the session. In the same migration grant `emr_app` only what the code uses (no DELETE/TRUNCATE; add `forbid_change()` triggers on clinical tables); the grants test must still pass.
2. Routes: create/edit draft, sign, amend with reason, list. Stale edits give 409. Update the permission matrix and audit scenarios in `test/safety-routes.test.js` on purpose; a new route fails the build until you do.
3. Page: notes use the adapter; remove the typed-signer path entirely if 8e left any.
4. Convert the signed-note and stale-version `test.todo` items into server-side tests.

**Done when:** a signed note cannot be changed by any route; amendments keep the original and the reason; no todo remains for (a) and (d).

**Size guard:** 1 migration, 1 routes file, page note code, tests. Split into B3c-1 (server) and B3c-2 (page) if the page diff exceeds about 200 lines.
