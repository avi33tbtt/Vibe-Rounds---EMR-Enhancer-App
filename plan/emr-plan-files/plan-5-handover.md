# Phase 5 (rest): handover time

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 19. Phase 5 (rest): handover time

### 37d (rest). Handover: last-handover time

*Do after V6. The handover view already has a `newRows` section with `since:'lastHandover'`; these two tasks supply that time.*

#### [ ] 37d4. Last-handover time (server)
**Files:** api.js + one migration only if needed | **Paste:** the user_prefs routes
```text
Store a per-user "last handover" time per case in user_prefs (set by a POST that uses server time, read by GET). Add the action to permissions.js and the audit-coverage test.
```

#### [ ] 37d5. "Mark handover done" button (generic)
**Files:** enhancer.html, store.js | **Paste:** Store prefs methods, the section renderer for newRows
```text
In a case_tab whose sections include newRows with since 'lastHandover', show "Mark handover done" using the 37d4 route. ctx.sinceMs comes from it (default: start of the encounter). The button appears because of the section, not because of a tab name.
```

*Section 38 (shared analytics) is not built in the EMR; see 15.4.*
