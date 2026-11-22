#!/usr/bin/env bash
# Restore an encrypted EMR Enhancer backup into a NEW, empty database (chunk 7c). Synthetic data only until the go-live gate.
#
#   restore.sh <backup.dump.age> <private-key-file> <new-database-name>
#
# Connection: the usual libpq variables for a database server where you may create databases (PGHOST, PGPORT, PGUSER,
# PGPASSWORD). Run it as the database OWNER, the same user the migrations run as, not as emr_app.
#
# What it does, in order:
#   1. checks the .sha256 file next to the backup (if there is one)
#   2. refuses to continue if the target database already exists (it never overwrites anything)
#   3. creates the database and, if missing, the NOLOGIN role emr_app (the dump grants rights to it; roles are not in a dump)
#   4. decrypts and restores in one pipe, in one transaction, stopping on the first error (no plain dump file is written)
#   5. migrations check: every migration in ./migrations must be recorded in the restored database, and the database
#      must not record any migration this code does not have. A missing one is reported (the app applies it at start).
#
# The private key stays on the machine where you run this. If the restore fails, the new database is dropped again.
set -Eeuo pipefail
umask 077

[[ $# -eq 3 ]] || { echo "usage: restore.sh <backup.dump.age> <private-key-file> <new-database-name>" >&2; exit 2; }
BACKUP="$1"; KEY="$2"; DB="$3"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="${MIGRATIONS_DIR:-$HERE/../migrations}"

log() { echo "restore: $*"; }
die() { echo "restore: $*" >&2; exit 1; }

[[ "$DB" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "database name must be lower-case letters, digits and underscores, starting with a letter"
[[ -f "$BACKUP" ]] || die "backup file not found: $BACKUP"
[[ -f "$KEY" ]] || die "private key file not found: $KEY"
for c in age pg_restore psql createdb dropdb; do command -v "$c" >/dev/null || die "$c must be installed"; done

if [[ -f "$BACKUP.sha256" ]]; then
  (cd "$(dirname "$BACKUP")" && sha256sum -c "$(basename "$BACKUP").sha256" >/dev/null) || die "checksum does not match: the backup file is damaged or was changed"
  log "checksum ok"
else
  log "no .sha256 file next to the backup; checksum not checked"
fi

EXISTS="$(psql -X -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$DB'")"
[[ -z "$EXISTS" ]] || die "database \"$DB\" already exists. Choose a new name; this script never overwrites a database."

createdb "$DB"
CREATED=1
cleanup() {
  local rc=$?
  if [[ "${CREATED:-0}" == 1 && $rc -ne 0 ]]; then
    dropdb --if-exists "$DB" >/dev/null 2>&1 || true
    echo "restore: FAILED, the new database \"$DB\" was dropped again" >&2
  fi
}
trap cleanup EXIT

psql -X -q -d postgres -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emr_app') THEN CREATE ROLE emr_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END \$\$"

log "decrypting and restoring into \"$DB\" ..."
age --decrypt --identity "$KEY" "$BACKUP" | pg_restore --dbname "$DB" --no-owner --single-transaction --exit-on-error
log "data restored"

# Migrations check
mapfile -t HAVE < <(psql -X -At -d "$DB" -c "SELECT name FROM schema_migrations ORDER BY name")
mapfile -t WANT < <(cd "$MIGRATIONS" && ls -1 | grep -E '^[0-9]+_.+\.sql$' | sort)
PENDING=(); UNKNOWN=()
for m in "${WANT[@]}"; do printf '%s\n' "${HAVE[@]}" | grep -qxF "$m" || PENDING+=("$m"); done
for m in "${HAVE[@]}"; do printf '%s\n' "${WANT[@]}" | grep -qxF "$m" || UNKNOWN+=("$m"); done
if (( ${#UNKNOWN[@]} )); then
  die "the backup records migrations this code does not have (${UNKNOWN[*]}). Restore with the code version that made the backup."
fi
log "migrations: ${#HAVE[@]} recorded, ${#WANT[@]} in this code"
(( ${#PENDING[@]} )) && log "NOTE: not yet applied (the app or 'node migrate.js' applies them): ${PENDING[*]}"

CREATED=0
log "done. Next: scripts/verify-restore.sh compare \"$DB\" <source-database-or-counts-file>"
