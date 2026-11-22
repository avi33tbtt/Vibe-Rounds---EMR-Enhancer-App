# Chunk 06d2-handlers: Convert inline `on*=` handlers to one delegated listener

_Parts 2a, 2b, 2c of 6d. Same chunk file serves all three rows; each row converts a slice of about 30 handlers._

**Core rules:** attach `01-core.md` too.

**Read only:** `emr-enhancer.html`: `grep -n " on[a-z]*="` to list handlers; the existing event helpers; `test/ui.test.js`, `test/safety-browser.test.js`.

**Build:**
1. Add (2a only) one delegated listener on `document` for `click`, `change`, `input` using `data-act` and `data-arg` attributes; handler names map through one `ACT` table (no `eval`, no string-built code). Arguments go through the shared escaper/`jsA` rules already in the page.
2. Convert the next slice (2a: handlers 1–30, 2b: 31–62, 2c: the rest) top to bottom. After each slice run the page tests; keep behaviour identical.
3. 2c only: remove the temporary `'unsafe-hashes'` from the CSP, flip the 6d-1 test.todo into a real test, and add a test that a page containing `grep -c " on[a-z]*="` returns 0 handlers.

**Done when:** slice converted, tests pass, and (2c) the CSP has no `unsafe-hashes` and the page has zero inline handlers.

**Size guard:** About 30 handlers per row. If a slice needs more than that or touches rendering logic, split into 2a-1/2a-2 instead of continuing.

**Notes:** Do not refactor rendering code in the same session. Behaviour must not change.
