# Chunk R6f-3: Bundle staging in the page

Context impact: none (no envelope change). Server routes are R6f-2a to R6f-2c, unchanged. Module: `modules/89-bundles.js`.

## What the person sees
A new tab **Import** (shown only with `import:write`). It has:
1. **Choose a file** (a FHIR Bundle, `.json`, 2 MB at most). The page sends the parsed JSON as the body of `POST /api/import/bundles` and nothing else. A refused bundle shows the server's message. A bundle staged before (409) opens the first one.
2. **Staged bundles** (`GET /api/import/bundles`): date, who staged it, counts (staged, rejected, accepted). Click one to read it (`GET /api/import/bundles/:id`).
3. **One bundle**: summary counts, bundle warnings, and each proposal with its kind, fields (escaped text), blockers (red), warnings, and status.
4. **The chart is the chart that is open** (Case tab). The page shows its name and MRN on every accept button and in the confirm box. Nothing is matched from the file. With no registered chart open, accept is not offered.
5. **Accept** (only for a staged, ready proposal): Observation needs the person to pick an applied set and field of the open chart (non-derived fields only) and uses `POST .../accept` (needs `cases:write`); Condition and AllergyIntolerance use `POST .../accept-to-patient` with the open chart's patient and case as origin (need `problems:write` or `allergies:write`). A MedicationRequest and any blocked proposal have no accept button, with the reason shown.
6. **Reject**: reason required (1 to 1000 characters), sends `reason` and the loaded `rowVersion` only.

## Rules
- Server decides everything; the page only hides buttons the role cannot use and shows the server's own message. No inline handlers, no browser storage, all text escaped.
- Only whitelisted fields are ever sent (accept: `rowVersion`, `caseId`, `appliedSetId`, `fieldKey` or `rowVersion`, `patientId`, `originCaseId`; reject: `reason`, `rowVersion`). No user, time or status from the page.
- After any success or a 409 the bundle reloads (new row versions). Sign-out or a different open chart never leaves stale accept buttons: the chart is read again at each draw.
- Imported values are drafts: the page says that accepted observations start as preliminary with source imported, and a problem or allergy starts active.

## Tests (`test/bundle-page.test.js`)
Module order and wiring, tab and pane, no inline handlers or storage; role gating of the tab; upload sends only the parsed bundle; 409 opens the first bundle; escaping; blocked, medication and non-staged proposals have no accept; accept bodies exactly as listed; confirm names the chart; reject needs a reason; stale/refused messages; sign-out clears.
