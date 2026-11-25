# R0c: move screens group 1 out of the page (split into R0c-1 and R0c-2)

**Context impact:** none. Verbatim moves, no behaviour change. Same rules as R0b: classic scripts, loaded before the inline script, only function declarations at top level (nothing runs at load).

Why split: group 1 is about 215 lines in three separate blocks.

| Row | Moves | Notes |
|---|---|---|
| R0c-1 | Sign-in display and patients tab and encounters (`renderWho` to `encClose`, one contiguous block) to `modules/40-patients.js` | Done. |
| R0c-2 | Cases list: `newCase`, `openCase*`, `archiveCase*`, `restoreCase*`, `renderCases`, `casesShow`, `caseTitleNow`, `ptOpenCaseSrv`, `newCaseSrv`, `opSend`, `opRun`, `caseSaveMeta`, `renderSrvCase` to `modules/50-cases.js` | Stop before `ctxDownload` and the CCIS block (those are R0e). Check `const` items (`caseTitleNow`, `EDITABLE_STATUS`) are only used at call time. |
