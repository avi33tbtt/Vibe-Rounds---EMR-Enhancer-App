# Chunk D2b-graph-code-authoring: Decision graph authoring: code/structured editor

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: D2a._

**Core rules:** attach `01-core.md` too.

**Read only:** `ccis-compile.js`; page patterns.

**Build:**
1. Page or CLI structured editor: edit JSON with live validator diagnostics, show a readable graph preview, produce a diff against the previous version.
2. Equivalence test: graph built via the editor equals the hand-written graph byte for byte after compile.

**Done when:** an author can edit, validate and compare graph versions with actionable diagnostics.

**Size guard:** 1 page section or CLI + tests. The visual node builder is a later row.
