# Phase A: analytics (Analytics repo)

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 21. Phase A: analytics in the Analytics app (separate repo)

*See section 2 (separation rule). This phase is built in github.com/avi33tbtt/VibeRounds-Clinical-Analytics-App, not in the EMR repo. Use **Context block B** (section 12) in these chats. Prerequisites in the EMR repo: F2, F3, F4, F7 (the export and its manifest). Prerequisites in the registry: M1 (index carries `targetApp`, `provides`, `requires`) and the signing from tasks 45c1. Each task is one file and one concern.*

#### [ ] AA0. Engine assessment (no code)
**Run yourself, paste the output:**
```text
grep -n "fhir_.*_\${\|CREATE .*VIEW\|population\|cohort" analytics.js | head -60
grep -n "^function run\|async function run\|FN =" analytics.js
grep -n "ROLES\|ROUTE_PERMISSIONS" security.js | head -20
```
```text
Do not change code. From this output and one analytic of the catalog, list (1) how a run gets its scoped views (p, dx, ob, rx, pr, en, al, im, ref), (2) where a new "definition runner" section fits in analytics.js, (3) which helpers are pure and reusable (masking at PATHWAY_MIN_CELL, readiness profile), (4) what a new role needs in security.js. Say what you could not see. Reply as a short table.
```

#### [ ] AA1. `validateAnalytic(def)` and the closed kind list
**File:** new root `defs.js` (section `validate`; `node defs.js --selftest`; added to `npm test`) | **Paste:** the definition example in 7.1, the kind table
```text
Create defs.js with validateAnalytic(def) returning {errors, warnings}. Errors: unknown analyticKind; more than one kind; slot with unknown role; slot naming a set id or field id; any key named sql, where, expr, eval, function, threshold, target, limit, band, dose; params without type, min and max; missing or invalid access block; rules not []. Add a --selftest with one passing definition and one failing case per error. Follow the file style of security.js (sections, selftest).
```

#### [ ] AA2a. Table for installed definitions
**File:** server.js or analytics.js (`SCHEMA_SQL` style) | **Paste:** where cohorts and app_settings are created
```text
Create at startup (CREATE TABLE IF NOT EXISTS) analytic_defs (id, version, title, kind, content jsonb, content_hash, source, read_only, enabled, installed_by, installed_at). No patient data. The SELECT-only role cannot read or write it (check db-readonly.sql). Selftest: created twice without error.
```

#### [ ] AA2b. Table for manual bindings
**File:** same as AA2a | **Paste:** the AA2a code
```text
Create field_bindings (def_id, def_version, slot, resource, code, unit, created_by, created_at) the same way. No patient data; not readable by the SELECT-only role. Selftest: created twice without error.
```

#### [ ] AA3a. Fetch the index from one allowed host
**File:** new root `market.js` (section `index`) | **Paste:** how security.js reads env settings, the registry's index format (M1)
```text
Add GET /api/market (admin only; audited as market.fetch): fetch index.json and index.json.sig from the one base URL in env MARKET_BASE_URL (refuse any other host) and return only items with targetApp "analytics". No signature check yet. Selftest: unlisted host refused; only analytics items returned.
```

#### [ ] AA3b. Verify the signature, cache by ETag
**File:** market.js | **Paste:** AA3a
```text
Verify the ed25519 signature with the public key pinned in env MARKET_PUBKEY (node:crypto) before returning anything; refuse if invalid. Add ETag caching. Selftest: wrong signature and tampered index refused.
```

#### [ ] AA4a. Install
**File:** market.js | **Paste:** AA3b, validateAnalytic, canonical JSON and hash rules (section 20 facts)
```text
Add POST /api/market/install (admin; audited as market.install): fetch the package, recompute SHA-256 of canonical JSON and compare with the signed index, refuse targetApp other than "analytics", run validateAnalytic, store read_only with source marketplace in one transaction. Reference lists named by a definition arrive disabled. Selftest: tampered package, hash mismatch, an emr package and failed lint all store nothing; PUT/DELETE on a read_only definition refused.
```

#### [ ] AA4b. Update and uninstall
**File:** market.js | **Paste:** AA4a
```text
Add update (a new version row; older runs keep their version) and uninstall (refused if any saved run output uses it, else marked retired), both audited. Selftest: update keeps the old row; uninstall refused when in use.
```

#### [ ] AA5a. Coverage from the elements manifest
**File:** defs.js (section `coverage`) | **Paste:** compatibility() from F3a/F3b (copied byte for byte; CI diff check), the manifest format from F7b
```text
Add coverageOf(def, manifestProvides) using the same compatibility() as the EMR (one copy, checked identical in CI). Return per slot: met / partly / unmet and the basis. Never say adequate. Selftest with made-up manifests.
```

#### [ ] AA5b. Readiness from the data profile
**File:** defs.js (section `coverage`) | **Paste:** the readiness profile code, AA5a
```text
Add readinessOf(def, profile) returning per slot the share filled, coded and dated for the scope, shown separately from coverage and never combined into one score. Selftest with made-up profiles.
```

#### [ ] AA6a. `runCompleteness` (pure over scoped rows)
**File:** defs.js (section `run`) | **Paste:** AA1, how an existing analytic reads scoped views
```text
Implement runCompleteness(def, rows, params) returning share filled, coded and dated per group. Pure: rows are passed in. Selftest with a made-up definition and made-up rows.
```

#### [ ] AA6b. `POST /api/defs/run`: access, masking, audit
**Files:** analytics.js (register route), defs.js | **Paste:** AA6a, masking helper, the audit helper
```text
Add POST /api/defs/run: definition must be enabled and the user's role in its access.view; compute coverage; run on the read-only connection; hide cells under PATHWAY_MIN_CELL; write one audit row (user, definition id and version, scope, params; no results). Result carries scope, version, params typed, mode and "Data as recorded. No judgement of care." Selftest: role refused, small cell hidden, audit row written.
```

#### [ ] AA7a. Kind `count`
#### [ ] AA7b. Kind `distribution`
#### [ ] AA8a. Kind `timeseries`
#### [ ] AA8b. Kind `summaryStats` (no abnormal share)
#### [ ] AA9a. Kind `timeToEvent`
#### [ ] AA9b. Kind `pairs`
```text
(one kind per chat, same pattern as AA6a) Add only the listed kind as a pure function over scoped rows with a validator entry, a selftest, small-cell hiding through the AA6b route, and one line in the docs. Add no clinical list.
```


#### [ ] AA10. Patient lists from a definition
**File:** defs.js | **Paste:** how the pathways patient list is audited (`phi.pathway_patients`)
```text
Add POST /api/defs/patients: only for a visible, unhidden group, max 200, audited as a PHI list read with the group id. Never offered for a hidden group. Selftest: hidden group refused; audit row written.
```

#### [ ] AA11. Roles in the Analytics app
**File:** security.js | **Paste:** the ROLES table and ROUTE_PERMISSIONS
```text
Add roles viewer, analyst and admin to ROLES (decision 30). analyst may run enabled definitions and see aggregates; only admin installs, enables, imports and sees patient lists. Definitions' access.view lists roles from this table; unknown roles refused at install. Selftest: role-by-route cases for the new routes.
```

#### [ ] AA12a. Marketplace tab
**File:** index.html | **Paste:** one existing tab renderer
```text
Add a Marketplace tab: list, search, preview with requires, short hash, license, withdrawn flag; Install, Update, Uninstall for admin only.
```

#### [ ] AA12b. Definitions tab: list, scope, coverage
**File:** index.html | **Paste:** the Marketplace tab, the scope picker code
```text
Add a Definitions tab: installed list, pick one and a scope, show coverage per slot with its basis. No Run button yet. Wording: "data compatible", never "adequate".
```

#### [ ] AA12c. Definitions tab: run and result
**File:** index.html | **Paste:** the Definitions tab, one existing chart output
```text
Add Run: masked result as chart and table like other outputs, readiness counts, "as of" export time.
```

#### [ ] AA12d. "Which analytics can my EMR data feed?"
**File:** index.html | **Paste:** coverageOf response shape
```text
Add a view that starts from a batch's manifest and lists compatible installed definitions with coverage.
```

#### [ ] AA13. Reference lists (class 3)
**Files:** evidence.js (overrides section) | **Paste:** the concept_overrides routes
```text
Let a definition name a reference list by kind in params. Lists are saved reviewer decisions (existing overrides) with the review rules of 44a2; an unapproved list is refused with a plain message. Never carried by a package by default.
```

#### [ ] AA14. Safety tests
**Files:** defs.js selftest, e2e script | **Paste:** nothing
```text
Tests: every installed definition passes validateAnalytic; no definition holds a clinical list or number outside params; cells under the minimum never appear; results contain no patient ids; read-only role cannot write the definition tables; an emr-targeted package is refused; withdrawn definitions warn and block new runs.
```

*What the EMR repo does for analytics, in full: F2 to F5 (elements, coverage function, projection, index), F7 (export), F9 (retire `ana()`). Nothing else.*
