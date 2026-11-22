# Chunk D2c-llm-drafting: LLM-assisted drafting for graphs and templates (governed)

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: D2b, 4b AI gateway._

**Core rules:** attach `01-core.md` too.

**Read only:** `ai.js`, `deid.js`, `permissions.js`; `ccis-validate.js`.

**Build:**
1. Add an AI route that receives only a clinical specification text and artefact type (whitelist, no patient data) and returns a DRAFT artefact; it passes through the same validator and is stored with status `draft` and `source: llm`.
2. The route cannot publish, review or mark validated; a human reviewer action is required. Preview and audit follow the existing two-step pattern (`ai.request`, `ai.result`).
3. Tests: draft with invalid structure is returned with diagnostics, not stored as valid; no doses or bands are accepted from the model (lint rule).

**Done when:** drafting works under the existing AI switch and every output is a validated draft only.

**Size guard:** 1 route file + tests; reuse the existing AI preview/run pattern.
