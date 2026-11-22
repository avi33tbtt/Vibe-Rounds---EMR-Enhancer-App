# Chunk 07c: Restore script and recorded restore test

_Part 3 of original chunk 07._

**Core rules:** attach `01-core.md` too.

**Read only:** `scripts/backup.sh` from 7b, `README.md`.

**Build:**
1. `scripts/restore.sh`: decrypt, create an empty database, restore, run migrations check.
2. `scripts/verify-restore.sh`: compare row counts of `patients`, `encounters`, `audit_log` and the last audit id between source and restored database.
3. Claude runs this on a clean container and records the result in `docs/RESTORE-TEST.md` (date, steps, counts). The real clean-machine restore is done by the user; leave a table for it.

**Done when:** a clean machine restores from backup and the app shows the same cases and audit log (user confirms the clean-machine row).

**Size guard:** Two scripts and one doc.

**Notes:** Claude's sandbox is not your clean machine. The doc must say which run was where.
