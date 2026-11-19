# EMR Enhancer: Micro Plan (free-tier edition)

*19 Nov 2026. Repo: github.com/avi33tbtt/Vibe-Rounds---EMR-Enhancer-App. Replaces the chunk list in `emr-enhancer-remaining-plan.md` from 37c onward. Chunks 1-37c are built. Data contracts v5-v7 stay in the old plan file as reference; each task below carries the few facts it needs, so you rarely paste a contract.*

**Next up: 37d3**

---

## 1. Why the old chunks used up your limit, and the fix

Your limit is spent on three things: (1) what you paste in, (2) what Claude writes back, (3) how long the chat runs. A "300 line" chunk touching a big file does all three at once. So every task below is:

- **One file, one concern.** Usually 30-90 new lines.
- **Tiny paste.** One function or one route, never a whole file. Use `grep -n "functionName" enhancer.html` and `sed -n 'START,ENDp' enhancer.html` to copy only that block.
- **Edits only.** Never ask for a full `enhancer.html` back. It is the single biggest limit-burner. Ask: "Return only the changed functions, with the exact old line to find and the new text."
- **Code and tests split.** The task makes the change; the next task (when listed) adds its tests. If you are tight, run the tests you already have and add new tests later.
- **One task per chat. Stop when it is done.** Do not carry on into the next task in the same chat.

If a task still hits the limit, split it in half yourself: finish what fits, commit, then start a new chat with "continue: <what is left>".

## 2. The routine (about 5 minutes of setup per chat)

1. New chat.
2. Paste the **Context block** (section 3) once.
3. Paste the task's prompt (the code block) and only the code named on its **Paste** line.
4. Apply the edits, run `npm test`, commit.
5. Tick the box here and move to the next task.

**Handover line** (paste at the end of any chat that ran out before finishing, then start fresh with it):

> Task <id> partly done. Done: <1 line>. Left: <1 line>. Files changed: <names>.

## 3. Context block (paste at the start of every chat)

```text
Project: EMR Enhancer. Node + Express + PostgreSQL 16, all files in repo root (no folders), single-file client enhancer.html, element-sets.js, cds-rules.js, store.js (window.Store, cache-first), api.js, permissions.js (can(user, action), ROUTE_ACTIONS), audit.js, numbered migrations, node:test + supertest. Demo mode (localStorage) must keep working. Rules: no pre-filled doses/thresholds/bands; doses are free text, never calculated or summed; AI drafts only; unapproved rules never fire; data shown as recorded, no judgement of care; every write carries the version last seen (409 on conflict) and writes one audit row in the same transaction; follow mergedInto for patients; keep the "Not for clinical use" banner; new routes need an action in permissions.js and an entry in the audit-coverage test.
Reply format: edits only (exact old text to find + new text), never whole files. Under ~90 new lines. If more is needed, stop and list what is left.
```

## 4. Open decisions (answer before the task that needs them, or accept the default)

| # | Default | Needed by |
|---|---|---|
| 1 | Locked-account sign-in attempts are not logged | 40b |
| 2 | Admin may chart, approve and sign | 39 |
| 3 | Informatician cannot open patients | 44, 46 |
| 6 | Patient searches not audited; opening a record is | 40c |
| 8 | Audit CSV omits before/after contents | 40c |
| 9 | Reference-data conflicts offer only "Reload the app" | 37a done |
| 10 | Two reviewers for packages with rules | 44a2d |

## 5. Manual jobs that are not tasks (no Claude needed)

- [ ] Force a conflict on one row in two browsers; confirm the side-by-side screen.
- [ ] Idle a session out with an unsent reading; sign in again; confirm it is sent.
- [ ] As admin run Settings > Import from this browser; confirm a doctor does not see it.
- [ ] `git rm env.example` (keep `.env.example`).

---

# PHASE 5 (continued): standalone EMR

## 37c. Ward 3: shift summary and ward board

### [x] 37c1. Shift sum: pure function
**File:** enhancer.html | **Paste:** how a flowsheet row looks (one example row), the `care.intake_output` entry
```text
Add one pure function sumByType(rows, fromMs, toMs) returning {type: number} summed from io_volume for rows whose io_time is in the window and whose status is active (skip entered_in_error). Plain numbers only, no targets. Add a 5-case test (vm or node) for window edges and entered_in_error.
```
**Done when:** test passes; function not yet shown anywhere.

### [x] 37c2. Shift sum: show it on the I/O flowsheet
**File:** enhancer.html | **Paste:** the flowsheet table renderer (just its head and foot), sumByType
```text
Under the I/O flowsheet table show a small block "Sum of entered rows" with a window choice (last 8 h, 12 h, 24 h) and one line per type from sumByType. Label it "sum of entered rows". No comparison, no colours, no target. Show nothing for other sets.
```

### [x] 37c3. Ward board: row data function
**File:** enhancer.html | **Paste:** the Patients row renderer, ageTxt, how pinned direct sets are read
```text
Add boardRow(patientCase) returning {name, mrn, ward, bed, cells:[{setTitle, latest, ageText}]} for the pinned direct sets, using patientView(c) and ageTxt. No flags, no colours. Do not change the renderer yet.
```

### [x] 37c4. Ward board: screen
**File:** enhancer.html | **Paste:** the Patients screen render function, boardRow
```text
On the Patients screen add a ward filter (wards from open encounters) and render rows from boardRow with one column per pinned direct set: latest value and its age. Keep the row renderer in one function. Server mode only; Demo mode unchanged.
```

### [x] 37c5. Ward board: "no reading for N minutes"
**File:** enhancer.html | **Paste:** evalRules signature, one approved minutes_since_gt rule example, boardRow
```text
In a board cell, show "No reading for N min" only when an approved, enabled minutes_since_gt rule exists for that set and its condition is true now. Use evalRules; never invent N. Without such a rule the cell shows only latest value and age.
```
**Done when:** with no rule, no "no reading" text appears anywhere.

## 37d. Ward 4: handover view

### [x] 37d1. Handover data function
**File:** enhancer.html | **Paste:** Summary helpers, notes functions, alertLog/acks reader
```text
Add handoverData(case, sinceMs) returning {narrative, pathways, latest:[{set, value, ageText}], acks24h, newRows}. newRows = rows entered after sinceMs. No judgement text. Pure function, no rendering.
```

### [x] 37d2. Handover view: render
**File:** enhancer.html | **Paste:** handoverData, how a tab/view is added in the dispatcher
```text
Add a Handover view per patient rendering handoverData as simple sections. Display only.
```

### [ ] 37d3. Handover: print layout
**File:** enhancer.html (CSS only) | **Paste:** the Handover render block
```text
Add @media print CSS: A4, one patient per page, hide nav, buttons and every interactive control. Keep the "Not for clinical use" banner visible when printing.
```

### [ ] 37d4. Handover: last-handover time (server)
**Files:** api.js + one migration only if needed | **Paste:** the user_prefs routes
```text
Store a per-user "last handover" time per case in user_prefs (set by a POST that uses server time, read by GET). Add the action to permissions.js and the audit-coverage test.
```

### [ ] 37d5. Handover: button
**File:** enhancer.html + store.js | **Paste:** Store prefs methods, Handover render
```text
Add "Mark handover done" button in the Handover view using the 37d4 route; handoverData's sinceMs comes from it (default: start of the encounter).
```

---

## 38. Shared analytics

### [ ] 38a0. List the analytics cards (no code)
**Paste:** the ana() function (or just its card names and which case fields each reads)
```text
Do not write code. List every card ana() produces, the inputs each reads, and group them into 3-4 groups of similar cards. This list drives 38a3.
```
**Done when:** you have the card list saved in this file under 38a3.

### [ ] 38a1. Filters helper (server)
**File:** api.js | **Paste:** one existing list route's query parsing
```text
Add parseScopeFilters(query) returning {scopeType, scopeId, from, to, ward} with validation (bad value -> 400). Pure function + 6 tests. No route yet.
```

### [ ] 38a2. First aggregate endpoint
**Files:** api.js, permissions.js | **Paste:** the simplest card's code from ana(), parseScopeFilters
```text
Add GET /api/analytics/<card> for the simplest card only, aggregates only (no patient list), using parseScopeFilters. Add the action, and a fixture test that the numbers equal the old client computation for the same fixture.
```

### [ ] 38a3. Remaining cards (repeat once per group from 38a0)
**Paste:** that group's card code + the 38a2 endpoint as a model
```text
Add one endpoint per card in this group, same pattern as 38a2, with a fixture test per card.
```
Groups: [ ] A  [ ] B  [ ] C  [ ] D

### [ ] 38a4. Client ana() calls the endpoints
**File:** enhancer.html | **Paste:** ana() and one card renderer
```text
In server mode, ana() fetches each card from its endpoint (through Store); Demo mode keeps the local computation and the synthetic-case buttons. Show loading and error text.
```

### [ ] 38a5. Patient lists need doctor or admin
**Files:** api.js, permissions.js | **Paste:** the drill-down code if any
```text
Make sure any route returning patient lists from analytics needs doctor or admin; others return aggregates only. Add a role-matrix test line for each.
```

### [ ] 38b1. Masking function
**File:** api.js (or a new root file masking.js if cleaner) | **Paste:** nothing
```text
Pure function maskCounts(table, {min:5}) turning cells under 5 into '<5' and masking one more cell in a row or column when a single masked cell could be recovered from a total. 10 tests.
```

### [ ] 38b2. Apply masking to endpoints
**File:** api.js | **Paste:** one endpoint, maskCounts
```text
Pass every analytics endpoint result through maskCounts. Test that a count of 3 never appears as 3.
```

### [ ] 38b3. De-identified CSV export (server)
**Files:** api.js, audit.js | **Paste:** the rules-inforce CSV code (formula-safe model)
```text
GET /api/analytics/export.csv: masked aggregates, no name, MRN, phone, national id; dates as days since encounter start; formula-safe; one audit row with the filter used. Action + tests.
```

### [ ] 38b4. De-identified FHIR export
**Files:** api.js | **Paste:** buildBundle
```text
Same rules as 38b3 for a FHIR bundle of the filtered cases: no identifiers, no exact dates, audited with its filter. Tests that no identifier string appears.
```

### [ ] 38b5. Export buttons
**File:** enhancer.html | **Paste:** analytics toolbar code
```text
Add two buttons (CSV, FHIR) to analytics, visible only if Store.can for the action. Plain messages for errors.
```

---

## 39. Tests

### [ ] 39a1. Permission matrix gaps
**Paste:** file names of existing tests only
```text
No code changes. Tell me what role x route cases the existing matrix test might miss and give only the new test blocks needed.
```

### [ ] 39a2. Concurrency tests
**Paste:** the rows append route
```text
Tests: 10 parallel row appends all succeed; two edits with the same version give exactly one 409.
```

### [ ] 39a3. Audit coverage gaps
**Paste:** the audit-coverage test list
```text
List write routes missing from the audit-coverage test and add them. Tests only.
```

### [ ] 39a4. npm scripts
**File:** package.json | **Paste:** package.json
```text
Add scripts test:server and test:safety (pattern match on file names). Do not move files.
```

### [ ] 39b1. Safety: seed sets
**Paste:** a loader snippet for element-sets.js
```text
New safety.test.js block: every seed set has zero rules, thresholds, bands, defaults and limits.
```

### [ ] 39b2. Safety: rules that never fire
**Paste:** evalRules, how tests load cds-rules.js
```text
Add tests: unapproved rule never fires; unit-mismatched rule never fires; disabled never fires.
```

### [ ] 39b3. Safety: bundle contents
**Paste:** buildBundle (first 30 lines)
```text
Add tests: bundle has no protocol bands, no fever thresholds, no rule text.
```

### [ ] 39b4. Safety: doses and errors
```text
Add tests: no function sums or converts dose text (search the code for banned patterns in a test); entered_in_error rows are hidden in the UI data but present in the database.
```

### [ ] 39b5. Migration test
**Paste:** migration runner
```text
migration.test.js: fresh database runs all migrations; upgrade from the previous migration works.
```

### [ ] 39c1. Playwright: install and login
```text
Add Playwright as a dev dependency and one test: open app, log in as a seeded test user, see the banner.
```

### [ ] 39c2. Playwright: new patient and a vitals row
**Paste:** element ids from the New patient dialog and vitals entry
```text
Extend: register a patient, start an encounter, add a vitals row, see it in the table.
```

### [ ] 39c3. Playwright: conflict
```text
Extend: two browser contexts edit one row; second save shows the conflict screen.
```

### [ ] 39c4. CI workflow
**Paste:** package.json scripts
```text
Add .github/workflows/ci.yml: PostgreSQL service, npm ci, test:server, test:safety, Playwright. Add script test:all.
```

---

## 40. Security

### [ ] 40a1. Find every unescaped insertion (list only)
**Paste:** output of `grep -n "innerHTML" enhancer.html`
```text
Do not fix anything. From these lines, list which insert a user-controlled string (narrative, notes, set titles, rule text, patient names, error messages) without escaping. Group them in three batches.
```

### [ ] 40a2. esc() helper and batch 1
**Paste:** the batch 1 lines
```text
Add one esc() helper (if missing) and fix batch 1.
```

### [ ] 40a3. Batch 2 (same prompt, batch 2 lines)
### [ ] 40a4. Batch 3 (same prompt, batch 3 lines)

### [ ] 40a5. XSS test
```text
Add a test or checklist: put <img src=x onerror=alert(1)> into every free-text field and confirm it is inert.
```

### [ ] 40a6. CSP plan (no code)
**Paste:** server.js static serving
```text
Do not change code. Recommend nonces vs moving inline script/style to files for this repo, with the exact steps and risks.
```

### [ ] 40a7. CSP implement
**Paste:** server.js static serving, the chosen plan
```text
Implement the chosen CSP approach in the smallest change. Say what I must test by hand.
```

### [ ] 40b1. Headers, HSTS, body limits
**File:** server.js | **Paste:** server.js middleware section
```text
Add security headers, HSTS (behind proxy), body size limits. No other change.
```

### [ ] 40b2. SQL review (one file per chat: api.js / patients.js / auth.js)
**Paste:** that one file
```text
Review every query for parameterisation. List problems with line numbers and the fix.
```
Files: [ ] api.js  [ ] patients.js  [ ] auth.js  [ ] other

### [ ] 40b3. DB roles migration
**Paste:** migration runner, existing role setup
```text
Migration + notes: migration role with DDL, app role without DDL, audit_log without UPDATE/DELETE for the app role.
```

### [ ] 40b4. Cookies and session fixation
**Paste:** session code in auth.js
```text
Check cookie flags and that a new session id is issued at login. Fix only what is wrong.
```

### [ ] 40b5. npm audit
```text
I paste `npm audit` output; list which findings matter and the safest upgrade for each.
```

### [ ] 40c1. Retention note (doc only)
```text
Write RETENTION.md: retention setting suggestions; no automatic deletion of clinical data.
```

### [ ] 40c2. Subject-access export (server)
**Paste:** patients routes list, audit.js
```text
Admin-only route returning one patient's data as JSON, audited, following mergedInto. Action + test.
```

### [ ] 40c3. Consent field (server)
**Paste:** patients table, create/update routes
```text
Optional consent fields on patients (migration + API + test). Not required unless a setting says so.
```

### [ ] 40c4. Consent field (screen)
**Paste:** the Find or register dialog form
```text
Show the consent fields only when the setting is on.
```

### [ ] 40c5. Regulatory checklist (doc only)
```text
Write REGULATORY-CHECKLIST.md: what I must confirm for health-data law, medical-device-software and national digital health rules where this runs, and the top 10 risks. No legal conclusions.
```

---

## 41. Deploy

### [ ] 41a1. Dockerfile
**Paste:** package.json, server.js start lines
### [ ] 41a2. docker-compose.prod.yml
### [ ] 41a3. TLS reverse proxy config (Caddy or nginx)
### [ ] 41a4. `.env.example` list and MIGRATING.md steps
```text
(one file per task) Produce only this file, root level, minimal. No clinical changes.
```

### [ ] 41b1. backup.sh (pg_dump, encrypt, retention)
### [ ] 41b2. restore.sh
### [ ] 41b3. RESTORE-TEST.md (restore to clean DB, run test:safety, compare row counts)
### [ ] 41b4. Health check, uptime alert idea, log rotation
**Done when (release gate):** a backup restores onto a clean database and the app reads it.

### [ ] 41c1. DOWNTIME.md (paper forms; back-entry records original time and entry time)
### [ ] 41c2. GOLIVE.md (named clinician review, training, synthetic pilot, limited real use, banner removed only after sign-off)

---

# PHASE 6: content lifecycle and marketplace

Facts every Phase 6 chat needs: marketplace content is read-only and hash-pinned; hash = SHA-256 of canonical JSON of `content` (keys sorted, no whitespace); tiers are marketplace-verified, local-reviewed, local-draft; the server enforces read-only (the UI only mirrors it); reviewer is never the author; packages contain definitions only, never patient data.

## 42a. package-lint.js (new root file, browser + Node, ends with `if(typeof module!=='undefined')module.exports=...`)

### [ ] 42a1. canonicalJson and sha256Hex + tests
```text
Create package-lint.js with canonicalJson(obj) and async sha256Hex(text) (crypto.subtle or node:crypto), and package-lint.test.js: same hash when keys are in a different order. Nothing else.
```
### [ ] 42a2. lintPackage skeleton: manifest, semver, id pattern
**Paste:** the manifest shape (package file, 6 lines)
```text
Add lintPackage(pkg) returning {errors, warnings} with errors: bad manifest, bad semver, bad id pattern. One failing test per error plus one passing package.
```
### [ ] 42a3. Errors: unknown field type, content over 1 MB, key named eval or function
### [ ] 42a4. Errors: rule op not whitelisted, threshold not a finite number
**Paste:** whitelisted operators from cds-rules.js
### [ ] 42a5. Errors: band/rule/dose-like text without a references entry
### [ ] 42a6. Errors: patient-like strings (phone, long digit runs, "MRN", "patient name") with the path
### [ ] 42a7. Warnings: coding not in verified table, empty rationale, duplicate field ids
```text
(for 42a3-42a7, same prompt each time) Extend lintPackage with ONLY the listed checks and one failing test per check. Earlier tests must still pass.
```

## 42b. Tier badges and read-only

### [ ] 42b1. Registry fields with defaults
**Paste:** where registry entries are created/loaded
```text
Add source, readOnly, tier, forkedFrom, package to registry entries; old entries default to source seed/local, tier local-draft. No UI.
```
### [ ] 42b2. tierBadge(entry) helper and badge on set cards
### [ ] 42b3. Badge on the Pathway tab and '+ Add' list
### [ ] 42b4. readOnly sets render without edit controls (applying and entering values still allowed)
**Paste:** set card renderer / editor entry points
### [ ] 42b5. Guard the save functions for readOnly sets (not only the UI)
**Paste:** the set save functions
### [ ] 42b6. Server refuses PATCH/DELETE on read_only element_sets (403)
**Paste:** element_sets routes; add test
### [ ] 42b7. Fork to local copy
```text
New setId local.<slug>, version 1, tier local-draft, forkedFrom {setId, version, contentHash}; never changes the original. Editing a local-reviewed set makes a new draft version.
```

## 42c. Import package file and Provenance

### [ ] 42c1. Tools > Import package file: read JSON, run lintPackage, show errors/warnings
### [ ] 42c2. On success: recompute hash locally, store as marketplace, readOnly, tier marketplace-verified (Demo mode only)
### [ ] 42c3. buildBundle Provenance lists package id, version, contentHash, tier per applied set

## 43. Request a feature

### [ ] 43a1. "Request a feature" box and output choice (UI only)
### [ ] 43a2. Send the sentence plus registry ids/titles/field ids/units to the chunk-36 route; validate output (ids exist, operators whitelisted, thresholds appear in sentence, no doses, codes empty)
### [ ] 43a3. Save a valid draft as local-draft with provenance {requestText, model, at}; "My drafts" list
### [ ] 43b1. Run lintPackage live on a draft; plain-language errors
### [ ] 43b2. Block applying any unapproved draft to a real case (in code, with message); "Try it" only on Demo/synthetic
### [ ] 43b3. review_requests migration and submit route (status submitted, validated body)
### [ ] 43b4. "Submit for review" button (zero lint errors only); editing a submitted version creates a new version and withdraws the request
### [ ] 43b5. Tests: invalid AI output saves nothing; draft cannot be applied to a real case; submit refused with lint errors

## 44. Review (informatician)

### [ ] 44a1a. permissions.js for informatician (review and approve content, install packages, no charting) + role tests
### [ ] 44a1b. Queue route (submitted, in_review, changes_requested) + tests
### [ ] 44a1c. Get-one route re-running lintPackage on the server + tests
### [ ] 44a2a. Approve route: reviewer from session, freeze version as local-reviewed, review_events and audit_log in one transaction
### [ ] 44a2b. Rules/bands/dose-like text need two distinct approving reviewers (configurable, default 2)
### [ ] 44a2c. Request-changes and reject routes (comment required)
### [ ] 44a2d. Tests: author cannot review (403); one approval not enough; missing comment refused; rollback leaves no half rows
### [ ] 44b1. Tools > Review: queue list
### [ ] 44b2. Review page: request text, AI provenance, fields and rules in plain language, server lint result
### [ ] 44b3. Diff against previous version
### [ ] 44b4. Checklist (schemaValid automatic, others ticked, codesVerified vs verified_codes) and Approve / Request changes / Reject buttons
### [ ] 44c1. Tests: approved version immutable; edit after approval makes a draft; every action writes review_events and audit_log; informatician cannot chart

## 45. Registry repo (separate repo: emr-enhancer-registry; needs neither server nor app)

### [ ] 45a1. Layout: packages/<id>/<version>/package.json, README, CONTRIBUTING, LICENSE (MIT), CONTENT-LICENSE placeholder
### [ ] 45a2. CODEOWNERS, PULL_REQUEST_TEMPLATE (review checklist), three ISSUE_TEMPLATE files, GOVERNANCE stub
### [ ] 45b1. scripts/build-index.js
### [ ] 45b2. scripts/verify.js (+ tiny test): recompute hash and compare; refuse edits to merged version folders
### [ ] 45b3. .github/workflows/ci.yml (lint changed packages, check package-lint.js matches the app copy, rebuild index in a check job)
### [ ] 45c1. release.yml: ed25519 signing from secrets (node:crypto), publish index.json and index.json.sig, never commit a private key
### [ ] 45c2. withdrawn.json by PR with reason, shown in the index
### [ ] 45c3. Protection checklist (CODEOWNERS review, no force-push, no tag deletion, signed commits; check GitHub's current docs) and key rotation/loss notes in GOVERNANCE.md

## 46. Marketplace

### [ ] 46a1a. GET /api/market: fetch index and signature from one allow-listed base URL (env), admin/informatician only
### [ ] 46a1b. Verify signature with the pinned public key; refuse if invalid
### [ ] 46a1c. ETag cache; tests: wrong signature, unlisted host, tampered index refused
### [ ] 46a2a. POST /api/market/install: fetch package, recompute hash vs signed index, run lintPackage, check requires/minAppVersion
### [ ] 46a2b. Store in element_sets (source marketplace, read_only, tier marketplace-verified) plus installed_packages in one transaction with audit; rules and bands arrive enabled:false
### [ ] 46a2c. Tests: tampered package, hash mismatch, failed lint all store nothing; read-only rows refuse PATCH/DELETE
### [ ] 46b1. Marketplace screen: list, search, filter by kind
### [ ] 46b2. Preview panel (members, fields, rule count, reviewers, license, short hash, versions, withdrawn flag)
### [ ] 46b3. Install button, installed badge, loading and error states
### [ ] 46c1. Update side by side; existing cases keep their version
### [ ] 46c2. Withdrawn banner on Summary and Pathway tab with reason; block new use; delete nothing
### [ ] 46c3. Install from file (no internet) with identical checks
### [ ] 46c4. Uninstall only if no case uses it, else mark retired
### [ ] 46c5. "Needs local enable" for rules and bands; doctor/admin enables (server stamps user and time, audited)
### [ ] 46d1. Build composite pathway with pinned members, one nested level, cycle check
### [ ] 46d2. Composite tier = weakest member (marketplace-verified only if all are); member badges; tests

## 47. Governance

### [ ] 47a1. Safety tests: marketplace content cannot be edited by any route; fork leaves original unchanged; changed byte fails hash; bad signature refused
### [ ] 47a2. Safety tests: patient-like strings fail lint; package rules never fire until enabled; withdrawn warns and blocks; Provenance lists id/version/hash/tier; case keeps its version after update; reviewer is not author
### [ ] 47b1. GOVERNANCE.md: what "verified" means (peer review, not regulatory approval), reviewers, conflict of interest, two-reviewer rule, recall process
### [ ] 47b2. GOVERNANCE.md: content license, pre-release checklist (SNOMED/LOINC licence, device-software rules, privacy, disclaimer), top 10 risks

---

# PHASE 7: operational components (same repeating-row engine)

Rules for every Phase 7 chat: zero pre-filled doses, thresholds or rules; discontinuing never hard-deletes; doses free text only; unverified billing codes omitted.

### [ ] 48a1. care.orders seed
**Paste:** one care set from element-sets.js
```text
Add care.orders (kind care, direct true, quick order 6 short 'Orders', view type orders). Repeat group "orders": ord_time datetime, ord_category select (Medication, Lab, Imaging, Nursing, Consult, Diet), ord_item text, ord_instructions text (free text), ord_priority select (Routine, Urgent, STAT), ord_status select (Draft, Active, Completed, Discontinued), ord_reason text, ord_by session user. No doses or rules.
```
### [ ] 48a2. Orders table view grouped Active vs Completed/Discontinued (read only)
### [ ] 48b1. Complete and Discontinue buttons (reason required for Discontinue), row patch with audit, no hard delete
### [ ] 48b2. buildBundle: ServiceRequest (MedicationRequest for Medication), status mapping, instructions exactly as typed
### [ ] 49a1. care.allergies seed (substance, reaction, severity, recorded_at); no entries
### [ ] 49a2. Active allergies as a banner chip (display only)
### [ ] 49b1. MAR view: grid reading active Medication orders (read only)
### [ ] 49b2. MAR entry: Given/Held/Refused (+reason), dose_given free text, given_by from session, note
### [ ] 49b3. Non-blocking banner "Review allergy list before administering" when an allergy substance text matches an active medication order text
### [ ] 50a1. care.adt_schedule seed: adt_time, adt_event (Admission, Ward Transfer, Discharge, Outpatient Visit, Follow-up Scheduled), adt_ward, adt_bed, adt_clinician, adt_status (Scheduled, Arrived, Completed, Cancelled)
### [ ] 50a2. Latest Admission/Ward Transfer row sets ward and bed on banner and ward board
### [ ] 50b1. Schedule view on Patients screen (upcoming Follow-up and Outpatient rows by date)
### [ ] 50b2. buildBundle Encounter status and location from ADT; Discharge changes status without deleting data
### [ ] 51a1. Migration: allow icd10 and cpt in verified_codes
### [ ] 51a2. Codes tool and validation for icd10/cpt; unverified codes stay out of every export; tests
### [ ] 51b1. Charge summary server aggregate (verified Condition codes, completed orders, stay length from ADT)
### [ ] 51b2. Export tab: Charge Summary sub-view
### [ ] 51b3. JSON/CSV export, audited, formula-safe; billing never touches notes or alerts
### [ ] 52a. Tests: care.orders seed has no doses/rules; discontinue needs reason and keeps the row
### [ ] 52b. Tests: MAR never sums doses; given_by from session; allergies seed empty
### [ ] 52c. Tests: ADT seed empty; Discharge updates Encounter without deleting data
### [ ] 52d. Tests: unverified ICD-10/CPT omitted; export audited; CSV formula-safe

*Each Phase 7 test task: "Tests only. Return only the new test blocks, not the whole file." Paste only the test helpers and the code under test.*
