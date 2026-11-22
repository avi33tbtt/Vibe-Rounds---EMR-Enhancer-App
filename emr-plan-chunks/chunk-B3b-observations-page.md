# Chunk B3b-observations-page: Values, trajectories and entered-in-error in the page

_Ch5 slice B3, page half. Closes known gap (b) (`delRow` splices rows). Needs: B3a, 8f done._

**Core rules:** attach `01-core.md` too.

**Read only:** `emr-enhancer.html`: `grep -n "delRow\|traj\|addRow\|trend"`; adapter; `test/safety-data.test.js`.

**Build:**
1. Route all value entry, repeat rows and trajectory display through the adapter; trend views sort by effective time and can show recorded time.
2. Replace remaining row splicing with the server 'entered in error' action (row stays visible as struck-through with reason).
3. Convert test.todo (b) into real tests; add: signed-in sessions never write observations to localStorage.

**Done when:** no code path removes an observation; trajectories load from the server; todo (b) passes server-side.

**Size guard:** Page + 1 test file; values only. Notes remain on the old path until B3c.
