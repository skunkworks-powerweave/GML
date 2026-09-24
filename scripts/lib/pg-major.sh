# shellcheck shell=bash
# Postgres major-version helpers, shared by backup.sh, restore.sh and
# preflight.sh. Sourced, never executed.
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
#
# pg_dump refuses to dump a server whose major is newer than its own:
#
#     pg_dump: error: aborting because of server version mismatch
#
# The runbook used to install postgresql-client-16. Against a Supabase project
# on 17 that meant no dump was ever written: the 02:00 cron logged a bare
# pg_dump exit into a file nobody reads, restore.sh found nothing, and a month
# later the SM-5 gate began refusing deploys for a reason that looked nothing
# like "the backups have never worked".
#
# The server's major is NOT hardcoded anywhere in this repository and must not
# be: which major a Supabase project runs is decided by Supabase when the
# project is created, and the production value is not recorded here. These
# helpers ASK the server (`SHOW server_version_num`) and compare, so the check
# stays correct when the project is upgraded or recreated on a newer major.

# pg_major <version-string>
#
# Prints the major version found in any of the spellings met in practice:
#   "pg_dump (PostgreSQL) 17.6 (Ubuntu 17.6-1.pgdg24.04+1)"  -> 17
#   "17.6", "15.8 (Debian ...)", "18beta1"                  -> 17, 15, 18
#   "170006", "90624"   (server_version_num)                 -> 17, 9
# Returns 1, printing nothing, when there is no version in the input.
pg_major() {
  local s="${1:-}" n
  case "${s}" in
    *[!0-9]* | "") : ;;
    *)
      # All digits and at least five of them: server_version_num.
      if [ "${#s}" -ge 5 ]; then
        printf '%s\n' "$((s / 10000))"
        return 0
      fi
      ;;
  esac
  n="$(printf '%s' "${s}" | sed -nE 's/^[^0-9]*([0-9]+).*$/\1/p' | head -n 1)"
  [ -n "${n}" ] || return 1
  printf '%s\n' "${n}"
}

# pg_client_can_dump <client-major> <server-major>
#
# pg_dump reads servers of its own major and older, never newer.
pg_client_can_dump() {
  [ "${1:-0}" -ge "${2:-0}" ]
}

# pg_check_dump_client <database-url>
#
# Compares the pg_dump on PATH with the server behind <database-url>. Sets:
#   PG_CLIENT_MAJOR  PG_SERVER_MAJOR  PG_CHECK_ERROR
# Returns 0 when pg_dump can dump that server, 1 on a version mismatch, and 2
# when either version could not be determined (PG_CHECK_ERROR says which).
pg_check_dump_client() {
  local url="${1:-}" client_v server_num
  PG_CLIENT_MAJOR=""
  PG_SERVER_MAJOR=""
  PG_CHECK_ERROR=""

  if ! command -v pg_dump >/dev/null 2>&1; then
    PG_CHECK_ERROR="pg_dump is not installed"
    return 2
  fi
  client_v="$(pg_dump --version 2>/dev/null || true)"
  if ! PG_CLIENT_MAJOR="$(pg_major "${client_v}")"; then
    PG_CHECK_ERROR="could not read the pg_dump version from: ${client_v:-<no output>}"
    return 2
  fi

  if ! command -v psql >/dev/null 2>&1; then
    PG_CHECK_ERROR="psql is not installed, so the server version cannot be read"
    return 2
  fi
  if ! server_num="$(psql "${url}" -XtAc 'SHOW server_version_num' 2>/dev/null)"; then
    PG_CHECK_ERROR="could not read the server version (psql could not query the database behind DATABASE_URL)"
    return 2
  fi
  server_num="$(printf '%s' "${server_num}" | tr -d '[:space:]')"
  if ! PG_SERVER_MAJOR="$(pg_major "${server_num}")"; then
    PG_CHECK_ERROR="could not read the server version from: ${server_num:-<no output>}"
    return 2
  fi

  if pg_client_can_dump "${PG_CLIENT_MAJOR}" "${PG_SERVER_MAJOR}"; then
    return 0
  fi
  PG_CHECK_ERROR="pg_dump ${PG_CLIENT_MAJOR} cannot dump a PostgreSQL ${PG_SERVER_MAJOR} server (it aborts with 'server version mismatch'). Install postgresql-client-${PG_SERVER_MAJOR} from the PGDG apt repository -- see README-deploy.md section 7"
  return 1
}
