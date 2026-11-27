Starter local terms
===================
Copy the files in this zip into your repo, keeping the folder paths (scripts/, modules/, package.json).

Then, with the database running and SEED_PASSWORD in .env (same as used for "npm run seed"):

    npm run terms:starter

This adds 55 plain-word terms (findings, conditions, tests, procedures, observations, drug names)
and takes each through the real rules: doctor1 adds -> doctor1 submits -> informatician1 approves -> admin1 publishes.
Safe to run again. "npm run terms:starter:reset" retires and re-publishes them.

Optional: "npm run terms:seed" adds the 12 older demo terms, then "npm run terms:bind" binds local codes to the demo sets
(needs the demo library published first).

Then restart the server and refresh the browser. Local terms tab = the list; Orders tab = drug picker.
Edit the list in scripts/seed-starter-terms.js to use your own wording. Plain words only, no doses or thresholds.

This zip also includes the earlier Publish button fix (modules/70-review.js, modules/90-wire.js).
Not run end to end here (no database available); syntax and term rules were checked.
