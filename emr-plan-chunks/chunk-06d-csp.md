# Chunk 06d: Content-Security-Policy

_Part 1 of original chunk 06 (CSP half). Do after 6a._

**Core rules:** attach `01-core.md` too.

**Read only:** `emr-enhancer.html`: `grep -n "<script"` (2 blocks) and `grep -c " onclick="`-style counts (about 93 inline `on*=` handlers); the header middleware in `app.js`; `test/safety-browser.test.js`.

**Build:**
1. FIRST, before editing, reply with a short recommendation and wait for the user's choice: (A) replace the 93 inline handlers with one delegated listener using `data-act` attributes (clean, large edit, may need two sessions: split it), or (B) a CSP with a per-response nonce plus `'unsafe-hashes'` for the handlers (small edit, weaker).
2. Then implement: `default-src 'self'`; `script-src` with nonce (or hashes); `object-src 'none'`; `base-uri 'self'`; `frame-ancestors 'none'`; `connect-src 'self'` plus the configured terminology host (tx.fhir.org by default, it is configurable in the page).
3. Tests: header present; the page still works in jsdom; the real-Chrome smoke test still passes.

**Done when:** a response carries a CSP, the app still works, and a stored `<script>` cannot run even if escaping failed.

**Size guard:** If choice A, split into 6d-1 (server header + nonce) and 6d-2 (handler conversion in chunks of about 30 handlers) and record them as new rows.

**Notes:** Hardest piece of chunk 06. Do not start it in a session that is already half used.
