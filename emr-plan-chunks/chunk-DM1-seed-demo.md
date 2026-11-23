# Chunk DM1-seed-demo: One-command demo seed and reset

_Needs: B5b._ **Core rules:** attach `01-core.md`.
**Read only:** `seed.js`; `docs/DEMO-SCRIPT.md`; `migrate.js`; `ccis/fixtures/snake/normal/` (CCIS repo, for realistic values).

**Build:**
1. `scripts/seed-demo.js` plus npm script `demo:seed`: creates (idempotently) one synthetic patient, one case with the snake-envenomation pathway pinned at published versions, and about 8 timed observations (effective times spread over hours, one deliberately missing item, one `unknown`) as DEMO-SCRIPT step 2 requires. Goes through the same server code paths as the app (no direct SQL into clinical tables except via existing modules).
2. `npm run demo:reset`: archives the previous demo case and recreates it (never deletes).
3. Patient name and ids clearly synthetic ("DEMO, Patient A").
4. Test: seeding twice gives one demo case; the envelope (B5a) of the seeded case validates.

**Done when:** one command gives a ready demo patient.
**Size guard:** 1 script, 1 test. No page change.
