# Chunk 06 — Security hardening

**Build:**
1. Content-security policy and output escaping everywhere user text is rendered (the demo uses innerHTML in places).
2. Restricted database role (no DDL, no delete on clinical tables).
3. Secure cookie flags, security headers, rate limits on login and write routes.
4. Retention, subject-access and consent notes (a short policy file, not code).
**Done when:** a stored `<script>` in a note or label does nothing; the app user cannot DROP or DELETE clinical rows; headers verified with a scanner.
