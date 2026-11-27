EMR chart-style update
======================
Copy every file in this zip into your repo, keeping the folder paths, then commit and push (Render redeploys from GitHub).

What changed
- Patient alert strip under the banner: active allergies (red), active problems, abnormal results waiting.
- New Summary tab: demographics, allergies, problems, medications, active orders, abnormal results, latest notes, quick links.
- Tabs regrouped (Patients, Summary, Case, Notes, Problems ... | Cases, Import, Create | Library, Review, Local terms, Codes). Nothing removed.
- After sign-in you land on Patients; opening a patient lands on its Summary.
- Publish button for approved sets (Library > Set versions, admin).
- scripts/seed-starter-terms.js (npm run terms:starter) and scripts/publish-demo-library.js (npm run library:publish).

Render start command, first deploy only (then back to: node server.js):
  node seed.js && node scripts/seed-starter-terms.js && node scripts/publish-demo-library.js && node server.js

Tests: checked on a local Postgres. Some tests in the repo already fail on the original code in my sandbox
(e.g. allergies-page script-order test, several "no request is made" tests that see /api/me), so a few red tests are not from this update.
The one test I changed is test/safety-browser.test.js (opening a case now lands on Summary).
