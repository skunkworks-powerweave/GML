#!/usr/bin/env bash
# SM-5 restore drill: prove the backups are restorable.
#
# Restores the newest dump into a THROWAWAY database, checks the schema and the
# row counts look sane, drops it, and stamps the result. It never touches the
# live database.
#
# ── WHAT THE PREVIOUS VERSION GOT WRONG ──────────────────────────────────────
#
#   1. `LATEST="$(ls -t ...)"` under `set -e`: when the glob matched nothing,
#      `ls` exited 2 and the script died ON THAT LINE. The friendly "no backups
#      found" branch immediately below it was unreachable code.
#   2. It restored ONLY the database, then stamped a blanket `"result": "ok"`
#      that scripts/deploy.sh treats as a full-recovery gate. The object store
#      — the irreplaceable half — was never exercised, so the drill certified a
#      recovery capability it had not tested.
#   3. `mkdir -p workspace` was relative to CWD, so the stamp landed wherever
#      the operator happened to be standing. As a cron job, that is $HOME.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
[ -f .env ] && set -a && . ./.env && set +a

BACKUP_ROOT="${BACKUP_ROOT:-/var/lib/gml/backups}"
DB_DIR="${BACKUP_ROOT}/db"
DRILL_DB="${DRILL_DB:-gml_restore_drill}"
STAMP_FILE="${REPO_ROOT}/workspace/last_restore_drill.json"

log() { echo "[restore] $(date -Iseconds) — $*"; }
fail() { echo "[restore] ERROR: $*" >&2; exit 1; }

command -v pg_restore >/dev/null || fail "pg_restore not installed"
command -v psql >/dev/null || fail "psql not installed"

# The drill needs a LOCAL Postgres to restore into. It must not be the live
# Supabase database: restoring over production to prove a backup works is a
# spectacular way to cause the outage you were preparing for.
DRILL_HOST="${DRILL_HOST:-postgres://postgres:postgres@127.0.0.1:5432/postgres}"
case "${DRILL_HOST}" in
  *supabase.co*|*pooler.supabase.com*)
    fail "DRILL_HOST points at Supabase. The drill must restore into a LOCAL throwaway database, never production."
    ;;
esac

# Find the newest dump WITHOUT letting a no-match kill the script.
LATEST=""
if [ -d "${DB_DIR}" ]; then
  LATEST="$(find "${DB_DIR}" -name 'gml-*.dump.gz' -type f -printf '%T@ %p\n' 2>/dev/null \
            | sort -rn | head -1 | cut -d' ' -f2- || true)"
fi
if [ -z "${LATEST}" ]; then
  fail "no backups found in ${DB_DIR}. Run scripts/backup.sh first."
fi
log "restoring $(basename "${LATEST}")"

# Age check. A drill against a three-month-old dump proves the dump is
# restorable and says nothing about whether backups are still RUNNING.
age_days=$(( ( $(date +%s) - $(stat -c '%Y' "${LATEST}") ) / 86400 ))
[ "${age_days}" -le 7 ] || echo "[restore] WARNING: newest backup is ${age_days} days old — is scripts/backup.sh still running?" >&2

log "recreating drill database ${DRILL_DB}"
psql "${DRILL_HOST}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DRILL_DB};" >/dev/null
psql "${DRILL_HOST}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DRILL_DB};" >/dev/null

DRILL_URL="${DRILL_HOST%/*}/${DRILL_DB}"

# --no-owner and --no-acl: the dump's roles (supabase_admin, authenticated,
# anon) do not exist on the drill host, and refusing to restore over that would
# fail the drill for a reason that has nothing to do with the data.
#
# pg_restore exits non-zero on warnings it considers non-fatal, so the exit code
# is captured and judged rather than trusted.
log "restoring"
set +e
gunzip -c "${LATEST}" | pg_restore --no-owner --no-acl --dbname="${DRILL_URL}" 2>/tmp/restore-drill.log
restore_rc=$?
set -e
if [ "${restore_rc}" -ne 0 ]; then
  echo "[restore] pg_restore exited ${restore_rc}; inspecting whether the data actually landed" >&2
  tail -20 /tmp/restore-drill.log >&2
fi

# ── The actual assertions ────────────────────────────────────────────────────
# A restore that "succeeds" into an empty database is the failure this drill
# exists to catch.
tables="$(psql "${DRILL_URL}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
[ "${tables}" -ge 40 ] || fail "only ${tables} tables restored — expected 40+"

users="$(psql "${DRILL_URL}" -tAc "SELECT count(*) FROM public.users" 2>/dev/null || echo 0)"
audit="$(psql "${DRILL_URL}" -tAc "SELECT count(*) FROM public.audit_log" 2>/dev/null || echo 0)"
subs="$(psql "${DRILL_URL}" -tAc "SELECT count(*) FROM public.video_submissions" 2>/dev/null || echo 0)"

log "restored: ${tables} tables, ${users} users, ${audit} audit rows, ${subs} video submissions"
[ "${users}" -ge 1 ] || fail "no users restored — the dump is not usable"

log "dropping drill database"
psql "${DRILL_HOST}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DRILL_DB};" >/dev/null

# ── Stamp ────────────────────────────────────────────────────────────────────
# `storage_verified` is reported HONESTLY as false. This drill exercises the
# database only; the object mirror is a separate concern and claiming otherwise
# is how a green gate certifies a capability nobody has tested.
mkdir -p "${REPO_ROOT}/workspace"
#
# The key is `ranAt`, NOT `at`. check-restore-drill.mjs -- the SM-5 deploy gate
# -- reads `parsed.ranAt`, and this script wrote `at`. The key was read and
# never written, so the gate saw `new Date(undefined ?? 0)` = 1970 and computed
# an age of twenty thousand days: a drill that had just run successfully still
# failed the gate. `at` is kept alongside it so anything already parsing the
# old name keeps working.
cat > "${STAMP_FILE}" <<JSON
{
  "ranAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "$(basename "${LATEST}")",
  "backup_age_days": ${age_days},
  "tables": ${tables},
  "users": ${users},
  "audit_rows": ${audit},
  "video_submissions": ${subs},
  "storage_verified": false,
  "result": "ok"
}
JSON
log "drill passed; stamped ${STAMP_FILE}"
echo
echo "  NOTE: this drill covers the DATABASE only. The Storage mirror"
echo "  (scripts/backup.sh) is not exercised here. To verify it, pick a known"
echo "  object key and confirm it exists in \${BACKUP_S3_BUCKET}/storage/."
