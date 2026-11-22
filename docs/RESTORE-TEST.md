# Restore test record (chunk 7c)

Synthetic data only. This file records where each restore run happened. **A run in Claude's sandbox is not a clean-machine restore.** The go-live gate needs the clean-machine row below, filled in by a person.

## What is tested

`scripts/restore.sh` restores an encrypted backup (made by `scripts/backup.sh`) into a NEW database, never overwriting one. `scripts/verify-restore.sh` compares row counts of `patients`, `encounters`, `audit_log` and the last audit id. `test/safety-restore.test.js` runs both on every `npm test` (match, mismatch caught, refuses to overwrite, wrong key leaves no database behind, damaged file stopped by its checksum).

## Run 1: Claude's sandbox (automated; NOT a clean machine)

| | |
|---|---|
| Date | 2026-11-22 |
| Where | Claude's Linux sandbox: no Docker, two PostgreSQL 16 clusters on one machine (source on port 5432, **brand-new empty cluster** on port 5433), age 1.1.1 |
| Data | Migrations 001 to 005, `seed.js` users, then 5 patients, 2 encounters and extra audit rows added by SQL |
| Source counts | `patients=5 encounters=2 audit_log=24 audit_last_id=24` |
| Backup | `backup.sh` made `emr-20261122T084323012Z.dump.age` (24,003 bytes) |
| Restore | `restore.sh` into `emr_restored` on the new cluster: checksum ok; role `emr_app` did not exist there and was created NOLOGIN; migrations 5 recorded, 5 in this code |
| Verify | `verify-restore.sh compare`: patients 5/5, encounters 2/2, audit_log 24/24, audit_last_id 24/24, **MATCH** |
| App check | Server started on the restored database as `emr_app`; `admin1` signed in with the original seed password (the password hashes came back with the data); `GET /api/patients` returned the 5 patients (D1 to D5); audit_log went from 24 to 26 rows after the sign-in and the list view |
| Not covered | Docker, the compose stack, Caddy, another operating system, a real second computer, data larger than a few rows |

## Run 2: clean machine (YOU do this; Claude cannot)

A clean machine means a computer (or fresh virtual machine) that has never run this app: only Docker, a clone of the repo, and the three things you carry over.

**Carry over:** one backup file `emr-<time>.dump.age` and its `.sha256` file, your private key `backup-key.txt`, and a counts file made on the source right after that backup (`verify-restore.sh print <db>`, see below). Also your original `.env` (it holds the passwords).

**On the source, right after a backup** (so the counts match the backup):

```
docker compose exec db psql -U emr -d emr -At -F " " -c "SELECT 'patients=' || (SELECT count(*) FROM patients), 'encounters=' || (SELECT count(*) FROM encounters), 'audit_log=' || (SELECT count(*) FROM audit_log), 'audit_last_id=' || COALESCE((SELECT max(id) FROM audit_log),0)" > counts.txt
```

(In PowerShell, run it and save the single line it prints into `counts.txt`.) Make that backup and this line close together; any writes in between make the counts differ.

**On the clean machine** (PowerShell, in the repo folder; put the carried files in `.\restore-in\`):

```
copy <your .env> .env
docker compose up -d db
docker compose --profile backup build backup
docker compose --profile backup run --rm --no-deps -v "${PWD}:/work" -w /work --entrypoint bash backup scripts/restore.sh restore-in/emr-<time>.dump.age restore-in/backup-key.txt emr_restored
docker compose --profile backup run --rm --no-deps -v "${PWD}:/work" -w /work --entrypoint bash backup -c "head -n1 restore-in/counts.txt > /tmp/c.txt; scripts/verify-restore.sh compare emr_restored /tmp/c.txt"
```

Expect `restore: done` and `verify-restore: MATCH`. Then point the app at the restored database: in `.env` set `POSTGRES_DB=emr_restored` and run `docker compose up -d --build`. Open `https://localhost/`, sign in as `admin1` with the original `SEED_PASSWORD` (restored with the data), and check the Patients tab and the same patients and encounters appear. Then fill in the table.

| | |
|---|---|
| Date | |
| Who ran it | |
| Machine (OS, Docker version, was it really clean?) | |
| Backup file used | |
| Counts from the source (patients / encounters / audit_log / last id) | |
| Counts after restore | |
| `verify-restore.sh` result (MATCH or MISMATCH) | |
| App signed in and shows the same patients (yes/no) | |
| Problems and fixes | |
| Confirmed by | |

Until this table is filled in and says MATCH, the tested-restore line of the go-live gate is **not** met.
