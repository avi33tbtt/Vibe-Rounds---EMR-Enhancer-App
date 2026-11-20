# Phase H: tests, security, deploy

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 26. Phase H: tests, security, deploy

*Hardening before any real use. The release gates here are the ones in 3.2 rows 7 and 8.*

### 39. Tests

#### [ ] 39a1. Permission matrix gaps
**Paste:** file names of existing tests only
```text
No code changes. Tell me what role x route cases the existing matrix test might miss and give only the new test blocks needed.
```

#### [ ] 39a2. Concurrency tests
**Paste:** the rows append route
```text
Tests: 10 parallel row appends all succeed; two edits with the same version give exactly one 409.
```

#### [ ] 39a3. Audit coverage gaps
**Paste:** the audit-coverage test list
```text
List write routes missing from the audit-coverage test and add them. Tests only.
```

#### [ ] 39a4. npm scripts
**File:** package.json | **Paste:** package.json
```text
Add scripts test:server and test:safety (pattern match on file names). Do not move files.
```

#### [ ] 39b1. Safety: seed sets
**Paste:** a loader snippet for element-sets.js
```text
New safety.test.js block: every seed set has zero rules, thresholds, bands, defaults and limits.
```

#### [ ] 39b2. Safety: rules that never fire
**Paste:** evalRules, how tests load cds-rules.js
```text
Add tests: unapproved rule never fires; unit-mismatched rule never fires; disabled never fires.
```

#### [ ] 39b3. Safety: bundle contents
**Paste:** buildBundle (first 30 lines)
```text
Add tests: bundle has no protocol bands, no fever thresholds, no rule text.
```

#### [ ] 39b4. Safety: doses and errors
```text
Add tests: no function sums or converts dose text (search the code for banned patterns in a test); entered_in_error rows are hidden in the UI data but present in the database.
```

#### [ ] 39b5. Migration test
**Paste:** migration runner
```text
migration.test.js: fresh database runs all migrations; upgrade from the previous migration works.
```

#### [ ] 39c1. Playwright: install and login
```text
Add Playwright as a dev dependency and one test: open app, log in as a seeded test user, see the banner.
```

#### [ ] 39c2. Playwright: new patient and a vitals row
**Paste:** element ids from the New patient dialog and vitals entry
```text
Extend: register a patient, start an encounter, add a vitals row, see it in the table.
```

#### [ ] 39c3. Playwright: conflict
```text
Extend: two browser contexts edit one row; second save shows the conflict screen.
```

#### [ ] 39c4. CI workflow
**Paste:** package.json scripts
```text
Add .github/workflows/ci.yml: PostgreSQL service, npm ci, test:server, test:safety, Playwright. Add script test:all.
```

### 40. Security

#### [ ] 40a1. Find every unescaped insertion (list only)
**Paste:** output of `grep -n "innerHTML" enhancer.html`
```text
Do not fix anything. From these lines, list which insert a user-controlled string (narrative, notes, set titles, rule text, patient names, error messages) without escaping. Group them in three batches.
```

#### [ ] 40a2. esc() helper and batch 1
**Paste:** the batch 1 lines
```text
Add one esc() helper (if missing) and fix batch 1.
```

#### [ ] 40a3. Batch 2 (same prompt, batch 2 lines)
#### [ ] 40a4. Batch 3 (same prompt, batch 3 lines)

#### [ ] 40a5. XSS test
```text
Add a test or checklist: put <img src=x onerror=alert(1)> into every free-text field and confirm it is inert.
```

#### [ ] 40a6. CSP plan (no code)
**Paste:** server.js static serving
```text
Do not change code. Recommend nonces vs moving inline script/style to files for this repo, with the exact steps and risks.
```

#### [ ] 40a7. CSP implement
**Paste:** server.js static serving, the chosen plan
```text
Implement the chosen CSP approach in the smallest change. Say what I must test by hand.
```

#### [ ] 40b1. Headers, HSTS, body limits
**File:** server.js | **Paste:** server.js middleware section
```text
Add security headers, HSTS (behind proxy), body size limits. No other change.
```

#### [ ] 40b2. SQL review (one file per chat: api.js / patients.js / auth.js)
**Paste:** that one file
```text
Review every query for parameterisation. List problems with line numbers and the fix.
```
Files: [ ] api.js  [ ] patients.js  [ ] auth.js  [ ] other

#### [ ] 40b3. DB roles migration
**Paste:** migration runner, existing role setup
```text
Migration + notes: migration role with DDL, app role without DDL, audit_log without UPDATE/DELETE for the app role.
```

#### [ ] 40b4. Cookies and session fixation
**Paste:** session code in auth.js
```text
Check cookie flags and that a new session id is issued at login. Fix only what is wrong.
```

#### [ ] 40b5. npm audit
```text
I paste `npm audit` output; list which findings matter and the safest upgrade for each.
```

#### [ ] 40c1. Retention note (doc only)
```text
Write RETENTION.md: retention setting suggestions; no automatic deletion of clinical data.
```

#### [ ] 40c2. Subject-access export (server)
**Paste:** patients routes list, audit.js
```text
Admin-only route returning one patient's data as JSON, audited, following mergedInto. Action + test.
```

#### [ ] 40c3. Consent field (server)
**Paste:** patients table, create/update routes
```text
Optional consent fields on patients (migration + API + test). Not required unless a setting says so.
```

#### [ ] 40c4. Consent field (screen)
**Paste:** the Find or register dialog form
```text
Show the consent fields only when the setting is on.
```

#### [ ] 40c5. Regulatory checklist (doc only)
```text
Write REGULATORY-CHECKLIST.md: what I must confirm for health-data law, medical-device-software and national digital health rules where this runs, and the top 10 risks. No legal conclusions.
```

### 41. Deploy

#### [ ] 41a1. Dockerfile
**Paste:** package.json, server.js start lines
#### [ ] 41a2. docker-compose.prod.yml
#### [ ] 41a3. TLS reverse proxy config (Caddy or nginx)
#### [ ] 41a4. `.env.example` list and MIGRATING.md steps
```text
(one file per task) Produce only this file, root level, minimal. No clinical changes.
```

#### [ ] 41b1. backup.sh (pg_dump, encrypt, retention)
#### [ ] 41b2. restore.sh
#### [ ] 41b3. RESTORE-TEST.md (restore to clean DB, run test:safety, compare row counts)
#### [ ] 41b4. Health check, uptime alert idea, log rotation
**Done when (release gate):** a backup restores onto a clean database and the app reads it.

#### [ ] 41c1. DOWNTIME.md (paper forms; back-entry records original time and entry time)
#### [ ] 41c2. GOLIVE.md (named clinician review, training, synthetic pilot, limited real use, banner removed only after sign-off)
