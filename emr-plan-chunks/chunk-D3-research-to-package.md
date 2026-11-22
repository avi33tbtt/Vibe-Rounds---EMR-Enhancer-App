# Chunk D3-research-to-package: Research paper to analytics package (traceable)

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: D2c, D1a._

**Core rules:** attach `01-core.md` too.

**Read only:** Ch8 section 5 and 7 (supplied); `ccis-validate.js`.

**Build:**
1. Workflow: user supplies paper metadata and extracted statements; the assistant proposes variables, cohort rules and a template choice with a trace from each rule to a citation location; a human confirms each mapping.
2. Output is a package with `status: draft`, evidence items, assumptions and limitations; population, setting and intended use are mandatory fields.
3. Tests: untraceable rule is rejected; the generated package cannot reach `validated` without a human validation record.

**Done when:** a sample research statement becomes a traceable draft package that passes the validator.

**Size guard:** 1 module + route + tests; no paper ingestion pipeline yet (user pastes text).
