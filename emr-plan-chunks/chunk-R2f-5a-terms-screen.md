# R2f-5a: Local terms screen (docs, written before the build)

Split from R2f-5 (size guard). R2f-5b (local term picker in the Create-screen binding rows) follows and needs this row.

- New classic script `modules/75-terms.js` (loads after `70-review.js`, before the inline script). Same style as `70-review.js`: top-level constants only, page functions called when used, all text escaped, no inline handlers (`data-act` / `data-arg`).
- New tab "Local terms" (`navTerms`, hidden until sign-in, shown to anyone with `terms:read`) and pane `terms` with `termsBox`.
- List: the server's `GET /api/local-terms` (latest version per code): code, version, display, category, definition, status, author. The page never calculates status.
- Add: code, display, category, definition. Sends only those four fields (author, status, version never sent). The same form adds a new version of an existing code; the server decides (409 if a version is still open). Shown to `terms:write` only.
- Buttons by status, from the permission only (the server decides and its message is shown): draft: Submit (`terms:submit`); in review: reason box + Approve / Reject (`terms:review`; the page hides them on a term you wrote and says why); approved: Publish (`terms:publish`); published: Retire (`terms:publish`). Approve and reject need a reason (no request without one). Every step asks for confirmation. Rejected and retired are final.
- Signed out: tab hidden, list cleared, no request. 409 or any refusal reloads the list and shows the message.
- Not in this row: the picker, any change to bindings, lint, export or the code-system registry. Context impact: none.
