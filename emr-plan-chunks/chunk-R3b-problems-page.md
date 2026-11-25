# R3b: problems in the page (docs, written before the build)

Goal: a Problems tab that shows and edits the open case's PATIENT problem list, using only the R3a routes. Server data only; nothing is stored in the browser.

## Behaviour
- Tab `Problems` (`data-t="problems"`, `id="navProblems"`), hidden unless `problems:read`. Patient = the open case's `patientId`; no patient: a message to open a patient's case first, no request.
- List: label, onset date (or "unknown"), status badge, who and when (server values), resolution or error reason. Entered-in-error rows only when "Show entered in error" is ticked (`?include=all`), shown struck through.
- Add (`problems:write`): label (1..200) and optional onset date; `originCaseId` sent only when the open case is a saved server case. Nothing else is sent.
- Resolve and Entered in error (`problems:write`): reason required (1..1000), sends the loaded `rowVersion`; 409 reloads the list and shows the server message. Final rows show no buttons.
- The server decides; the page shows buttons by permission and status. All text escaped. No label or reason in any log.

## Files
`modules/77-problems.js` (after 75-terms), page (tab, pane, script tag, nav hook), `modules/40-patients.js` (renderWho hook), `modules/90-wire.js` (5 actions), `test/problems-page.test.js`; adjacency asserts in two older tests move by one.

Context impact: none (envelope sections come in R3i). Browser: not tried (jsdom only).
