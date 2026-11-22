# Chunk B0-baseline-contract: Baseline contract: prototype objects to canonical entities (documentation only)

_Ch5 slice B0. Decision recorded 2026-11-22: the server becomes the system of record for cases, element sets, observations and notes; browser storage is a demo fallback only._

**Core rules:** attach `01-core.md` too.

**Read only:** `emr-enhancer.html`: `grep -n "vr_traj\|CASES\|customs\|migrateSet\|migrateFields\|signNote\|amendNote\|delRow"` and the shapes they use; `migrations/` (list); `sdc.js` exports; `DECISIONS.md` rows for tasks 1–3.

**Build:**
1. Create `CLINICAL_CONTEXT_MODEL.md` (root): one table mapping every current browser object (case, narrative, applied set, field, value/trajectory row, note, version, pathway, custom set) to its target entity and table from Ch5 section 4–5, with: stable identifiers, field keys, lifecycle states, what is lost or changed.
2. Record the explicit product rules: case is patient-owned with `case_encounters` join (Ch5 4.3); observations append-only with `effective_at` and `recorded_at`; corrections via `corrects_id` / `entered_in_error`; element sets and pathways use stable identity + immutable versions; cases pin exact versions.
3. List what is NOT moved yet (decision nodes, evidence, phenotypes, analytics tables) and the order of B1–B5.
4. No code, no migration. Ask the user to review the mapping before B1 starts.

**Done when:** one reviewed mapping document exists and every browser object has a target or an explicit 'stays in browser'.

**Size guard:** 1 new markdown file; no source edits. Use `grep`/`sed` ranges, never read the whole HTML.

**Notes:** This is the contract for B1–B5; later chunks cite its section numbers.
