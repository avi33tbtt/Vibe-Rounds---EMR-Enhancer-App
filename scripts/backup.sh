#!/usr/bin/env bash
# Encrypted PostgreSQL backup for EMR Enhancer (chunk 7b). Synthetic data only until the go-live gate.
#
#   backup.sh          one backup, then exit
#   backup.sh --loop   one backup now, then one every BACKUP_INTERVAL_HOURS (what the compose "backup" service runs)
#
# The dump is piped straight into `age`, so an unencrypted copy never touches the disk. It is encrypted to a PUBLIC key
# (BACKUP_AGE_RECIPIENT, "age1..."). The matching private key must NOT be on this server: whoever owns the server can
# write backups but cannot read them. The dump covers the whole database, so audit_log is included.
#
# Settings (environment):
#   BACKUP_AGE_RECIPIENT     required, age public key
#   BACKUP_DIR               default /backups
#   BACKUP_KEEP              how many backups to keep, default 14
#   BACKUP_INTERVAL_HOURS    loop mode only, default 24
#   BACKUP_DATABASE_URL      optional connection URL; otherwise the usual libpq variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE)
set -Eeuo pipefail
umask 077

DIR="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_KEEP:-14}"
HOURS="${BACKUP_INTERVAL_HOURS:-24}"
RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"

log() { echo "$(date -u +%FT%TZ) backup: $*"; }

check_config() {
  [[ "$RECIPIENT" == age1* ]] || { echo "backup: set BACKUP_AGE_RECIPIENT to an age public key (it starts with age1). Never put the private key on this server." >&2; return 1; }
  [[ "$KEEP" =~ ^[0-9]+$ && "$KEEP" -ge 1 ]] || { echo "backup: BACKUP_KEEP must be a whole number, 1 or more." >&2; return 1; }
  [[ "$HOURS" =~ ^[0-9]+$ && "$HOURS" -ge 1 ]] || { echo "backup: BACKUP_INTERVAL_HOURS must be a whole number, 1 or more." >&2; return 1; }
  command -v age >/dev/null && command -v pg_dump >/dev/null || { echo "backup: age and pg_dump must be installed." >&2; return 1; }
}

# Explicit "|| return 1" everywhere: when this runs under "if", bash switches "set -e" off inside it.
backup_once() {
  mkdir -p "$DIR" || return 1
  local name base tmp
  name="emr-$(date -u +%Y%m%dT%H%M%S%3NZ).dump.age"
  base="$DIR/$name"
  tmp="$base.partial"

  local dump=(pg_dump --format=custom)
  [[ -n "${BACKUP_DATABASE_URL:-}" ]] && dump+=(--dbname "$BACKUP_DATABASE_URL")
  if ! "${dump[@]}" | age --recipient "$RECIPIENT" --output "$tmp"; then
    rm -f "$tmp"; log "FAILED: pg_dump or age returned an error; nothing was kept"; return 1
  fi
  [[ -s "$tmp" ]] || { rm -f "$tmp"; log "FAILED: the backup file is empty"; return 1; }
  mv "$tmp" "$base" || return 1
  (cd "$DIR" && sha256sum "$name" > "$name.sha256") || return 1
  log "wrote $name ($(wc -c < "$base") bytes)"

  # Keep the newest KEEP backups. File names sort by time. Only encrypted backups are ever listed here.
  shopt -s nullglob
  local files=("$DIR"/emr-*.dump.age) i
  for ((i = 0; i < ${#files[@]} - KEEP; i++)); do
    rm -f -- "${files[$i]}" "${files[$i]}.sha256"
    log "removed old backup $(basename "${files[$i]}")"
  done
}

check_config || exit 1

if [[ "${1:-}" == "--loop" ]]; then
  while true; do
    if backup_once; then sleep "${HOURS}h"; else log "will retry in 1 hour"; sleep 1h; fi
  done
else
  backup_once
fi
