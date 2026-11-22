# Chunk D1c-catalogue-discovery: Catalogue discovery and status labels

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: D1b, C7._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis-market.js`; templates.

**Build:**
1. Extend the index with filters: clinical concept, decision node, pathway, population, required data, setting, evidence status, compatibility.
2. Status labels draft | reviewed | validated | deprecated; `validated` requires a validation record naming exact version, population, setting and use; schema-valid alone never reaches `validated`.
3. Deprecation records a replacement pointer; resolve warns on deprecated packages.

**Done when:** discovery returns correct filtered results and refuses to label an unreviewed package validated.

**Size guard:** 1 module + tests.
