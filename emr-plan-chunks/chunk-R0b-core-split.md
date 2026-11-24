# R0b: move shared core out of the page (split into R0b-1 to R0b-3)

**Context impact:** none. No behaviour change. Classic scripts, load order fixed by the page (see R0a).

Why split: four moves (escaper, session, storage adapter, action table + listener) are about 200 lines with many ties to page state; the guard is one module per row.

| Row | Moves | Notes |
|---|---|---|
| R0b-1 | `escA`, `jsA` to `modules/10-escape.js`; `Srv`, `SEXL`, `srvCan`, `caseName`, `caseMrn`, `api`, `apiMsg`, `user` to `modules/20-session.js` | Verbatim. Nothing runs at load. |
| R0b-2 | Storage adapter (`srvMode`, `Store`, `interimRead/Write`, `fromRow`, `storeEnter/Leave/Flush`, `doFlush`, `storeLoadCases` and the case-list helpers beside them) to `modules/30-store.js` | Reads page state (`CASES`, `CASE`, `REGISTRY`) only at call time. Check TDZ: those `let`s stay in the page. |
| R0b-3 | `ACT` table and the delegated-listener IIFE to `modules/90-wire.js` | Entries are arrows (call-time lookup). The ratchet regex `const ACT=\{...\n\};` runs on `pageSource()` and must still match. |

Each row: new test checks load order, that the page no longer defines the moved names inline, and one behaviour check; 2 or 3 breakages; one `npm test`.
