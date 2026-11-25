# R0e: move the case workspace out of the page (split into R0e-1 to R0e-4)

**Context impact:** none. Verbatim moves, no behaviour change. Same rules as R0b to R0d: classic scripts, loaded before the inline script, top-level code is only function declarations and plain-value or arrow constants. Page state (`PIN`, `CASE`, `Srv` and so on) stays in the page.

Why split: four separate blocks, about 380 lines.

| Row | Moves | Notes |
|---|---|---|
| R0e-1 | Pins (B3b-1): `pinEntry`, `pinDef`, `pinsLoad`, `pinPost`, `applySetSrv`, `applyPathwaySrv`, `removeSetSrv`, `upgradeSrv` to `modules/80-pins.js` | Done. `savePatient`, `fillPatient`, `renderBanner`, `ctxDownload` sit after it and stay in the page. |
| R0e-2 | CCIS insights panel (DM2b) to `modules/82-insights.js` | |
| R0e-3 | Notes (B3c-2) to `modules/84-notes.js` | |
| R0e-4 | Values (B3b-2) to `modules/86-values.js`; then check the page only wires modules and no inline handler returned | Closes R0e. |
