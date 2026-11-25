# R2f-5b: local term picker in the Create-screen binding rows (docs, written before the build)

Split from R2f-5 (size guard). Needs R2f-5a (done). Unblocks the optional code field of R1e.

- Binding rows on the Create screen get a "Pick term" button, visible only while the row's system is `local`. It lists PUBLISHED local terms from `GET /api/local-terms?status=published` (search box, one list open at a time). "Use" fills code and display and remembers the term version.
- The saved binding is `{system:'local', code, display, source, version}` (`version` is a string, as `term-verify.js` expects). The version is kept only while code and display still equal the picked term; editing either, or changing the system, drops it. A hand-typed local code stays allowed and stays unverified (server lint decides at submit).
- Nothing changes in export: local bindings are never FHIR Coding (`bst` returns unverified for a system without a verifier). The picker never stores terms in the browser.
- Signed out or no `terms:read`: no request, a short message. Draft, in-review, rejected and retired terms are never offered. All text is escaped; no inline handlers.
- Code lives in `modules/75-terms.js` (same area as the Local terms screen) plus 4 ACT entries and about 6 lines in `addBindRow`, `polRefresh` and `saveElement`. Context impact: none.
