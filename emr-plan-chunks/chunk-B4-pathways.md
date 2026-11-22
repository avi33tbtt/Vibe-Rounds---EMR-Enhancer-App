# Chunk B4-pathways: Pathway versions and composition

_Ch5 slice B4. Needs: B3a._

**Core rules:** attach `01-core.md` too.

**Read only:** `CLINICAL_CONTEXT_MODEL.md`; `sets.js`; `case_applied_sets` code from B3a; page pathway code via `grep -n "pathway"`.

**Build:**
1. Migration: `pathways`, `pathway_versions` (ordered steps, each referencing an exact `element_set_version_id`), `case_applied_pathways`. Same immutability, grants and audit rules as element sets.
2. Route: apply a pathway to a case; it creates traceable `case_applied_sets` rows with the source pathway version and keeps them independently removable.
3. Page: pathway library and apply action via the adapter; the user can remove sets after applying and the source pathway stays recorded.
4. Update the permission matrix and audit scenarios in `test/safety-routes.test.js` on purpose; a new route fails the build until you do.

**Done when:** applying a pathway creates traceable composition with no embedded mutable definitions.

**Size guard:** 1 migration + routes + page edit + tests. If the page change is large, split server (B4a) and page (B4b).
