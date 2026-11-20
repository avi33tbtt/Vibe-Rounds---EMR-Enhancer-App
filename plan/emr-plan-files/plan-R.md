# Phase R: role-based access

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 17. Phase R: role-based access for every element

*See section 5. Do R1 right after V1a, then continue Phase V. R2 to R7 follow V8. This phase replaces the `entryRoles` idea in 48a0.*

#### [x] R1. Access vocabulary and the "step 0" checklist (doc only)
**File:** VIEWS.md | **Paste:** section 5 of this plan
```text
Add to VIEWS.md: the access block {view, enter, amend, approve, configure, export}, each a list of roles from permissions.js; default deny; narrow-never-widen; and a "Step 0" line at the top of "How to add a new type": write the access block first. No code.
```

#### [x] R2. `validateAccess(element)` (pure)
**File:** views.js | **Paste:** VIEWS.md access section, the role list from permissions.js
```text
Add validateAccess(el, roles) returning {errors}: block present; only the six action names; each value a non-empty list of known roles; no duplicates. Tests with a made-up set: one failing case per error and one passing.
```

#### [x] R3. `canElement(user, el, action)` on the server
**File:** permissions.js | **Paste:** can(), the role table
```text
Add canElement(user, el, action): true only if the element's access lists the user's role for that action AND the matching base action in the role table is allowed (narrow, never widen). Missing block means deny. Tests: viewer cannot gain enter; nurse listed for enter and allowed by the base table can; unlisted role cannot.
```

#### [x] R4. Enforce on row and value routes
**File:** api.js | **Paste:** the rows append and patch routes, the values route
```text
Call canElement on the set for enter and amend in these routes (403 with a plain sentence and the action name). Rows are still versioned and audited as before. Tests: nurse refused where the set does not list nurse; doctor allowed; audit row unchanged.
```
*Done (20 Nov 2026): `assertElement` in api.js, tests in `access-routes.test.js`. Transitional: a stored set with no access block keeps today's rules until saving a set stamps a block (see R7). The value route reads the set id from the key's first part.*

#### [x] R5. Seed access blocks that reproduce today
**Files:** element-sets.js, seed.js | **Paste:** the role rules for care sets and disease sets from permissions.js
```text
Add an access block to every seed set and EMR view pathway so behaviour equals today's rules. seed.js fails if a seed has none. Test: for every seed set and role, canElement equals the old can() result for enter and amend.
```
*Done (20 Nov 2026): all 14 seed sets have a block and their version went up by one (seed.js refuses a changed set at the same version); tests in `seed-access.test.js`. The seed EMR view pathways are configured by admin only. The default-deny flip in api.js is NOT done here: do it in R7 once a saved set carries a block.*

#### [x] R6. Generated access matrix test
**File:** new `access-matrix.test.js` | **Paste:** how permissions.test.js builds the role-by-route matrix
```text
Generate cases from the data: for every seed element, every action, every role, assert the result of canElement and that the matching route answers 403 or not 403 to match. Print the number of cases.
```
*Done (20 Nov 2026): `access-matrix.test.js`. Routes are checked for `enter` and `amend` only, because those are the only actions a route enforces so far. `configure` gets a route check in R7 (a seed set is read-only, so its update route cannot show the difference); `view`, `approve` and `export` are checked through `canElement` only until a route enforces them.*

#### [x] R7. Access changes: route and audit
**Files:** api.js, permissions.js, audit | **Paste:** the set update route
```text
Changing an element's access block uses its own action access.configure (admin; add informatician only if decision 19 says so), carries the version, writes one audit row with before and after, and on a reviewed set creates a new version. Tests: nurse refused, audit row present, version conflict gives 409.
```
*Done (20 Nov 2026): there is no new route. Saving a set is `POST /api/element-sets` (a new version each time), so the check sits there: changing or dropping the block of an existing set needs the new action `access.configure` (admin only, decision 19 default). A new set may start with a block. A block is validated (422 `bad_access`). The audit row (`set.save`) carries the block before and after only when it changed. Tests in `access-change.test.js`. Still open: the default-deny flip for a set with no block (do it when you choose, see R5 note); the nurse-own-row rule is unchanged.*

#### [x] R8. Show access in the UI (mirror only)
**File:** enhancer.html | **Paste:** the set card renderer, Store.can
```text
Show each element's access as a small plain-language line ("Entered by: doctor, nurse. Seen by: everyone") and hide controls the role cannot use. The server stays the control.
```
*R8a done (20 Nov 2026): pure helpers `describeAccess` and `accessAllows` in views.js, tests in `views-access-text.test.js`. R8b done (20 Nov 2026): enhancer.html has `accOk` and `accLine` next to `SRV()`. The applied set card shows the access line (only when the set has a block). The `+ Add reading` and `+ New row` buttons need enter, and the row `×` buttons need amend; both also follow the role table, so a viewer no longer sees them. Cells stay editable, so a role that may enter but not amend can still fill a new row (the server decides). Not mirrored: the nurse care-sets-only rule (seed sets already list the right roles). ROLE_LIST in enhancer.html copies ROLES from permissions.js. Demo mode shows everything.*

#### [x] R9. Package lint and install confirmation (Phase 6 hook)
*Add to 42a3: a package with no access block is an error; roles must exist locally. Add to 46a2b: install shows the suggested access to the admin, who confirms or narrows it; the narrowest result is stored.*
*Done (20 Nov 2026): both lines are now written into `plan-6-marketplace.md` (42a3 and 46a2b). Nothing to build until Phase 6.*
