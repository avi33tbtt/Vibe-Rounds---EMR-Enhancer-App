# Phase 6: content lifecycle and marketplace

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 20. Phase 6: content lifecycle and marketplace

Facts every Phase 6 chat needs: marketplace content is read-only and hash-pinned; hash = SHA-256 of canonical JSON of `content` (keys sorted, no whitespace); tiers are marketplace-verified, local-reviewed, local-draft; the server enforces read-only (the UI only mirrors it); reviewer is never the author; packages contain definitions only, never patient data.

### 42a. package-lint.js (new root file, browser + Node, ends with `if(typeof module!=='undefined')module.exports=...`)

#### [ ] 42a1. canonicalJson and sha256Hex + tests
```text
Create package-lint.js with canonicalJson(obj) and async sha256Hex(text) (crypto.subtle or node:crypto), and package-lint.test.js: same hash when keys are in a different order. Nothing else.
```
#### [ ] 42a2. lintPackage skeleton: manifest, semver, id pattern
**Paste:** the manifest shape (package file, 6 lines)
```text
Add lintPackage(pkg) returning {errors, warnings} with errors: bad manifest, bad semver, bad id pattern. One failing test per error plus one passing package.
```
#### [ ] 42a3. Errors: unknown field type, content over 1 MB, key named eval or function, any view block or EMR surface that fails `validateView` / `validatePathwayViews` (from V2)
#### [ ] 42a3b. (v3.1) Every package declares `targetApp` ("emr" or "analytics") and its kind must match it. `analytic` packages are linted with `validateAnalytic` (copy of AA1, CI-checked); summary layouts and order sets with the view validators; a definition with a clinical list, threshold or free expression is an error; `provides` and `requires` must be derivable (M1)
#### [ ] 42a4. Errors: rule op not whitelisted, threshold not a finite number
**Paste:** whitelisted operators from cds-rules.js
#### [ ] 42a5. Errors: band/rule/dose-like text without a references entry
#### [ ] 42a6. Errors: patient-like strings (phone, long digit runs, "MRN", "patient name") with the path
#### [ ] 42a7. Warnings: coding not in verified table, empty rationale, duplicate field ids
```text
(for 42a3-42a7, same prompt each time) Extend lintPackage with ONLY the listed checks and one failing test per check. Earlier tests must still pass.
```

### 42b. Tier badges and read-only
*Note (v2): EMR view pathways (Phase V) are ordinary pathways, so they get the same tier, badge, read-only and fork rules. Nothing extra to build; V8b tests that seed view pathways load as tier seed.*

#### [ ] 42b1. Registry fields with defaults
**Paste:** where registry entries are created/loaded
```text
Add source, readOnly, tier, forkedFrom, package to registry entries; old entries default to source seed/local, tier local-draft. No UI.
```
#### [ ] 42b2. tierBadge(entry) helper and badge on set cards
#### [ ] 42b3. Badge on the Pathway tab and '+ Add' list
#### [ ] 42b4. readOnly sets render without edit controls (applying and entering values still allowed)
**Paste:** set card renderer / editor entry points
#### [ ] 42b5. Guard the save functions for readOnly sets (not only the UI)
**Paste:** the set save functions
#### [ ] 42b6. Server refuses PATCH/DELETE on read_only element_sets (403)
**Paste:** element_sets routes; add test
#### [ ] 42b7. Fork to local copy
```text
New setId local.<slug>, version 1, tier local-draft, forkedFrom {setId, version, contentHash}; never changes the original. Editing a local-reviewed set makes a new draft version.
```

### 42c. Import package file and Provenance

#### [ ] 42c1. Tools > Import package file: read JSON, run lintPackage, show errors/warnings
#### [ ] 42c2. On success: recompute hash locally, store as marketplace, readOnly, tier marketplace-verified (Demo mode only)
#### [ ] 42c3. buildBundle Provenance lists package id, version, contentHash, tier per applied set

### 43. Request a feature

#### [ ] 43a1. "Request a feature" box and output choice (UI only)
#### [ ] 43a2. Send the sentence plus registry ids/titles/field ids/units to the chunk-36 route; validate output (ids exist, operators whitelisted, thresholds appear in sentence, no doses, codes empty)
#### [ ] 43a3. Save a valid draft as local-draft with provenance {requestText, model, at}; "My drafts" list
#### [ ] 43b1. Run lintPackage live on a draft; plain-language errors
#### [ ] 43b2. Block applying any unapproved draft to a real case (in code, with message); "Try it" only on Demo/synthetic
#### [ ] 43b3. review_requests migration and submit route (status submitted, validated body)
#### [ ] 43b4. "Submit for review" button (zero lint errors only); editing a submitted version creates a new version and withdraws the request
#### [ ] 43b5. Tests: invalid AI output saves nothing; draft cannot be applied to a real case; submit refused with lint errors

### 44. Review (informatician)

#### [ ] 44a1a. permissions.js for informatician (review and approve content, install packages, no charting) + role tests
#### [ ] 44a1b. Queue route (submitted, in_review, changes_requested) + tests
#### [ ] 44a1c. Get-one route re-running lintPackage on the server + tests
#### [ ] 44a2a. Approve route: reviewer from session, freeze version as local-reviewed, review_events and audit_log in one transaction
#### [ ] 44a2b. Rules/bands/dose-like text need two distinct approving reviewers (configurable, default 2)
#### [ ] 44a2c. Request-changes and reject routes (comment required)
#### [ ] 44a2d. Tests: author cannot review (403); one approval not enough; missing comment refused; rollback leaves no half rows
#### [ ] 44b1. Tools > Review: queue list
#### [ ] 44b2. Review page: request text, AI provenance, fields and rules in plain language, server lint result
#### [ ] 44b3. Diff against previous version
#### [ ] 44b4. Checklist (schemaValid automatic, others ticked, codesVerified vs verified_codes) and Approve / Request changes / Reject buttons
#### [ ] 44c1. Tests: approved version immutable; edit after approval makes a draft; every action writes review_events and audit_log; informatician cannot chart

### 45. Registry repo (separate repo: emr-enhancer-registry; needs neither server nor app)

*v3.1: the registry serves both apps. Every package carries `targetApp` ("emr" or "analytics"); CI lints each package with the validator of its target app and fails on a mismatch; one signing key is pinned in both apps.*

#### [ ] 45a1. Layout: packages/<id>/<version>/package.json, README, CONTRIBUTING, LICENSE (MIT), CONTENT-LICENSE placeholder
#### [ ] 45a2. CODEOWNERS, PULL_REQUEST_TEMPLATE (review checklist), three ISSUE_TEMPLATE files, GOVERNANCE stub
#### [ ] 45b1. scripts/build-index.js
#### [ ] 45b2. scripts/verify.js (+ tiny test): recompute hash and compare; refuse edits to merged version folders
#### [ ] 45b3. .github/workflows/ci.yml (lint changed packages, check package-lint.js matches the app copy, rebuild index in a check job)
#### [ ] 45c1. release.yml: ed25519 signing from secrets (node:crypto), publish index.json and index.json.sig, never commit a private key
#### [ ] 45c2. withdrawn.json by PR with reason, shown in the index
#### [ ] 45c3. Protection checklist (CODEOWNERS review, no force-push, no tag deletion, signed commits; check GitHub's current docs) and key rotation/loss notes in GOVERNANCE.md

### 46. Marketplace

#### [ ] 46a1a. GET /api/market: fetch index and signature from one allow-listed base URL (env), admin/informatician only
#### [ ] 46a1b. Verify signature with the pinned public key; refuse if invalid
#### [ ] 46a1c. ETag cache; tests: wrong signature, unlisted host, tampered index refused
#### [ ] 46a2a. POST /api/market/install: fetch package, recompute hash vs signed index, run lintPackage, check requires/minAppVersion, **refuse any package whose targetApp is not "emr"** (analytic packages are installed only by the Analytics app, AA4)
#### [ ] 46a2b. Store in element_sets (source marketplace, read_only, tier marketplace-verified) plus installed_packages in one transaction with audit; rules and bands arrive enabled:false
#### [ ] 46a2c. Tests: tampered package, hash mismatch, failed lint all store nothing; read-only rows refuse PATCH/DELETE
#### [ ] 46b1. Marketplace screen: list, search, filter by kind
#### [ ] 46b2. Preview panel (members, fields, rule count, reviewers, license, short hash, versions, withdrawn flag)
#### [ ] 46b3. Install button, installed badge, loading and error states
#### [ ] 46c1. Update side by side; existing cases keep their version
#### [ ] 46c2. Withdrawn banner on Summary and Pathway tab with reason; block new use; delete nothing
#### [ ] 46c3. Install from file (no internet) with identical checks
#### [ ] 46c4. Uninstall only if no case uses it, else mark retired
#### [ ] 46c5. "Needs local enable" for rules and bands; doctor/admin enables (server stamps user and time, audited)
#### [ ] 46d1. Build composite pathway with pinned members, one nested level, cycle check
#### [ ] 46d2. Composite tier = weakest member (marketplace-verified only if all are); member badges; tests

### 47. Governance

#### [ ] 47a1. Safety tests: marketplace content cannot be edited by any route; fork leaves original unchanged; changed byte fails hash; bad signature refused
#### [ ] 47a2. Safety tests: patient-like strings fail lint; package rules never fire until enabled; withdrawn warns and blocks; Provenance lists id/version/hash/tier; case keeps its version after update; reviewer is not author
#### [ ] 47b1. GOVERNANCE.md: what "verified" means (peer review, not regulatory approval), reviewers, conflict of interest, two-reviewer rule, recall process
#### [ ] 47b2. GOVERNANCE.md: content license, pre-release checklist (SNOMED/LOINC licence, device-software rules, privacy, disclaimer), top 10 risks
