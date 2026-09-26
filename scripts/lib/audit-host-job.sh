# shellcheck shell=bash
# One audit_log row per run of a host job (backup.sh, restore.sh).
#
# /admin/system-settings shows the latest backup.complete and restore.complete
# rows (apps/web/src/admin/audit-lookups.ts), and neither script wrote any: each
# recorded its run only in a file on the host, so the panel could never show a
# real time, nor that backups had stopped. Sourced by both scripts.
#
#   audit_host_job <action> <metadata JSON>
#
# BEST EFFORT, BY DESIGN. The dump, or the drill, is the job; the row is a
# report of it. A write that fails -- the database is the thing that is down,
# say -- prints a WARNING and returns 0, and never changes the job's outcome.
#
# The values reach SQL only as psql variables (`:'action'`, `:'meta'`), which
# psql quotes itself; the SQL arrives on stdin because psql does not
# interpolate variables in -c. The metadata is built by the caller from values
# the script controls; free text goes through audit_json_text first.
#
# Always DATABASE_URL -- the live database, the one the app reads. PGPASSWORD
# is dropped for the write: restore.sh sets it for its throwaway server.
# `audit_log` is unqualified, resolved through the search_path like every
# query the application makes (tests/behaviour/host-job-audit.test.ts points
# it at a scratch copy that way).

audit_host_job() {
  local action="$1" meta="$2" err
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "WARNING: DATABASE_URL is not set -- ${action} not recorded in the audit log (/admin/system-settings will not show this run)" >&2
    return 0
  fi
  if ! err="$( (unset PGPASSWORD; psql "${DATABASE_URL}" -XqAt -v ON_ERROR_STOP=1 -v action="${action}" -v meta="${meta}" 2>&1 >/dev/null <<'SQL'
INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
VALUES (NULL, :'action', 'host_job', NULL, :'meta'::jsonb);
SQL
  ) )"; then
    echo "WARNING: could not record ${action} in the audit log (/admin/system-settings will not show this run): $(printf '%s' "${err}" | head -n 1)" >&2
  fi
  return 0
}

# Text safe inside a JSON string: anything but these characters becomes '?'.
audit_json_text() { printf '%s' "$1" | tr -c "A-Za-z0-9 .,:;_/()=+@%'<>#-" '?'; }
