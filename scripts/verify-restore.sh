#!/usr/bin/env bash
# Compare a restored database with its source (chunk 7c): row counts of patients, encounters, audit_log and the last audit id.
#
#   verify-restore.sh print <database>                       print one line of counts (save it next to the backup)
#   verify-restore.sh compare <restored-db> <source>         <source> is a source database name OR a file holding a "print" line
#
# On a clean machine the source database is not reachable, so run "print" on the source right after the backup, keep the
# line (a small text file), and give that file to "compare" on the clean machine. Counts are exact: if the source took new
# writes after the backup, the numbers differ and the script says so; that is not a failed restore.
# Connection: the usual libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD).
set -Eeuo pipefail

die() { echo "verify-restore: $*" >&2; exit 1; }
command -v psql >/dev/null || die "psql must be installed"

counts() {
  psql -X -At -F ' ' -d "$1" -c "SELECT 'patients=' || (SELECT count(*) FROM patients), 'encounters=' || (SELECT count(*) FROM encounters), 'audit_log=' || (SELECT count(*) FROM audit_log), 'audit_last_id=' || COALESCE((SELECT max(id) FROM audit_log), 0)" \
    || die "could not read counts from database \"$1\""
}

case "${1:-}" in
  print)
    [[ $# -eq 2 ]] || die "usage: verify-restore.sh print <database>"
    counts "$2" ;;
  compare)
    [[ $# -eq 3 ]] || die "usage: verify-restore.sh compare <restored-db> <source-db-or-file>"
    got="$(counts "$2")"
    if [[ -f "$3" ]]; then want="$(head -n 1 "$3" | tr -s ' \r' ' ' | sed 's/ *$//')"; else want="$(counts "$3")"; fi
    [[ "$want" =~ ^patients=[0-9]+\ encounters=[0-9]+\ audit_log=[0-9]+\ audit_last_id=[0-9]+$ ]] || die "the source is not a counts line: $want"
    printf '%-14s %-12s %-12s %s\n' item restored source match
    ok=1
    for key in patients encounters audit_log audit_last_id; do
      g="$(tr ' ' '\n' <<<"$got" | sed -n "s/^$key=//p")"; w="$(tr ' ' '\n' <<<"$want" | sed -n "s/^$key=//p")"
      if [[ "$g" == "$w" ]]; then m=yes; else m=NO; ok=0; fi
      printf '%-14s %-12s %-12s %s\n' "$key" "$g" "$w" "$m"
    done
    if (( ok )); then echo "verify-restore: MATCH"; else echo "verify-restore: MISMATCH (if the source changed after the backup, take a fresh backup and counts line, then compare again)" >&2; exit 1; fi ;;
  *) die "usage: verify-restore.sh print <database> | compare <restored-db> <source-db-or-file>" ;;
esac
