#!/usr/bin/env bash
# SM-5 restore drill: prove the backups are restorable.
#
# Restores the newest dump into a THROWAWAY database, checks the schema and the
# row counts look sane, drops it, and stamps the result. Of the live database
# it changes nothing but one appended audit_log row, restore.complete or
# restore.failed, which is what /admin/system-settings shows as the last drill
# (scripts/lib/audit-host-job.sh; skipped with a warning without DATABASE_URL).
#
#   bash scripts/restore.sh            # weekly, from cron -- README-deploy.md 7
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
#   4. IT RESTORED INTO A SERVER NOTHING INSTALLS. The default target was
#      postgres://...@127.0.0.1:5432, but docker-compose.yml deliberately has no
#      postgres service (Supabase IS the database) and the runbook installs the
#      Postgres CLIENT only. So on the real box the Sunday cron died at the
#      first psql with "connection refused", wrote no stamp, and a broken drill
#      looked exactly like one that had never run.
#
# ── WHERE THE DRILL DATABASE COMES FROM NOW ──────────────────────────────────
#
# Unless DRILL_HOST is given, this script starts its own throwaway Postgres in
# a container, published on 127.0.0.1 only, and removes it on EVERY exit path
# (the EXIT trap below) -- so the cron line stays one command and nothing is
# left running between Sundays. It is deliberately NOT a compose service:
# docker-compose.yml's service set is exactly the four long-running containers
# (tests/governance/test_002 holds it there), and a second live Postgres beside
# the Supabase one is the confusion that file's header records removing.
#
# The container's Postgres MAJOR is read from the dump itself ("Dumped from
# database version" in its header), not assumed: the dump is restored into the
# same major it came from, whatever Supabase runs this year.
#
#   DRILL_IMAGE   override the image          (default postgres:<dump major>-alpine)
#   DRILL_PORT    loopback port to publish    (default 55432)
#   DRILL_HOST    use an existing throwaway server instead of a container, e.g.
#                 postgres://postgres:secret@127.0.0.1:5432/postgres
#                 The database NAME is replaced by DRILL_DB; a ?query survives.
#                 Never the live database -- a Supabase host is refused.
#
# ── A FAILED DRILL IS STAMPED, NOT SILENT ────────────────────────────────────
#
# A failure writes {"result": "failed", "error": "..."} to the stamp, so the
# SM-5 gate (scripts/check-restore-drill.mjs) refuses the next production
# deploy with the actual reason instead of "missing".

set -Eeuo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
[ -f .env ] && set -a && . ./.env && set +a

BACKUP_ROOT="${BACKUP_ROOT:-/var/lib/gml/backups}"
DB_DIR="${BACKUP_ROOT}/db"
DRILL_DB="${DRILL_DB:-gml_restore_drill}"
DRILL_PORT="${DRILL_PORT:-55432}"
DRILL_READY_TIMEOUT_SECONDS="${DRILL_READY_TIMEOUT_SECONDS:-90}"
DRILL_CONTAINER_NAME="${DRILL_CONTAINER_NAME:-gml-restore-drill}"
STAMP_FILE="${REPO_ROOT}/workspace/last_restore_drill.json"

log() { echo "[restore] $(date -Iseconds) — $*"; }

DRILL_ERROR=""
DRILL_CONTAINER=""
DRILL_SOURCE="none"
STAMP_WRITTEN=""

fail() { DRILL_ERROR="$*"; echo "[restore] ERROR: $*" >&2; exit 1; }

# Only characters that need no escaping inside a JSON string survive; anything
# else becomes '?'. The error text is for a human reading the stamp.
json_text() { printf '%s' "$1" | tr -c "A-Za-z0-9 .,:;_/()=+@%'<>#-" '?'; }

write_failure_stamp() {
  mkdir -p "${REPO_ROOT}/workspace"
  cat > "${STAMP_FILE}" <<JSON
{
  "ranAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "$(json_text "${DRILL_SOURCE}")",
  "storage_verified": false,
  "result": "failed",
  "error": "$(json_text "$1")"
}
JSON
  echo "[restore] drill FAILED; stamped ${STAMP_FILE}. The SM-5 gate will refuse production deploys until a drill passes." >&2
}

# Records the first unexpected failure, so the stamp can name it.
trap 'DRILL_ERROR="${DRILL_ERROR:-line ${LINENO}: ${BASH_COMMAND}}"' ERR

# shellcheck source=lib/audit-host-job.sh
. scripts/lib/audit-host-job.sh

on_exit() {
  local rc=$?
  if [ -n "${DRILL_CONTAINER}" ]; then
    docker rm -f "${DRILL_CONTAINER}" >/dev/null 2>&1 \
      || echo "[restore] WARNING: could not remove drill container ${DRILL_CONTAINER}; remove it with: docker rm -f ${DRILL_CONTAINER}" >&2
  fi
  if [ "${rc}" -ne 0 ] && [ -z "${STAMP_WRITTEN}" ]; then
    write_failure_stamp "${DRILL_ERROR:-exited ${rc}}"
    audit_host_job restore.failed \
      "{\"source\":\"$(json_text "${DRILL_SOURCE}")\",\"error\":\"$(json_text "${DRILL_ERROR:-exited ${rc}}")\"}"
  fi
}
trap on_exit EXIT

command -v pg_restore >/dev/null || fail "pg_restore not installed -- install the PostgreSQL client (README-deploy.md section 7)"
command -v psql >/dev/null || fail "psql not installed -- install the PostgreSQL client (README-deploy.md section 7)"
# shellcheck source=lib/pg-major.sh
. scripts/lib/pg-major.sh

# An explicit DRILL_HOST must never be the live database: restoring over
# production to prove a backup works is a spectacular way to cause the outage
# you were preparing for.
DRILL_HOST="${DRILL_HOST:-}"
case "${DRILL_HOST}" in
  *supabase.co*|*pooler.supabase.com*)
    fail "DRILL_HOST points at Supabase. The drill must restore into a LOCAL throwaway database, never production."
    ;;
esac
if [ -n "${DRILL_HOST}" ] && [ "${DRILL_HOST}" = "${DATABASE_URL:-}" ]; then
  fail "DRILL_HOST is DATABASE_URL. The drill must restore into a throwaway database, never production."
fi

# Find the newest dump WITHOUT letting a no-match kill the script.
LATEST=""
if [ -d "${DB_DIR}" ]; then
  LATEST="$(find "${DB_DIR}" -name 'gml-*.dump.gz' -type f -printf '%T@ %p\n' 2>/dev/null \
            | sort -rn | head -1 | cut -d' ' -f2- || true)"
fi
if [ -z "${LATEST}" ]; then
  fail "no backups found in ${DB_DIR}. Run scripts/backup.sh first."
fi
DRILL_SOURCE="$(basename "${LATEST}")"
log "restoring ${DRILL_SOURCE}"

# Age check. A drill against a three-month-old dump proves the dump is
# restorable and says nothing about whether backups are still RUNNING.
age_days=$(( ( $(date +%s) - $(stat -c '%Y' "${LATEST}") ) / 86400 ))
[ "${age_days}" -le 7 ] || echo "[restore] WARNING: newest backup is ${age_days} days old — is scripts/backup.sh still running?" >&2

# ── The drill database ───────────────────────────────────────────────────────
if [ -z "${DRILL_HOST}" ]; then
  command -v docker >/dev/null \
    || fail "docker is required to start the drill's throwaway database (or set DRILL_HOST to an existing one)"

  if [ -z "${DRILL_IMAGE:-}" ]; then
    src_version="$( { gunzip -c "${LATEST}" | pg_restore -l 2>/dev/null; } \
                    | sed -n 's/^;[[:space:]]*Dumped from database version:[[:space:]]*//p' \
                    | head -n 1 || true)"
    src_major="$(pg_major "${src_version}" || true)"
    [ -n "${src_major}" ] \
      || fail "could not read the source server version from the header of ${DRILL_SOURCE} (pg_restore -l). Is pg_restore at least as new as the pg_dump that wrote it? To choose the drill server by hand, set DRILL_IMAGE=postgres:<major>-alpine."
    DRILL_IMAGE="postgres:${src_major}-alpine"
    log "dump came from PostgreSQL ${src_version}; drill server is ${DRILL_IMAGE}"
  fi

  # A container left by a drill that was SIGKILLed (the EXIT trap cannot run
  # then) would otherwise hold the name and the port.
  docker rm -f "${DRILL_CONTAINER_NAME}" >/dev/null 2>&1 || true

  drill_pw="$(od -An -N12 -tx1 /dev/urandom | tr -d ' [:space:]')"
  DRILL_CONTAINER="${DRILL_CONTAINER_NAME}"
  log "starting throwaway ${DRILL_IMAGE} on 127.0.0.1:${DRILL_PORT}"
  docker run -d --rm --name "${DRILL_CONTAINER}" \
    -e POSTGRES_PASSWORD="${drill_pw}" \
    -p "127.0.0.1:${DRILL_PORT}:5432" \
    "${DRILL_IMAGE}" >/dev/null

  export PGPASSWORD="${drill_pw}"
  DRILL_HOST="postgres://postgres@127.0.0.1:${DRILL_PORT}/postgres"

  waited=0
  until psql "${DRILL_HOST}" -XtAc 'select 1' >/dev/null 2>&1; do
    [ "${waited}" -lt "${DRILL_READY_TIMEOUT_SECONDS}" ] \
      || fail "the drill database did not accept connections within ${DRILL_READY_TIMEOUT_SECONDS}s (docker logs ${DRILL_CONTAINER})"
    sleep 1
    waited=$((waited + 1))
  done
fi

log "recreating drill database ${DRILL_DB}"
psql "${DRILL_HOST}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DRILL_DB};" >/dev/null
psql "${DRILL_HOST}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DRILL_DB};" >/dev/null

# Swap the database name in, keeping any ?query. The old `${DRILL_HOST%/*}`
# form discarded everything after the database name, so an operator's
# `?sslmode=disable` vanished without a word.
drill_base="${DRILL_HOST%%[?]*}"
drill_query="${DRILL_HOST#"${drill_base}"}"
DRILL_URL="${drill_base%/*}/${DRILL_DB}${drill_query}"

# --no-owner and --no-acl: the dump's roles (supabase_admin, authenticated,
# anon) do not exist on the drill host, and refusing to restore over that would
# fail the drill for a reason that has nothing to do with the data.
#
# pg_restore exits non-zero on warnings it considers non-fatal, so the exit code
# is captured and judged rather than trusted.
log "restoring"
restore_rc=0
gunzip -c "${LATEST}" | pg_restore --no-owner --no-acl --dbname="${DRILL_URL}" 2>/tmp/restore-drill.log \
  || restore_rc=$?
if [ "${restore_rc}" -ne 0 ]; then
  echo "[restore] pg_restore exited ${restore_rc}; inspecting whether the data actually landed" >&2
  tail -20 /tmp/restore-drill.log >&2 || true
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
  "source": "${DRILL_SOURCE}",
  "backup_age_days": ${age_days},
  "tables": ${tables},
  "users": ${users},
  "audit_rows": ${audit},
  "video_submissions": ${subs},
  "storage_verified": false,
  "result": "ok"
}
JSON
STAMP_WRITTEN=1
audit_host_job restore.complete \
  "{\"source\":\"$(json_text "${DRILL_SOURCE}")\",\"backup_age_days\":${age_days},\"tables\":${tables},\"users\":${users},\"storage_verified\":false}"
log "drill passed; stamped ${STAMP_FILE}"
echo
echo "  NOTE: this drill covers the DATABASE only. The Storage mirror"
echo "  (scripts/backup.sh) is not exercised here. To verify it, pick a known"
echo "  object key and confirm it exists in \${BACKUP_S3_BUCKET}/storage/."
