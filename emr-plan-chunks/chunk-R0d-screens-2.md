# R0d: move screens group 2 out of the page (split into R0d-1 and R0d-2)

**Context impact:** none. Verbatim moves, no behaviour change. Same rules as R0b and R0c: classic scripts, loaded before the inline script, top-level code is only function declarations and plain-value or arrow constants.

Why split: the group is three consecutive sections, about 243 lines.

| Row | Moves | Notes |
|---|---|---|
| R0d-1 | "Server library (B2b-1)": `LIB`, `libDef`, `libApply`, `libLoad`, `pwLoad`, `renderLibSrv`, `libImport`, `libPwImport`, `pwTodo` and the constants to `modules/60-library.js` | Done. Pathways library is inside this section. |
| R0d-2 | "Set versions" (8d-2) and "Reviewer queue" (8d-1) to `modules/70-review.js` | About 120 lines. Check their top-level constants the same way. |
