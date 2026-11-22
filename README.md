# EMR Enhancer

Prototype. **Synthetic data only, not for clinical use.**

- `emr-enhancer.html` is the app (Case, Patients, Cases, Library, Create, Notes, Codes tabs).
- Server: Node.js + PostgreSQL, flat repo root (`server.js`, `app.js`, `auth.js`, `audit.js`, `permissions.js`, `ai.js`, `deid.js`, `migrations/`).

## Run

```
npm install
export DATABASE_URL=postgres://USER@localhost:5432/emr
npm run migrate                    # numbered migrations, never edit an applied one
SEED_PASSWORD='pick-one' npm run seed   # users: admin1, doctor1, nurse1, viewer1
npm start                          # http://127.0.0.1:3000
```

Opening `emr-enhancer.html` directly as a file still works as the demo; registration needs the server. The page loads `sdc.js` (the shared FHIR SDC code, also used by the server), so keep it in the same folder as the HTML.

## Run with Docker and HTTPS

`docker compose up` starts the whole stack: `db` (PostgreSQL 16), two one-shot steps (`migrate` runs the migrations as the owner; `db-role` sets the `emr_app` login password), `app` (the server, running as the restricted `emr_app` role) and `caddy` (the reverse proxy that does the TLS). Only ports 80 and 443 are published; the app has no published port, and the database port is bound to this machine only (127.0.0.1). The three steps:

```
cp env.txt .env                              # then edit .env: POSTGRES_PASSWORD, EMR_APP_PASSWORD, SEED_PASSWORD, SITE_ADDRESS
docker compose up -d --build                 # builds the image, migrates, starts the app and the proxy
docker compose run --rm app node seed.js     # once: creates admin1, doctor1, nurse1, viewer1 with SEED_PASSWORD
```

Then open `https://localhost` (or your domain) and sign in as `admin1`.

- **Secrets:** `.env` is gitignored. Use only letters and digits in `POSTGRES_PASSWORD` and `EMR_APP_PASSWORD` (they go inside connection URLs). `EMR_APP_PASSWORD` must be set or `db-role` stops the start with a clear message. The `DATABASE_URL` lines in `.env` are for `npm start` and `npm test` only; Compose builds its own database URLs for the containers.
- **Local trial (`SITE_ADDRESS=localhost`):** Caddy makes its own certificate, so the browser warns until you trust it: `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt`, then import that file into your browser or system. A quick check without the browser: `curl -k https://localhost/`. `HTTPS=1` (the default here) also sends the HSTS header, which makes a browser insist on HTTPS for that host name; if that gets in the way of plain-http dev on `localhost`, set `HTTPS=0` in `.env` for the trial only.
- **Real domain:** set `SITE_ADDRESS=emr.example.org`, point its DNS at the server, and keep ports 80 and 443 open: Caddy then gets and renews a public certificate by itself. Keep `HTTPS=1`.
- **Day to day:** `docker compose down` stops everything and keeps the data (the `pgdata` volume); `docker compose down -v` also wipes the database. After `git pull`, run `docker compose up -d --build`; new migrations apply on their own.
- **Tests and local dev** still use only the database: `npm run db:up` starts just `db`.
- Still **synthetic data only**; do not expose a real deployment before the go-live gate in the tracker.

## Encrypted backups

`scripts/backup.sh` dumps the whole database (`audit_log` included) with `pg_dump`, encrypts it with [age](https://github.com/FiloSottile/age) straight from the pipe (no plain copy is written), and saves `emr-<UTC time>.dump.age` plus a `.sha256` file. It keeps the newest `BACKUP_KEEP` (default 14) and removes older ones. It encrypts to a **public** key, so the server can write backups but cannot read them. Restoring is chunk 7c.

1. **Make the key pair on a different machine** (your own computer, not the server). Install age, then: `age-keygen -o backup-key.txt`. It prints `Public key: age1...`. Keep `backup-key.txt` somewhere safe and off the server (a password manager or an offline disk). **If it is lost, the backups cannot be opened.**
2. Put only the public key in `.env`: `BACKUP_AGE_RECIPIENT=age1...`
3. Start the backup service: `docker compose --profile backup up -d --build`. It backs up at once and then every `BACKUP_INTERVAL_HOURS` (default 24). Files appear in `./backups` (set `BACKUP_DIR` to change it; the folder is gitignored). Check it with `docker compose logs backup`. A failed run says so in the log and retries after an hour.
4. **Copy `./backups` to another place** (another machine or storage) on a schedule you control. Backups on the same disk as the database do not survive that disk dying.

Check that a backup is intact and unreadable without the key (PowerShell users: use `-o`, because `>` would damage a binary file):

```
sha256sum -c emr-<time>.dump.age.sha256              # PowerShell: Get-FileHash <file> -Algorithm SHA256 (compare with the .sha256 file)
age -d -i backup-key.txt -o check.dump emr-<time>.dump.age    # works only with the private key
pg_restore -l check.dump                               # lists the tables, including audit_log; then delete check.dump
```

Without the private key the file is just random bytes starting with `age-encryption.org`. `test/safety-backup.test.js` proves this on every run: the script, the checksum, the wrong-key failure and the keep-N rule. It needs `age` and `pg_dump` installed (CI installs them). One-off run without Docker: `BACKUP_AGE_RECIPIENT=age1... BACKUP_DIR=./backups BACKUP_DATABASE_URL=$DATABASE_URL bash scripts/backup.sh`.

## Database roles (restricted app role)

Migration `005_app_role.sql` creates `emr_app`, a role that owns nothing: it cannot `DROP`/`ALTER`/`CREATE`, has no `DELETE` or `TRUNCATE` on `patients`, `encounters` or `audit_log`, and only the grants the code uses. `TRUNCATE` on `patients`/`encounters`/`audit_log` is also refused by trigger, even for the owner. For real use run migrations as the owner and the server as `emr_app`:

```
psql "$MIGRATE_DATABASE_URL" -c "ALTER ROLE emr_app LOGIN PASSWORD 'choose-a-long-secret'"   # once, never in git
export MIGRATE_DATABASE_URL=postgres://OWNER:...@host:5432/emr     # migrations + seed
export DATABASE_URL=postgres://emr_app:choose-a-long-secret@host:5432/emr   # the server
```

Without `MIGRATE_DATABASE_URL` the server migrates and runs on `DATABASE_URL` and warns that it has owner rights (local dev only). A new migration that adds a table must grant `emr_app` only what the code needs; a test fails if `DELETE`/`TRUNCATE` is ever granted outside `sessions`. The owner needs `CREATEROLE` for the first run (superuser locally); on a managed database, check that your owner user may create roles.

## Roles (enforced on the server, see `permissions.js`)

| Role | Read patients | Register | Archive/restore | Open/close encounters | Audit log | Use AI | AI switch and limits |
|------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| admin | yes | yes | yes | yes | yes | yes | yes |
| doctor | yes | yes | yes | yes | | yes | |
| nurse | yes | yes | | yes | | | |
| viewer | yes | | | | | | |

## AI (server-side, off by default)

The browser never talks to an AI provider and never holds a key. The server does (`ai.js`, `deid.js`).

1. Put the key in the **server environment** (local `.env`, or Render's Environment tab). It is never stored in the database or in git:
   ```
   AI_PROVIDER=openrouter        # or anthropic
   AI_API_KEY=...
   AI_MODEL=...                  # optional; an admin can override it in Settings
   ```
2. Sign in as an admin, open Settings, tick **Enable AI**, set the model and the request limits, Save. Until then every AI call is refused and the AI buttons are disabled.
3. A doctor or admin clicks an AI button. The server removes identifying details (registered names and MRNs, dates, phones, emails, ages, bed numbers), builds the exact provider request and shows it. Only after **Send** does the server send that stored request, once.
4. Every call is audited (`ai.request`, `ai.result`; refusals as `ai.refused`; switch changes as `ai.settings`). The audit stores counts, a hash and the outcome, not the text and never the key.

The de-identification is a safety net, not a guarantee. Enter the diagnosis only. Synthetic data only.

## Test

One command runs everything (the 54 feature tests and the safety pack):

```
export TEST_DATABASE_URL=postgres://USER@localhost:5432/emr_test   # a scratch database, WIPED each run
cp env.txt .env                                                    # once; the npm scripts read it
npm test
```

The safety pack (`test/safety-*.test.js`) guards the rules that must never break: the permission matrix (every route x every role), concurrent writers, audit coverage, no rules or bands in seed content, migrations from empty and from every earlier version, verified-only FHIR export, no hard delete and immutable signed notes, and one smoke test in a real browser (sign in, open a case, enter a value, export). A route that is not in the matrix, or a write route with no audit scenario, fails the build until it is added.

The browser test needs Google Chrome (or set `CHROME_PATH`). Without one it is skipped on your machine; with `CI=true` it fails instead of skipping.

**CI:** `.github/workflows/ci.yml` runs `npm test` on every push and pull request against PostgreSQL 16 and fails on any break. To make a red run block merging, turn on branch protection for `main` in GitHub (Settings, Branches) and require the `test` check.
