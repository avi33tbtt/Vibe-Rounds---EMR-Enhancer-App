# Chunk B1b-cases-page: Cases in the page via a storage adapter

_Ch5 slice B1, page half. Needs: B1a._

**Core rules:** attach `01-core.md` too.

**Read only:** `emr-enhancer.html`: `grep -n "CASES\|vr_traj\|save()\|load()"` and the Cases tab; `test/ui.test.js`, `test/safety-browser.test.js`.

**Build:**
1. Introduce one storage adapter with two backends: `server` (when signed in) and `local` (file:// demo). Case list, create, open, title/status and narrative go through the adapter; when signed in nothing clinical is written to `localStorage`.
2. Handle 409 conflicts with a clear screen (reload / keep mine copy), never silent overwrite.
3. One-time explicit action 'Import local demo cases' (synthetic data only; shows what will be sent; audited server-side as an import).
4. Tests: case created in one jsdom session is listed in a second; restart-survival test at API level; signed-in session leaves `vr_traj` untouched; demo mode still works.

**Done when:** a synthetic case survives a server restart and appears in a second browser session; no clinical write reaches localStorage when signed in.

**Size guard:** Page + 1 test file. Cases and narrative only; values, sets and notes still use the old path until B3.

**Notes:** Keep the adapter small so B2b, B3b and B3c reuse it.
