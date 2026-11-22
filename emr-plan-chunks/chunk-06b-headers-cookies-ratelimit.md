# Chunk 06b: Security headers, Secure cookie, rate limits

_Part 3 of original chunk 06._

**Core rules:** attach `01-core.md` too.

**Read only:** `app.js`, `auth.js`, `test/safety-routes.test.js` (the permission matrix must keep passing), `test/helpers.js`.

**Build:**
1. Headers: `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and `Strict-Transport-Security` only when the deployment is HTTPS (env flag). `nosniff` and `no-store` already exist. No CSP here.
2. Cookie: add `Secure` when HTTPS is flagged (and handle `trust proxy` for a reverse proxy). Keep HttpOnly and SameSite=Strict.
3. Rate limits: login (per IP and per username) and write routes (per session). Answer 429, write an audit row. In-memory limiter, no new dependency; note in the reply that more than one server instance needs a shared store.
4. Tests: the Nth request gets 429; headers present; Set-Cookie has Secure when flagged.

**Done when:** limits trigger and are audited; headers and cookie flags verified in tests.

**Size guard:** `app.js`, `auth.js`, at most one new module, one test file. If you add a route, update the permission matrix test on purpose.
