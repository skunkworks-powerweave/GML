# shellcheck shell=bash
# The PostgreSQL client tools (pg_dump, pg_restore, psql) from Docker, for a
# host that has none. Shared by backup.sh and restore.sh. Sourced, never
# executed.
#
# ── WHY ──────────────────────────────────────────────────────────────────────
#
# The backup and the restore drill need a PostgreSQL client at least as new as
# the server. README-deploy.md section 7 has the operator install one from the
# PGDG repository, and until someone does, the drill cannot pass -- and from a
# host's second deploy on, deploy.sh refuses to deploy without a passing drill
# (SM-5). On the first staging server that is exactly what happened: the
# second deploy stopped at the gate, on a host that had Docker (every deploy
# needs it) but no PostgreSQL client.
#
# Docker is enough. The official postgres image carries the same tools, so
# when the host has none, pg_tools_from_docker defines pg_dump, pg_restore and
# psql as shell functions that run them from that image. Bash resolves a
# function before a program on PATH, so every call site below stays the same
# command it always was, and a host that does have the client keeps using it:
# nothing here runs unless a script chooses Docker.
#
# ── HOW THE CONTAINER IS WIRED ───────────────────────────────────────────────
#
#   --network host   the tools must reach both the Supabase pooler (internet)
#                    and the drill's throwaway server, which restore.sh
#                    publishes on 127.0.0.1 only. On the Linux servers this
#                    deploys to, host networking gives both.
#   stdin/stdout     dumps and SQL travel on them, never through a bind
#                    mount, so the host paths stay the host's: a dump is
#                    written by the host shell's own redirect. -i (attach
#                    stdin) only for the calls that read it: pg_restore, and
#                    psql without -c (the audit row's SQL arrives on stdin).
#                    Anything else would drain the caller's stdin.
#   -e PG...         passed through by NAME, so a variable the caller has not
#                    set (audit-host-job.sh unsets PGPASSWORD) is not set in
#                    the container either. Not PGSSLROOTCERT or ~/.pgpass: they
#                    name host files the container cannot see, so in Docker
#                    the password must be in the URL or PGPASSWORD.
#
# pg_dump's --file=PATH would name a path inside the container, where it would
# vanish with it; the wrapper turns it into a redirect on the host instead.

PG_TOOLS_SOURCE="host"
PG_TOOLS_IMAGE=""

# pg_tools_from_docker <image>
#
# From here on, pg_dump / pg_restore / psql in this shell run from <image>.
pg_tools_from_docker() {
  PG_TOOLS_IMAGE="$1"
  PG_TOOLS_SOURCE="docker"
  pg_dump() { _pg_tool_in_docker pg_dump "$@"; }
  pg_restore() { _pg_tool_in_docker pg_restore "$@"; }
  psql() { _pg_tool_in_docker psql "$@"; }
}

_pg_tool_in_docker() {
  local tool="$1" out="" a stdin=""
  shift
  local args=()
  for a in "$@"; do
    if [ "${tool}" = "pg_dump" ]; then
      case "${a}" in
        --file=*) out="${a#--file=}"; continue ;;
      esac
    fi
    args+=("${a}")
  done
  case "${tool}" in
    pg_restore) stdin="-i" ;;
    psql)
      stdin="-i"
      for a in "${args[@]}"; do
        # -c, --command, or a cluster of short options ending in c (-XtAc).
        case "${a}" in
          -c | --command | --command=* | -[!-]*c) stdin=""; break ;;
        esac
      done
      ;;
  esac
  local run=(docker run --rm ${stdin:+"${stdin}"} --network host
    -e PGPASSWORD -e PGSSLMODE -e PGCONNECT_TIMEOUT
    "${PG_TOOLS_IMAGE}" "${tool}")
  # `|| return` hands the failure back to the caller's line, so its ERR trap
  # (and the stamp or audit row it writes) names the caller's command rather
  # than a line of this file.
  if [ -n "${out}" ]; then
    "${run[@]}" "${args[@]}" > "${out}" || return
  else
    "${run[@]}" "${args[@]}" || return
  fi
}

# pg_tools_host_has <tool>...
#
# True when every named tool is a PROGRAM on PATH (a function defined above
# does not count, so the answer does not change once Docker is chosen).
pg_tools_host_has() {
  local t
  for t in "$@"; do
    [ -n "$(type -P "${t}" 2>/dev/null)" ] || return 1
  done
}

# The image a host with no client starts from. Only the starting point:
# backup.sh asks the server for its major and moves to that image, and records
# it beside the dump (<dump>.pg-tools-image) so restore.sh uses the same.
PG_TOOLS_DEFAULT_IMAGE="${PG_TOOLS_DEFAULT_IMAGE:-postgres:17-alpine}"
