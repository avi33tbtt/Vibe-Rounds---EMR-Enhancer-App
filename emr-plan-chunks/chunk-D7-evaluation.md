# Chunk D7-evaluation: Clinical quality and operational reliability evaluation

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: D4c._

**Core rules:** attach `01-core.md` too.

**Read only:** CI workflow; test suites.

**Build:**
1. Add a conformance job to CI (CCIS suite as its own check), and an evaluation script that reports: reproducibility (identical reruns), fixture coverage by class, runtime step/time budget, diagnostic quality (every rule has a test).
2. Write `ccis/EVALUATION.md` listing what is measured, what is NOT measured (clinical correctness) and the failure modes watched. Record the Avinash Principle operational definition as a hypothesis with comparator and failure modes (Ch5 B11) before any implementation of it.

**Done when:** CI reports the evaluation metrics and fails on a reproducibility break.

**Size guard:** 1 workflow edit + 1 script + docs.
