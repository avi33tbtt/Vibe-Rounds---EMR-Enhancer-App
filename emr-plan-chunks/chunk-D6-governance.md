# Chunk D6-governance: External review and release governance

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: C9, D1c._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis/SPEC.md`; `ccis-market.js`.

**Build:**
1. Write `ccis/GOVERNANCE.md` and `ccis/CONTRIBUTING.md`: contribution process, reviewer roles and independence rule (author is never the reviewer), review decision record format, release checklist, deprecation policy, security response.
2. Add `ccis-release.js` checks: release requires passing conformance suite, validation records for any `validated` package, changelog entry and a reviewer decision record.

**Done when:** a dry-run release is blocked when any item is missing.

**Size guard:** docs + 1 small script + tests.
