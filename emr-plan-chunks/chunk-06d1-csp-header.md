# Chunk 06d1-csp-header: CSP header with per-response nonce (server half)

_Part 1 of 6d, split from `chunk-06d-csp.md`. Decision recorded 2026-11-22: option A (delegated listener, no inline handlers)._

**Core rules:** attach `01-core.md` too.

**Read only:** `app.js` (header middleware), `test/safety-hardening.test.js`, `test/safety-browser.test.js`; `emr-enhancer.html`: only `grep -n "<script"`.

**Build:**
1. Generate a nonce per response; send `Content-Security-Policy`: `default-src 'self'`; `script-src 'self' 'nonce-…'`; `object-src 'none'`; `base-uri 'self'`; `frame-ancestors 'none'`; `connect-src 'self'` plus the configured terminology host.
2. TEMPORARY: while inline handlers still exist, add `'unsafe-hashes'` only for `script-src-attr` (marked with a TODO test that 6d-2c must flip). Inject the nonce into the 2 `<script>` blocks when serving the page.
3. Tests: header present on page and API responses; nonce differs per response; page works in jsdom; real-Chrome smoke test passes; a stored `<script>` without nonce does not run.

**Done when:** responses carry the CSP, the app still works, inline `<script>` is blocked, and the temporary `unsafe-hashes` rule has one test.todo that fails the moment it is removed.

**Size guard:** `app.js` + page serve code + 1 test file. If the page cannot be served with a nonce without a template step, STOP and add a row.
