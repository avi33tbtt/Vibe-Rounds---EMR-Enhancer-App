# Demo runbook (row DM4c, 2026-11-23)

**Synthetic data only. Prototype. Not for clinical use.** Story and talking points: `docs/DEMO-SCRIPT.md` (step numbers below match it).

Status of this file: written from the repo, **not yet followed on a clean machine**. The "Done when" test for this row is yours: follow it once from scratch and fix what it gets wrong (section 7).

## 1. What you need
- Node 20 or newer, Docker Desktop (for PostgreSQL only), Git.
- This repo and the CCIS repo (https://github.com/avi33tbtt/Vibe-Rounds---CCIS) checked out as sibling folders, for example `~/emr` and `~/ccis`. Use the CCIS commit your CCIS tracker marks as DS7 `DONE` (check that tracker; this repo cannot see it).
- Nothing leaves the machine: no network is used between the two apps (files and a child process only).

## 2. Setup from a clean machine
```
cd emr
npm install
cp env.txt .env
```
Edit `.env`:
- `SEED_PASSWORD=` any password you will remember (the demo users get it).
- `CONTEXT_REF_SECRET=` 32 or more random characters (without it the envelope route answers 503). Do not change it after you export.
- `CCIS_PATH=` full path to the CCIS folder (for example `/home/you/ccis`).
- Leave the Postgres lines as they are for the local trial.

Then:
```
npm run db:up           # PostgreSQL in Docker
npm run migrate
npm run seed            # users: admin1, doctor1, nurse1, viewer1, informatician1, informatician2
npm run demo:seed       # patient "DEMO, Patient A" and one demo case, through the real routes
npm start               # http://127.0.0.1:3000 (leave running; use a second terminal below)
```
`npm run demo:seed` prints the case id. Write it down (it is also visible in the page).

## 3. Reset between rehearsals
```
npm run demo:reset
```
Archives the old demo case (never deletes) and makes a fresh one; prints the new case id. Imported runs stay with the archived case. For a completely empty start: `npm run db:down` then `docker compose down -v`, and repeat section 2.

## 4. Click path (matches DEMO-SCRIPT steps)
1. Sign in as `doctor1`. Open the Cases tab, open "DEMO snake bite case (synthetic)". Show the pinned pathway and its exact version (step 1). The top banner says synthetic data, prototype.
2. Show the timeline: 8 values, one `Unknown` (clotting result), one never recorded (antivenom start time) (step 2).
3. Click **Download context envelope**. Show that name, ID and narrative are absent; show the hash in the info line (step 3).
4. In the second terminal, with the server running:
   ```
   npm run demo:run -- <case id> --demo-parameters
   ```
   This exports the envelope again, maps it, runs the CCIS CLI in `CCIS_PATH`, and imports the run record. It prints `Imported run <id> (completed)`. Files are in `demo-out/` (git-ignored): `*.json` envelope, `*.ccis-input.json`, `*.run-record.json` (step 4). Running it again with the same record prints `Already imported`; a new export makes a new run.
   Without `--demo-parameters` the CCIS outputs that need a parameter show "not enabled": that is the honest default and also worth showing.
5. Back in the page, open the case: **CCIS insights** panel (step 5). Open the run. Show the metric, "not enabled" or "missing data" items, package and engine versions, and the "demo parameters are test-only placeholders" banner.
6. Click **Acknowledge** (optional note). Show that the run shows who acknowledged; observations and notes did not change (step 6).
7. Platform moment and roadmap slide come from the CCIS app (step 7); this repo has nothing to click for it.

You can also use **Import run record** in the page to load a record file by hand instead of step 4's import.

## 5. Known limits (say them, do not hide them)
- Prototype: no clinical validation, no go-live gate. Synthetic data only.
- Only one CCIS package is mapped: the snake envenomation demo set at EMR version 1.0.0 -> CCIS 0.1.0. Any other set or version makes the bridge stop with an error (by design).
- Demo parameters are placeholders from no clinician. No doses, no thresholds, no recommendations.
- The automated end-to-end test (`test/demo-e2e.test.js`) uses a stub CLI. A real CLI run is checked only by following this runbook.
- The page was not tried in a real browser by the build sessions; do a full look-through yourself.
- `demo:run` talks to a running server; `demo:seed` and `demo:reset` start their own and need the Postgres container up.

## 6. Staged or absent (list honestly if asked)
Terminology server (the Verify buttons call a public test server and are labelled "planned"), orders and results, medications, IPD, full FHIR export of all record types, the cohort engine and the cohort exporter (D8b), a second CCIS package, real AI provider.

## 7. Your checklist (Claude cannot do these)
- [ ] Follow sections 2 to 4 once on a clean machine or a fresh folder; note every step that failed and send it back.
- [ ] Confirm the CCIS tracker shows DS7 `DONE` and that `npm run demo:run -- <id> --demo-parameters` reaches `completed` with the real CLI.
- [ ] Record the screen backup of the whole click path (all steps, including the acknowledge) in case the live demo fails. Store it off the demo machine.
- [ ] Rehearse the **clinician cut** (steps 1, 2, 5, 6) once, out loud, with a timer.
- [ ] Rehearse the **technical cut** (steps 3, 4, 7 plus the architecture diagram) once, out loud, with a timer.
- [ ] Before each live demo: `npm run demo:reset`, restart the server, check the banner is visible, check the Wi-Fi is not needed.
- [ ] Review `docs/DEMO-SCRIPT.md` (still marked DRAFT).
