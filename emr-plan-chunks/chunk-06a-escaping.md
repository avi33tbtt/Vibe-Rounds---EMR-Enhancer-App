# Chunk 06a: Escape all user text in the page

_Part 1 of original chunk 06 (output escaping)._

**Core rules:** attach `01-core.md` too.

**Read only:** `emr-enhancer.html` via `grep -n innerHTML` (37 lines use it) and `grep -n escA`; `test/safety-content.test.js`; `test/html.js`. Do not read the whole page.

**Build:**
1. List every `innerHTML` site that renders text a user or the server can supply (set titles, field labels, options, notes, patient names, audit rows, AI preview). Write the list in your reply.
2. One shared text escaper (the page has `escA` for attributes; check whether text sites are escaped at all). Apply it at each site, or use `textContent` where simpler.
3. Tests with hostile strings (`<script>`, `<img onerror=...>`, `"><svg onload=...>`) stored in a set title, a field label, an option, a note body and a patient name. Each must render as visible text and run nothing (jsdom).

**Done when:** a stored `<script>` in a note or label does nothing, proven by the test.

**Size guard:** Page plus one test file. Do NOT add a Content-Security-Policy here (that is 6d).
