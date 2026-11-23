# Chunk DM4-demo-polish: Demo hardening, runbook, backup recording

_Needs: DM1, DM2b, DM3, CCIS DS7._ **Core rules:** attach `01-core.md`.
**Build:**
1. `docs/DEMO-RUNBOOK.md`: setup from a clean machine, reset, the exact click path, known limits, what is staged (listed honestly).
2. Persistent "Synthetic data, prototype" banner on every page; staged features labelled "planned".
3. One end-to-end test: seed -> envelope -> stub or real CLI -> import -> acknowledge.
4. Fix only rough edges on the demo path. No new features.
5. Checklist for you: record the screen backup, rehearse both cuts (clinician, technical).
**Done when:** the runbook reproduces the demo from scratch.
**Size guard:** docs + 1 test + banner edit.
