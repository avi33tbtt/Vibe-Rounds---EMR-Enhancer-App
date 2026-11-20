# Phase O: Orders (task 48 data and views, then the engine)

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

**Order inside this file (see steps 23 to 25 in `plan-core.md`):** 48a1a, 48a1b, 48a2; then O1, O2, O3 (O3 replaces 48b1a); then 48b1b, 48b2, O4. The Phase O text says "48b1a becomes O3", and this order follows that note.

## 25 (part). Orders data and views: task 48

#### [ ] 48a1a. `care.orders` seed: fields (data only)
**File:** element-sets.js | **Paste:** one care set from element-sets.js, the orders group from the list below
```text
Add care.orders (kind care, direct true, quick order 6 short 'Orders', access: enter and approve [doctor, admin], view all roles). Repeat group "orders": ord_time datetime, ord_category select (Medication, Lab, Imaging, Nursing, Consult, Diet), ord_item text, ord_instructions text (free text), ord_priority select (Routine, Urgent, STAT), ord_status select (Draft, Active, Completed, Discontinued), ord_reason text, ord_by session user. No view block yet, no doses, no rules.
```

#### [ ] 48a1b. `care.orders` view block (data only)
**File:** element-sets.js | **Paste:** the care.orders entry from 48a1a
```text
Add the view block: {"type":"flowsheet","timeField":"ord_time","statusboard":{"statusField":"ord_status","groups":[{"label":"Active","values":["Draft","Active"]},{"label":"Closed","values":["Completed","Discontinued"]}]},"actions":[{"label":"Complete","field":"ord_status","to":"Completed"},{"label":"Discontinue","field":"ord_status","to":"Discontinued","reasonField":"ord_reason","reasonRequired":true}]}. Bump the version.
```

#### [ ] 48a2. Generic `statusboard` view (read only)
**Files:** views.js (validator), enhancer.html | **Paste:** the registry from V3a, the orders block above
```text
Register a statusboard renderer: rows grouped by the status field into the groups from the data, newest first, each row as its typed values. Add statusboard to validateView (statusField must be a select; group values must exist among its options). Test with a made-up set, not care.orders.
```

#### [-] 48b1a. Generic row `actions`: buttons and patch
**SKIP this task. It is replaced by O3 (step 24 in `plan-core.md`). The text is kept only because O3 starts from it.**

**File:** enhancer.html | **Paste:** the row patch code in Store, the statusboard renderer
```text
Render each action as a button on a row. Click patches only the named field through the existing row patch route (version sent). Never delete. Test with a made-up set: status changed, row kept.
```

#### [ ] 48b1b. Reason required
**File:** enhancer.html | **Paste:** the 48b1a click handler
```text
If an action has reasonRequired, ask for a reason and send it in reasonField; no reason, no change, plain message. Test: no reason means no patch; a version conflict shows the usual conflict path.
```

#### [ ] 48b2. FHIR mapping from the set's data
**Files:** enhancer.html (buildBundle) | **Paste:** buildBundle, the orders `fhir` block below
```text
Add a "fhir" block to care.orders: {"resource":"ServiceRequest","variants":[{"whenField":"ord_category","equals":"Medication","resource":"MedicationRequest"}],"statusMap":{"Draft":"draft","Active":"active","Completed":"completed","Discontinued":"revoked"},"textField":"ord_instructions"}. buildBundle gets one generic function that maps rows by such a block (instructions text exactly as typed). Test: a made-up set with a different block maps correctly; orders export keeps typed text unchanged.
```

---

## 24. Phase O: Orders engine (small, behind a review gate)

#### [ ] O1. Engine block validator (pure)
**File:** views.js | **Paste:** the engine example in 8.2
```text
Add validateEngine(set): statusField must be a select; every from and to must be an option; roles must exist and be allowed by the set's access; reasonField must exist; `never` only from a closed list (delete, reopenFrom:<status>). Tests with a made-up set.
```
#### [ ] O2. Enforce transitions on the server
**Files:** api.js | **Paste:** the row patch route
```text
When a set has an engine block and a patch changes the statusField, require a listed transition for the user's role (422 with a plain sentence otherwise), require the reason when declared, never allow delete. Same version check and one audit row. Tests: an unlisted change writes nothing; nurse refused where not listed; reason required; discontinued row kept.
```
#### [ ] O3. Buttons call the engine
**File:** enhancer.html | **Paste:** 48b1a actions code
```text
Row actions show only the transitions the role may do (mirror) and send the patch; a 422 shows the server's sentence. Test with a made-up set.
```
#### [ ] O4. Safety tests
```text
Tests only: orders seed has no doses, thresholds or rules; engine data is the only place transitions live; the server, not the screen, refuses an unlisted change.
```
*Then continue with Phase 7 (49 allergies and MAR, 50 ADT, 51 charge summary). 48a0 and 48b1b stay as written; 48b1a becomes O3.*
