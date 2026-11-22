# Chunk 08c: Reviewer rules and frozen approved version

_Rest of original chunk 08._

**Core rules:** attach `01-core.md` too.

**Read only:** Routes/migration from 8b, `permissions.js`, `seed.js`, `lint.js` (`needsTwoReviewers`).

**Build:**
1. Add role `informatician` (and a demo user in `seed.js`) with permission `sets:review`.
2. Approve/reject endpoints with a reason. Server checks: reviewer is not the author; a set flagged `needsTwoReviewers` needs two different reviewers; reviewer id and time come from the server.
3. Approved version immutable: a database trigger refuses UPDATE/DELETE of an approved row's content; editing creates a new draft row with version + 1.
4. Tests: author cannot approve own set; rules set needs two different reviewers; the same reviewer twice is refused; an approved version cannot be changed, also by direct SQL as the app role.

**Done when:** author cannot approve own set; a set with rules needs two different reviewers; approved version cannot be changed.

**Size guard:** Routes, one migration for the trigger and the role, tests.
