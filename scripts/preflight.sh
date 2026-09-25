#!/usr/bin/env bash
# Pre-deploy validation. Run on the EC2 box BEFORE the first deploy.
#
# Catches the configuration mistakes that otherwise surface as a half-deployed
# stack: a wrong pooler port that connects fine and then fails on the first
# prepared statement, a DNS record that has not propagated so no certificate can
# be issued, a .env readable by every account on the box.
#
# Read-only and safe to run repeatedly. NEVER PRINTS A SECRET VALUE -- only
# whether a variable is set, and how long it is.
#
# Three scripts, three moments:
#
#   scripts/preflight.sh          host and config, BEFORE deploying   (this one)
#   packages/db/scripts/verify-auth.mjs
#                                 Supabase and the access-token hook, AFTER
#                                 migrations. deploy.sh runs it for you.
#   scripts/verify-tls-local.sh   the proxy path, without a public domain.
#
#   bash scripts/preflight.sh
#
# Exit 0 = safe to deploy. Exit 1 = at least one blocking failure.

set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/pg-major.sh
. scripts/lib/pg-major.sh

pass=0
warn=0
fail=0
ok()   { printf '  PASS  %s\n' "$1"; pass=$((pass + 1)); }
nb()   { printf '  WARN  %s\n' "$1"; warn=$((warn + 1)); }
no()   { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1))
         if [ $# -gt 1 ]; then printf '        fix: %s\n' "$2"; fi; }
sect() { printf '\n%s\n\n' "$1"; }

# ---- .env -------------------------------------------------------------------
sect "Environment file"

if [ ! -f .env ]; then
  no ".env exists" "cp .env.example .env && chmod 600 .env, then fill it in"
  printf '\n  Cannot continue without .env.\n'
  exit 1
fi
ok ".env exists"

# Mode 0600: this file holds the service-role key, which bypasses RLS entirely
# and can create, ban and delete accounts.
#
# POSIX MODE IS MEANINGLESS UNDER GIT BASH / MSYS, so do not report a verdict
# there. It synthesises a mode from NTFS that does not reflect the actual ACL:
# a file correctly locked down with
#
#     icacls .env /inheritance:r /grant:r "%USERNAME%:F" ...
#
# still reports 644, so this check produced a confident FAIL for a file that
# was already private, and would equally report 600 for one that was not.
# A check that cannot distinguish the two states must say so rather than guess.
# On the EC2 box -- which is where this script is meant to run -- stat is
# authoritative and the verdict below is real.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    nb ".env permissions NOT checked (POSIX mode is not meaningful on Windows)"
    nb "  Windows:  icacls .env /inheritance:r /grant:r \"%USERNAME%:F\" /grant:r \"SYSTEM:F\" /grant:r \"Administrators:F\""
    nb "  Verify:   (Get-Acl .env).Access   -- BUILTIN\\Users must not appear"
    ;;
  *)
    mode="$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null || echo unknown)"
    if [ "$mode" = "600" ]; then
      ok ".env is mode 600"
    else
      no ".env is mode 600 (found $mode)" "chmod 600 .env"
    fi
    ;;
esac

set -a
# shellcheck disable=SC1091
. ./.env 2>/dev/null
set +a

# ---- required variables -----------------------------------------------------
sect "Required variables"

# Length only, never the value.
req() {
  local name="$1"
  local v="${!1:-}"
  if [ -n "$v" ]; then
    ok "$name is set (${#v} chars)"
  else
    no "$name is set" "add $name to .env -- see .env.example"
  fi
}
for v in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
         SUPABASE_SECRET_KEY DATABASE_URL DOMAIN ACME_EMAIL; do
  req "$v"
done
# Optional: WhatsApp ingest. The webhook fails closed without its secret, so
# an unconfigured integration is reported, not blocked.
if [ -n "${WHATSAPP_APP_SECRET:-}" ]; then
  ok "WHATSAPP_APP_SECRET is set (${#WHATSAPP_APP_SECRET} chars) -- WhatsApp ingest can be switched on"
  # The secret switches the webhook on; these are what make ingest WORK, and
  # each missing one breaks something different. Warned, not failed: the LMS
  # itself runs fine, and /admin/whatsapp-log says the same thing.
  [ -n "${WHATSAPP_VERIFY_TOKEN:-}" ] ||
    nb "WHATSAPP_VERIFY_TOKEN is not set -- Meta's webhook verification (GET) will be refused"
  [ -n "${WHATSAPP_ACCESS_TOKEN:-}" ] ||
    nb "WHATSAPP_ACCESS_TOKEN is not set -- videos will be recorded but cannot be fetched from Meta (use a permanent system-user token)"
  [ -n "${WHATSAPP_PHONE_NUMBER_ID:-}" ] ||
    nb "WHATSAPP_PHONE_NUMBER_ID is not set -- senders will get no reply saying what happened to their video"
else
  nb "WHATSAPP_APP_SECRET is not set -- WhatsApp ingest is OFF (the webhook refuses all traffic); direct upload is unaffected"
fi

# ---- the pooler port --------------------------------------------------------
sect "Database connection"

# THE FOOTGUN THIS SCRIPT EXISTS FOR.
#
# Supabase offers two poolers. Transaction mode (6543) disables prepared
# statements, and Drizzle relies on them. The failure is not at startup -- the
# connection succeeds -- it is the first query that uses one. So the stack comes
# up looking healthy and breaks later, under real use, a long way from the cause.
case "${DATABASE_URL:-}" in
  *:6543/*)
    no "DATABASE_URL uses the SESSION pooler (5432), not transaction (6543)" \
       "Supabase -> Project Settings -> Database -> Connection string -> Session"
    ;;
  *:5432/*) ok "DATABASE_URL uses the session pooler (5432)" ;;
  "") : ;;
  *) nb "DATABASE_URL port is neither 5432 nor 6543 -- confirm it is the session pooler" ;;
esac

case "${DATABASE_URL:-}" in
  *pooler.supabase.com*) ok "DATABASE_URL points at a Supabase pooler host" ;;
  "") : ;;
  *) nb "DATABASE_URL host is not *.pooler.supabase.com -- the direct host is IPv6-only without the IPv4 add-on" ;;
esac

# TLS to Postgres is always on (packages/db/src/client.ts). Whether the pooler
# is AUTHENTICATED as well as encrypted depends on having its CA, because
# Supavisor presents a certificate from "Supabase Inc" -- a private root that is
# not in Node's trust store.
#
# CHECK WHAT THE CONTAINERS SEE, NOT WHAT .env SAYS. This used to PASS
# "the pooler certificate will be verified" whenever SUPABASE_CA_CERT was set
# in .env -- a variable no compose service forwarded, naming a host path no
# container could read. Every container ran unverified while this said
# otherwise. docker-compose.yml now mounts ONE file, docker/supabase-ca.crt, at
# /etc/gml/supabase-ca.crt in migrate, app and worker and points
# SUPABASE_CA_CERT there; the file ships empty, which client.ts treats as
# "no CA" (today's warn-and-continue). So that file is what is checked.
CA_FILE="docker/supabase-ca.crt"
if [ -s "${CA_FILE}" ]; then
  if grep -q "BEGIN CERTIFICATE" "${CA_FILE}"; then
    ok "${CA_FILE} holds a certificate -- the pooler certificate will be verified in every container"
  else
    no "${CA_FILE} holds a PEM certificate" \
       "it is non-empty but not a PEM -- replace it with the CA from Project Settings -> Database -> SSL Configuration, or empty it"
  fi
else
  nb "${CA_FILE} is empty -- TLS to Postgres is ENCRYPTED but the certificate is NOT verified."
  nb "  Download it: Project Settings -> Database -> SSL Configuration; save it as ${CA_FILE}; redeploy."
fi
if [ -n "${SUPABASE_CA_CERT:-}" ]; then
  nb "SUPABASE_CA_CERT is set in .env, but no container reads it from there -- they read ${CA_FILE} (docker-compose.yml)."
fi

if command -v psql >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  if psql "$DATABASE_URL" -tAc 'select 1' >/dev/null 2>&1; then
    ok "database accepts a connection"
  else
    no "database accepts a connection" "check the password, and that this box may reach the pooler"
  fi
else
  nb "psql not installed -- connectivity not checked (install postgresql-client-<your project's Postgres major> from PGDG -- README-deploy.md section 7)"
fi

# ---- Supabase API -----------------------------------------------------------
sect "Supabase API"

if [ -n "${NEXT_PUBLIC_SUPABASE_URL:-}" ] && command -v curl >/dev/null 2>&1; then
  # The apikey header is required; without it GoTrue answers 401. Either way a
  # 200 or a 401 proves the endpoint ANSWERED, which is what is being checked --
  # DNS, egress and the project being awake. Only a connection failure, a
  # timeout, or a 404 (wrong project ref) is a real problem here.
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
          -H "apikey: ${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:-}" \
          "${NEXT_PUBLIC_SUPABASE_URL%/}/auth/v1/health" 2>/dev/null)"
  case "$code" in
    200) ok "Supabase Auth reachable (/auth/v1/health 200)" ;;
    401) ok "Supabase Auth reachable (401 -- answered, key not accepted for this endpoint)" ;;
    404) no "Supabase Auth reachable (404)" "the project ref in NEXT_PUBLIC_SUPABASE_URL looks wrong" ;;
    000|"") no "Supabase Auth reachable (no response)" "check DNS and outbound HTTPS from this box; a paused project also does this" ;;
    *) nb "Supabase Auth answered $code -- reachable, but not a status this script recognises" ;;
  esac
fi

# ---- the upload ceiling -----------------------------------------------------
sect "Storage upload limit"

# THE CAP THAT IS INVISIBLE UNTIL A TEACHER TRIES.
#
# Three limits stack, and the SMALLEST wins:
#
#   MAX_UPLOAD_BYTES        2 GiB   apps/web/src/lib/video/upload.ts
#   bucket file_size_limit  2 GiB   _post/005_storage_buckets_and_policies.sql
#   PROJECT global limit    50 MB   Supabase dashboard default  <- binding
#
# The project-wide setting is not in the database and not in any migration, so
# nothing in this repository can see it -- but it is enforced by the resumable
# endpoint the browser actually uses, which answers 413 at CREATION time,
# before a single byte is sent. Measured against this project: 50 MB accepted,
# 60 MB refused.
#
# 50 MB is roughly one to two minutes of phone video. For a programme built on
# lesson recordings that rejects essentially every real upload, and the failure
# surfaces as a generic upload error to the teacher.
#
# This probes the real endpoint by declaring a large upload and reading the
# status. No bytes are transferred and nothing is stored.
if [ -n "${NEXT_PUBLIC_SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SECRET_KEY:-}" ] && command -v curl >/dev/null 2>&1; then
  probe_size=$((600 * 1024 * 1024))   # 600 MB: a realistic lesson recording
  meta="bucketName $(printf 'videos-original' | base64 | tr -d '\n'),objectName $(printf 'preflight/probe.bin' | base64 | tr -d '\n')"
  probe_hdr="$(mktemp 2>/dev/null || echo "/tmp/gml-preflight-$$.hdr")"
  code="$(curl -s -o /dev/null -D "${probe_hdr}" -w '%{http_code}' -m 20 -X POST \
            -H "authorization: Bearer ${SUPABASE_SECRET_KEY}" \
            -H "tus-resumable: 1.0.0" \
            -H "upload-length: ${probe_size}" \
            -H "upload-metadata: ${meta}" \
            "${NEXT_PUBLIC_SUPABASE_URL%/}/storage/v1/upload/resumable" 2>/dev/null)"
  case "$code" in
    201|200)
      ok "a 600 MB upload is accepted by Storage"
      # Terminate the reservation just made (tus DELETE on the upload URL the
      # server returned in Location). No bytes were sent, but the reservation
      # would otherwise sit in the bucket's upload table until Storage expires
      # it -- this comment used to promise the cleanup without doing it.
      probe_loc="$(sed -n 's/^[Ll]ocation:[[:space:]]*//p' "${probe_hdr}" 2>/dev/null | head -n 1 | tr -d '[:cntrl:]')"
      case "${probe_loc}" in
        /*) probe_loc="${NEXT_PUBLIC_SUPABASE_URL%/}${probe_loc}" ;;
      esac
      if [ -n "${probe_loc}" ]; then
        del="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X DELETE \
                 -H "authorization: Bearer ${SUPABASE_SECRET_KEY}" \
                 -H "tus-resumable: 1.0.0" \
                 "${probe_loc}" 2>/dev/null)"
        case "${del}" in
          200|204|404|410) : ;;
          *) nb "could not delete the probe's upload reservation (HTTP ${del:-none}) -- harmless; Storage expires it" ;;
        esac
      fi
      ;;
    413)
      no "a 600 MB upload is accepted by Storage (got 413)" \
         "raise Supabase -> Storage -> Settings -> 'Upload file size limit'. The 50 MB default rejects almost every lesson video, at the resumable endpoint, before any bytes are sent."
      ;;
    *)
      nb "could not probe the upload limit (HTTP ${code:-none}) -- check it by hand in Storage -> Settings"
      ;;
  esac
  rm -f "${probe_hdr}"
fi

# ---- DNS --------------------------------------------------------------------
sect "DNS and TLS prerequisites"

# ACME HTTP-01 needs the name to resolve to THIS box, with :80 reachable from
# the internet. Getting this wrong is the usual reason a first deploy finishes
# with no certificate.
if [ -n "${DOMAIN:-}" ] && [ "$DOMAIN" != "localhost" ]; then
  resolved="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)"
  if [ -z "$resolved" ]; then
    no "$DOMAIN resolves" "create an A record for $DOMAIN pointing at this instance's Elastic IP"
  else
    ok "$DOMAIN resolves to $resolved"
    public="$(curl -s -m 5 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null)"
    if [ -n "$public" ]; then
      if [ "$resolved" = "$public" ]; then
        ok "$DOMAIN points at THIS instance ($public)"
      else
        no "$DOMAIN points at $resolved but this instance is $public" \
           "update the A record, or wait for propagation, before deploying"
      fi
    else
      nb "not on EC2 (no instance metadata) -- cannot confirm the A record points here"
    fi
  fi
else
  nb "DOMAIN is unset or localhost -- no public certificate will be issued"
fi

case "${ACME_EMAIL:-}" in
  ?*@?*.?*) ok "ACME_EMAIL looks like an address" ;;
  "") : ;;
  *) no "ACME_EMAIL looks like an address" "expiry notices from the CA go here" ;;
esac

# ---- host -------------------------------------------------------------------
sect "Host"

if command -v docker >/dev/null 2>&1; then
  ok "docker present ($(docker --version 2>/dev/null | sed 's/,.*//'))"
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose v2 present ($(docker compose version --short 2>/dev/null))"
  else
    no "docker compose v2 present" "this repo uses the compose PLUGIN, not the old docker-compose binary"
  fi
  if docker info >/dev/null 2>&1; then
    ok "docker daemon reachable by this user"
  else
    no "docker daemon reachable by this user" "sudo usermod -aG docker \$USER, then log out and back in"
  fi
else
  no "docker present" "install Docker Engine and the compose plugin -- README-deploy.md 2.5"
fi

# deploy.sh runs two things on the HOST, not in a container, and neither was
# checked here:
#
#   node  the SM-5 restore-drill gate, BEFORE anything is built. Missing, the
#         deploy dies with `node: command not found` having built nothing.
#   pnpm  the post-deploy smoke suite, AFTER migrate, health, seed and
#         verify-auth. Missing, a WORKING deploy ends in exit 127 and reads as a
#         failed one.
#
# The floor is package.json's `engines.node` (>=22).
if command -v node >/dev/null 2>&1; then
  node_v="$(node --version 2>/dev/null)"
  node_major="${node_v#v}"
  node_major="${node_major%%.*}"
  case "${node_major}" in
    ""|*[!0-9]*) no "node is at least 22 (found '${node_v}')" "install Node 22 -- README-deploy.md 2.5" ;;
    *)
      if [ "${node_major}" -ge 22 ]; then
        ok "node present (${node_v})"
      else
        no "node is at least 22 (found ${node_v}; package.json engines)" "install Node 22 from NodeSource -- README-deploy.md 2.5"
      fi
      ;;
  esac
else
  no "node present" "deploy.sh runs the SM-5 gate with host node before building anything -- install Node 22 per README-deploy.md 2.5"
fi
if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm present ($(pnpm --version 2>/dev/null))"
else
  no "pnpm present" "deploy.sh runs the post-deploy smoke suite with host pnpm -- 'sudo corepack enable' per README-deploy.md 2.5"
fi
if command -v curl >/dev/null 2>&1; then
  ok "curl present"
else
  no "curl present" "deploy.sh's health probe is a curl -- sudo apt-get install -y curl"
fi
# Not needed by any script; the runbooks pipe /api/health through it.
if command -v jq >/dev/null 2>&1; then
  ok "jq present"
else
  nb "jq not installed -- the runbooks pipe /api/health through it (sudo apt-get install -y jq)"
fi

# Caddy has to BIND these, so anything already listening is a blocker.
#
# The `command -v ss` guard is separated from the check deliberately. Written as
# one condition -- `if command -v ss && ss ... | grep -q LISTEN` -- a host
# WITHOUT ss falls to the else branch and reports "port is free" without having
# looked, which is the worst kind of check: it reports success for the case it
# cannot evaluate.
if command -v ss >/dev/null 2>&1; then
  for p in 80 443; do
    if ss -ltn "sport = :$p" 2>/dev/null | grep -q LISTEN; then
      no "port $p is free" "something already listens on $p (often nginx or apache) -- stop and disable it"
    else
      ok "port $p is free"
    fi
  done
else
  nb "ss not available -- ports 80 and 443 NOT checked (this is expected off Linux)"
fi

avail_kb="$(df -Pk . 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "$avail_kb" ]; then
  avail_gb=$((avail_kb / 1024 / 1024))
  if [ "$avail_gb" -ge 20 ]; then
    ok "disk: $avail_gb GiB free here"
  else
    no "disk: $avail_gb GiB free here" "the checkout, node_modules and each build need room here -- 30 GiB root recommended (README-deploy.md 2.4); images, build cache, transcode scratch and dumps belong on the data volume (README-deploy.md 2.5)"
  fi
fi

# Docker keeps images, build cache and every volume -- the worker's transcode
# scratch among them, a copy of each source of up to 2 GB plus its HLS output
# -- under its data root, /var/lib/docker by default: the ROOT volume, sized at
# 30 GiB in README-deploy.md 2.4. The 100 GiB data volume at /var/lib/gml held
# only the local dumps, although both runbooks said scratch lived there, and
# the disk check above looks only at `.`. README-deploy.md 2.5 moves the data
# root onto the data volume; this checks that it was done. A single large root
# disk (60 GiB or more) is not a failure: the point is room, not layout.
#
# 60 GiB OF DISK IS 56 GiB OF FILESYSTEM. df reports the filesystem, and the
# partition table, the EFI and /boot partitions and ext4's own metadata come
# out of the disk first: a 60 GiB EBS volume on the Ubuntu 24.04 AMI shows
# 58 GiB, rounded down. This compared df's figure with 60, so the very disk
# this comment calls fine was a FAIL. The bar is 56 GiB as df shows it:
# about 7% for that overhead, so a 60 GiB disk clears it however it is
# partitioned.
docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
if [ -n "${docker_root}" ]; then
  root_mnt="$(df -Pk / 2>/dev/null | awk 'NR==2{print $6}')"
  root_kb="$(df -Pk / 2>/dev/null | awk 'NR==2{print $2}')"
  root_gb=$(( ${root_kb:-0} / 1024 / 1024 ))
  data_mnt="$(df -Pk "${docker_root}" 2>/dev/null | awk 'NR==2{print $6}')"
  if [ -z "${data_mnt}" ]; then
    nb "Docker data root ${docker_root} could not be inspected -- check it is on the data volume (README-deploy.md 2.5)"
  elif [ "${data_mnt}" != "${root_mnt}" ]; then
    ok "Docker data root ${docker_root} is on ${data_mnt}, not the root volume"
  elif [ "${root_gb}" -ge 56 ]; then
    ok "Docker data root ${docker_root} is on the root volume, which has ${root_gb} GiB (a 60 GiB or larger disk)"
  else
    no "Docker data root ${docker_root} is on the ${root_gb} GiB root volume" \
      "images, build cache and the worker's transcode scratch will fill it -- move Docker's data root to the data volume (README-deploy.md 2.5), or use a root disk of 60 GiB or more (df shows at least 56 GiB)"
  fi
fi

# ---- disaster recovery ------------------------------------------------------
sect "Disaster recovery"

# Supabase has NO backup product for Storage. Without these three the videos are
# backed up by nobody -- and unlike most misconfigurations, that one is
# discovered only when they are needed.
#
# The SAME condition backup.sh uses. This used to demand SUPABASE_S3_ENDPOINT
# (which backup.sh derives, so it is optional) and only the short credential
# names (backup.sh accepts the dashboard's too), so it warned on a working
# configuration -- and never checked the secret, without which backup.sh
# skips the mirror.
S3_KEY="${SUPABASE_S3_ACCESS_KEY_ID:-${SUPABASE_S3_ACCESS_KEY:-}}"
S3_SECRET="${SUPABASE_S3_SECRET_ACCESS_KEY:-${SUPABASE_S3_SECRET_KEY:-}}"
if [ -n "${S3_KEY}" ] && [ -n "${S3_SECRET}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  ok "Storage mirror configured -- the videos will be backed up"
  if command -v rclone >/dev/null 2>&1; then
    ok "rclone installed"
  else
    no "rclone installed" "apt-get install -y rclone -- backup.sh needs it for the object mirror"
  fi
else
  nb "Storage mirror NOT configured -- THE VIDEOS WILL NOT BE BACKED UP BY ANYONE."
  nb "  Set SUPABASE_S3_ACCESS_KEY_ID, SUPABASE_S3_SECRET_ACCESS_KEY and BACKUP_S3_BUCKET."
  nb "  SUPABASE_S3_ENDPOINT is optional: backup.sh derives it from NEXT_PUBLIC_SUPABASE_URL."
fi
if [ -n "${BACKUP_S3_BUCKET:-}" ] && ! command -v aws >/dev/null 2>&1; then
  nb "aws CLI not installed -- backup.sh will keep the database dump ON THIS HOST ONLY (README-deploy.md section 7)"
fi

# Is pg_dump NEW ENOUGH for this server? pg_dump aborts against a newer server
# major ("server version mismatch"), so a client that is merely INSTALLED used
# to PASS here and then write no dump, every night. The server's major is asked
# (scripts/lib/pg-major.sh), never assumed, and a mismatch BLOCKS: a WARN would
# be exactly as invisible as the defect it replaces.
pg_rc=0
pg_check_dump_client "${DATABASE_URL:-}" || pg_rc=$?
case "${pg_rc}" in
  0) ok "pg_dump ${PG_CLIENT_MAJOR} can dump this PostgreSQL ${PG_SERVER_MAJOR} server" ;;
  1)
    no "pg_dump ${PG_CLIENT_MAJOR} can dump this PostgreSQL ${PG_SERVER_MAJOR} server" \
       "install postgresql-client-${PG_SERVER_MAJOR} from the PGDG repository (README-deploy.md section 7) -- as is, every nightly backup.sh run aborts"
    ;;
  *)
    if ! command -v pg_dump >/dev/null 2>&1; then
      srv_major=""
      if command -v psql >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
        srv_major="$(pg_major "$(psql "${DATABASE_URL}" -XtAc 'SHOW server_version_num' 2>/dev/null | tr -d '[:space:]')" 2>/dev/null || true)"
      fi
      nb "pg_dump not installed -- backup.sh cannot dump the database (install postgresql-client-${srv_major:-<server major>} from PGDG -- README-deploy.md section 7)"
    else
      nb "pg_dump present, but its compatibility with the server was NOT checked: ${PG_CHECK_ERROR}"
    fi
    ;;
esac

# ---- summary ----------------------------------------------------------------
printf '\n  %d passed, %d warnings, %d failed\n\n' "$pass" "$warn" "$fail"
if [ "$fail" -gt 0 ]; then
  echo "  Blocking failures above. Fix them before running scripts/deploy.sh."
  exit 1
fi
echo "  Safe to deploy:  bash scripts/deploy.sh"
echo "  deploy.sh then runs verify-auth.mjs, which checks the access-token hook"
echo "  -- the dashboard step with no SQL equivalent, and the one most often"
echo "  missed."
exit 0
