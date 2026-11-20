# Phase S: Summary

*Part of the EMR Enhancer plan (v6, 20 Nov 2026). Give this file together with `plan-core.md`. Tick `[ ]` to `[x]` here as each task is done. If a task's Paste line names a section that is not in this file (for example "section 9" or "7.1"), the section map in `plan-core.md` says which file holds it.*

## 23. Phase S: Summary

#### [ ] S1. `cardFor(set, elements)` (pure)
**File:** views.js or elements.js | **Paste:** the table in 8.1
```text
Pure function returning a card description (label, latest value, unit, age, count) chosen by the role of the set's main field. Tests with made-up sets for each role; no set ids in the function.
```
#### [ ] S2. Summary renders cards for every applied set
**File:** enhancer.html | **Paste:** the Summary tab renderer
```text
Use cardFor for each applied set; no per-set code. Output must match the present Summary for the seed sets (compare by hand).
```
#### [ ] S3. Layout data type
**Files:** views.js, enhancer.html | **Paste:** VIEWS.md surface list
```text
Add contexts ['summary'] definitions that order, hide or override the window of cards by slot, validated with validatePathwayViews rules (no thresholds). An unmet slot hides that part with a plain note.
```
**Gate 3 (before Orders):** you read the Summary, the coverage reports and the analytics output on synthetic data and agree the wording shows no judgement.
