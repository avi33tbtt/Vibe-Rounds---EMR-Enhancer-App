# Chunk 08d: Review screens and tier badges

_Part 5 of original chunk 08 plus the page side._

**Core rules:** attach `01-core.md` too.

**Read only:** `emr-enhancer.html` via grep for the set library and Create tab render functions; `test/create.test.js` for jsdom page-test style.

**Build:**
1. 'Submit for review' on a set (shows lint errors and warnings from the server).
2. Badges: `local draft` (not submitted or in review), `local reviewed` (approved), with the version number; approved shows as frozen, edit starts a new draft.
3. A reviewer queue screen for the informatician role: list, lint results, approve/reject with reason, shows who reviewed and when (server values). Escape all text (use the 6a escaper).
4. jsdom tests for the buttons, badges and role visibility.

**Done when:** an author sees badges and can submit; an informatician sees the queue; a nurse or viewer sees neither action.

**Size guard:** Page plus one test file. If the page edit grows past about 200 lines, split queue screen from badges.
