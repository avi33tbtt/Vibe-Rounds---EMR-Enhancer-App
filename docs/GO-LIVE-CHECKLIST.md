# Go-live checklist

**Status: not for clinical use until every box below is ticked by a person.** Source: the go-live gate line in `emr-plan-chunks/02-roadmap.md`. Synthetic data only until then (`emr-plan-chunks/01-core.md`).

A passing test is evidence, not sign-off. Claude does not tick boxes here; a named person does, by filling in the sign-off line. Items marked **PERSON** cannot be proven by code.

---

## 1. Clinician safety sign-off  (PERSON)

- [ ] A named clinician reviewed the app and its content and accepts it for the stated use.
- **Evidence that helps (not a sign-off):** `test/safety-content.test.js` (seed content has zero rules and zero bands); `test/lint.test.js` and `lint.js` (content lint); `DECISIONS.md`.
- **Open:** no clinician owner is named yet. Clinical rule content (thresholds, bands, medication safety, staging) stays disabled until one is. An independent clinical reviewer is needed before any package is labelled `validated`.
- **Owner:** `[name to be set]`
- Sign-off: ____________________  Date: ____________

## 2. Tested encrypted restore

- [ ] A backup was restored on a clean machine and the counts matched.
- **Evidence:** `scripts/backup.sh`, `scripts/restore.sh`, `scripts/verify-restore.sh`; `test/safety-backup.test.js`, `test/safety-restore.test.js`; record in `docs/RESTORE-TEST.md` (Run 1 sandbox, Run 2 clean machine).
- **Open:** the project owner reported Run 2 done on 2026-11-22, but the Run 2 table in `docs/RESTORE-TEST.md` has not been filled in. Fill it in, then sign here. Compose `backup` service has not been run as a scheduled job.
- **Owner:** project owner
- Sign-off: ____________________  Date: ____________

## 3. Security hardening and CI pass

- [ ] CI is green on GitHub on the commit to be released, and `main` requires it.
- [ ] A header scan of the deployed URL is recorded.
- **Evidence:** `.github/workflows/ci.yml` (runs `npm test`); `test/safety-hardening.test.js` (headers, Secure cookie, rate limits); `test/safety-csp.test.js` and `test/safety-handlers.test.js` (CSP, zero inline handlers); `test/safety-escaping.test.js`; `test/safety-routes.test.js` (permission matrix and audit); `test/safety-data.test.js` and `test/safety-migrations.test.js` (no DELETE/TRUNCATE, append-only audit); `test/safety-concurrency.test.js`. Scan template: `docs/POLICY.md`.
- **Open (only you can do):** the CI workflow has never run on GitHub; turn on branch protection for `main` and require the `test` check; do the header scan after deploying; Node 20 and other PostgreSQL versions are untested; the Render deployment of the restricted role is untried.
- **Owner:** project owner
- Sign-off: ____________________  Date: ____________

## 4. Two-browser checks  (PERSON)

- [ ] The app was used end to end in two different real browsers, and in two sessions at once.
- **Evidence that helps:** `test/safety-browser.test.js` (one real Chrome smoke test: sign in, open a case, enter a value, export); `test/safety-concurrency.test.js` (two writers at the same moment get a clear conflict).
- **Open:** the plan does not define this item further. This checklist reads it as (a) a second browser engine besides Chrome and (b) two simultaneous users. Only Chrome is automated. Tell me if you meant something else.
- **Owner:** `[name to be set]`
- Sign-off: ____________________  Date: ____________

## 5. AI server-side and off by default

- [ ] AI is off on the deployed system, the key exists only on the server, and the admin has chosen deliberately whether to turn it on.
- **Evidence:** `ai.js`; `test/ai.test.js` (setting is off by default, only admin can change it, payload whitelist); `test/ai-ui.test.js` (no key, provider or model fields in the page).
- **Open:** only the mock provider was tested; one real provider call (`AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`) has not been tried. `docs/POLICY.md` section 3 item 5: whether AI use needs separate patient information.
- **Owner:** project owner
- Sign-off: ____________________  Date: ____________

## 6. Device-software and health-data rules checked  (PERSON)

- [ ] An adviser confirmed whether this software counts as a regulated medical device and which health-data rules apply where it is used.
- **Evidence:** none in code. The questions are listed in `docs/POLICY.md` section 3 (items 1, 2 and 4). Retention, subject-access and consent decisions are in sections 1 to 3 of the same file, still open.
- **Owner:** `[legal / regulatory adviser to be set]`
- Sign-off: ____________________  Date: ____________

## 7. Terminology licences checked  (PERSON)

- [ ] Licence terms were checked for every code system that is enabled.
- **Evidence that helps:** each registry entry has a `licenceNote` in `emr-enhancer.html`; unverified codes are never exported as FHIR `Coding` (`test/safety-content.test.js`). `docs/POLICY.md` section 3 item 3.
- **Open:** SNOMED CT, LOINC and RxNorm are enabled and need checking for the country of use; CPT is present but off.
- **Owner:** `[adviser to be set]`
- Sign-off: ____________________  Date: ____________

---

## Also before go-live

- [ ] `docs/DOWNTIME.md` placeholders filled in and one downtime drill recorded (owner: `[to be set]`).
- [ ] `docs/POLICY.md` placeholders replaced (retention period, request contact, patient notice text).
- [ ] Go-live decision owner named, with date of decision: `[to be set]`.

**Final go-live decision:** ____________________  Date: ____________
