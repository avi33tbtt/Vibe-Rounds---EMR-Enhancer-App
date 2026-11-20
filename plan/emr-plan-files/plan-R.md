# Phase R: role-based access

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 17. Phase R: role-based access for every element

*See section 5. Do R1 right after V1a, then continue Phase V. R2 to R7 follow V8. This phase replaces the `entryRoles` idea in 48a0.*

#### [ ] R1. Access vocabulary and the "step 0" checklist (doc only)
**File:** VIEWS.md | **Paste:** section 5 of this plan
```text
Add to VIEWS.md: the access block {view, enter, amend, approve, configure, export}, each a list of roles from permissions.js; default deny; narrow-never-widen; and a "Step 0" line at the top of "How to add a new type": write the access block first. No code.
```

#### [ ] R2. `validateAccess(element)` (pure)
**File:** views.js | **Paste:** VIEWS.md access section, the role list from permissions.js
```text
Add validateAccess(el, roles) returning {errors}: block present; only the six action names; each value a non-empty list of known roles; no duplicates. Tests with a made-up set: one failing case per error and one passing.
```

#### [ ] R3. `canElement(user, el, action)` on the server
**File:** permissions.js | **Paste:** can(), the role table
```text
Add canElement(user, el, action): true only if the element's access lists the user's role for that action AND the matching base action in the role table is allowed (narrow, never widen). Missing block means deny. Tests: viewer cannot gain enter; nurse listed for enter and allowed by the base table can; unlisted role cannot.
```

#### [ ] R4. Enforce on row and value routes
**File:** api.js | **Paste:** the rows append and patch routes, the values route
```text
Call canElement on the set for enter and amend in these routes (403 with a plain sentence and the action name). Rows are still versioned and audited as before. Tests: nurse refused where the set does not list nurse; doctor allowed; audit row unchanged.
```

#### [ ] R5. Seed access blocks that reproduce today
**Files:** element-sets.js, seed.js | **Paste:** the role rules for care sets and disease sets from permissions.js
```text
Add an access block to every seed set and EMR view pathway so behaviour equals today's rules. seed.js fails if a seed has none. Test: for every seed set and role, canElement equals the old can() result for enter and amend.
```

#### [ ] R6. Generated access matrix test
**File:** new `access-matrix.test.js` | **Paste:** how permissions.test.js builds the role-by-route matrix
```text
Generate cases from the data: for every seed element, every action, every role, assert the result of canElement and that the matching route answers 403 or not 403 to match. Print the number of cases.
```

#### [ ] R7. Access changes: route and audit
**Files:** api.js, permissions.js, audit | **Paste:** the set update route
```text
Changing an element's access block uses its own action access.configure (admin; add informatician only if decision 19 says so), carries the version, writes one audit row with before and after, and on a reviewed set creates a new version. Tests: nurse refused, audit row present, version conflict gives 409.
```

#### [ ] R8. Show access in the UI (mirror only)
**File:** enhancer.html | **Paste:** the set card renderer, Store.can
```text
Show each element's access as a small plain-language line ("Entered by: doctor, nurse. Seen by: everyone") and hide controls the role cannot use. The server stays the control.
```

#### [ ] R9. Package lint and install confirmation (Phase 6 hook)
*Add to 42a3: a package with no access block is an error; roles must exist locally. Add to 46a2b: install shows the suggested access to the admin, who confirms or narrows it; the narrowest result is stored.*
