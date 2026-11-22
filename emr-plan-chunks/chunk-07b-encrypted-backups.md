# Chunk 07b: Encrypted scheduled backups

_Part 2 of original chunk 07._

**Core rules:** attach `01-core.md` too.

**Read only:** `docker-compose.yml`, `db.js`, `env.txt`, README section from 7a.

**Build:**
1. `scripts/backup.sh`: `pg_dump` (custom format), encrypt with `age` or `gpg` using a public key from env (private key is never on the server), timestamped file, checksum file, keep the last N.
2. Schedule it: a compose service or a cron line documented in README. Backup includes `audit_log`.
3. A test or a documented check showing the file is unreadable without the key.

**Done when:** a scheduled run produces an encrypted dump that cannot be read without the private key.

**Size guard:** One script, one compose/cron entry, README lines.
