# Chunk B2b-element-sets-page: Library and case composition use server versions (page)

_Ch5 slice B2, page half. Needs: B2a, B1b._

**Core rules:** attach `01-core.md` too.

**Read only:** `emr-enhancer.html`: `grep -n "customs\|applySet\|library\|vr_codes\|version"`; adapter from B1b.

**Build:**
1. Library tab reads sets from the server when signed in; one-time import of the minimum demo library (snake envenomation, DKA, glucose monitoring, basic template) as published v1 with a reviewer.
2. Applying a set to a case records the exact `element_set_version_id`; a later library edit never changes the case. Updating to a newer version is an explicit action with a visible diff.
3. Tests: apply v1, publish v2, case still shows v1 until the user updates; export uses the pinned version.

**Done when:** a case applies and pins one exact set version and a later library edit does not mutate it.

**Size guard:** Page + 1 test file; applied-set storage on the server comes in B3a, so this row stores the pin through the case API field `pinned_versions` (temporary) or is merged into B3a if that is smaller.

**Notes:** If the temporary field would be thrown away in B3a, merge B2b into B3a/B3b instead and record it.
