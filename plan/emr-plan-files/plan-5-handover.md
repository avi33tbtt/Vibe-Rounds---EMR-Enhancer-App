# Phase 5 (rest): handover time

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 19. Phase 5 (rest): handover time

### 37d (rest). Handover: last-handover time

*Do after V6. The handover view already has a `newRows` section with `since:'lastHandover'`; these two tasks supply that time.*

#### [x] 37d4. Last-handover time (server)
**Files:** api.js + one migration only if needed | **Paste:** the user_prefs routes
```text
Store a per-user "last handover" time per case in user_prefs (set by a POST that uses server time, read by GET). Add the action to permissions.js and the audit-coverage test.
```
*Done (20 Nov 2026): `GET` and `POST /api/cases/:id/handover` in api.js; the time is the server's and lives in `user_prefs` under `handover.<caseId>` (per user and case, no migration). New action `handover.mark` (admin, doctor, nurse); reading is `case.read`. `PUT /prefs/handover.…` is refused (400). Audit row `handover.mark` with the earlier time as before. Tests: `handover-mark.test.js`; audit-coverage entry added to the list in `audit.test.js` (one line after the alert-acks entry). For 37d5: the screen reads `lastHandoverAt` (ISO text) from GET and calls POST for "Mark handover done".*

#### [x] 37d5. "Mark handover done" button (generic)
**Files:** enhancer.html, store.js | **Paste:** Store prefs methods, the section renderer for newRows
```text
In a case_tab whose sections include newRows with since 'lastHandover', show "Mark handover done" using the 37d4 route. ctx.sinceMs comes from it (default: start of the encounter). The button appears because of the section, not because of a tab name.
```

*Done (20 Nov 2026): `Store.handover.get/mark` in store.js (server mode only, not queued, no cache in Store). In enhancer.html the `newRows` section renderer draws the "Mark handover done" button when its spec has `since:'lastHandover'`, the server mode is on and the role has `handover.mark`; no tab name is checked. `handoverRender` picks the since time: the marked time from GET, else the encounter start (`encounterRecord.startAt`), else the 8/12/24 h window. The time is refetched at most once a minute and after each mark. Demo mode and handoverHtml callers without the new argument behave as before. Not yet tested: add a small vm test for the section renderer (button only with `since:'lastHandover'` and `can`).*

*Section 38 (shared analytics) is not built in the EMR; see 15.4.*
