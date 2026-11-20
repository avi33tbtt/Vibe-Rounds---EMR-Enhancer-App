# Phase M: matching marketplace

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 22. Phase M: the matching marketplace

*See sections 4.5 and 2. One registry and one index serve both apps. Matching of **recordings against summaries and order sets** runs in the EMR; matching of **analytics against data** runs in the Analytics app (tasks AA5 and AA12). Both use the same `compatibility()` code, one copy checked identical in CI.*

#### [ ] M1. Index records carry `targetApp`, provides and requires
**File:** registry repo `scripts/build-index.js` | **Paste:** build-index.js, one recording package, one analytic package
```text
Every index entry gets targetApp ("emr" or "analytics"), and: for recordings, `provides` (output of providesOf, keys only); for summary layouts, order sets and analytic definitions, `requires` (slots). The build computes provides with the same elements.js the app uses (one copy, CI checks it). A package whose kind does not match its targetApp fails the build. Test: changing a field's unit changes its provides and its hash.
```

#### [ ] M2. Shared matching module
**File:** new `market-match.js` (browser + Node), copied byte for byte into the Analytics app | **Paste:** compatibility() from F3
```text
Wrap compatibility() for list use: given one selected item and the index, return compatible items grouped by domain with met / partly / unmet and the basis. Pure; made-up index in tests. CI in both repos fails if the two copies differ.
```

#### [ ] M3. EMR picker: recording first (summaries and order sets only)
**File:** enhancer.html | **Paste:** the marketplace list screen (46b1)
```text
Pick a recording; show two lists, compatible summaries and compatible order sets, each with what is covered and what is not. Only items with targetApp "emr" and only what the user's role may see. Wording: "data compatible", never "adequate". Analytics do not appear here.
```

#### [ ] M4. EMR reverse direction: order set or summary first
**File:** enhancer.html | **Paste:** M2, M3
```text
Pick an order set or summary layout; list the recordings that can feed it with the same covered / not-covered view. Changing the selection updates the lists.
```

#### [ ] M5. EMR several selections: AND, OR and "what remains"
**File:** enhancer.html | **Paste:** M3, M4
```text
Select several items. AND shows only items whose needs are all met by the selection; OR shows items with at least one need met and flags the unmet ones. Always show what remains: unmet slots and recording fields nothing uses. Start with one recording and one list per domain.
```

#### [ ] M6a. `field_bindings` table and routes (EMR)
**Files:** migration, api.js, permissions.js | **Paste:** the code_bindings routes
```text
Table field_bindings (owner_id, owner_version, slot, set_id, set_version, field_id, created_by, created_at); create and list routes, admin and informatician, audited, never in a package. Tests: role matrix, audit row.
```

#### [ ] M6b. Feed bindings into `compatibility()`
**Files:** api.js or client | **Paste:** M6a, compatibility() from F3b
```text
Pass stored bindings as manualBindings; flag a binding for re-check when either version changes. Tests: a binding makes a slot met with basis "bound by hand"; a version change flags it. (The Analytics app has its own bindings table, AA2b.)
```

#### [ ] M7. EMR "Who uses this field?" on set save
**Files:** api.js, enhancer.html | **Paste:** the set update route
```text
Before a field is removed or its type or unit changed, list installed EMR items whose slots matched it and ask for confirmation. Never blocks; audited when confirmed. For analytics, the Analytics app shows the same warning when a new manifest no longer provides a slot (AA12).
```
