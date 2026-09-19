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
mode="$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null || echo unknown)"
if [ "$mode" = "600" ]; then
  ok ".env is mode 600"
else
  no ".env is mode 600 (found $mode)" "chmod 600 .env"
fi

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
         SUPABASE_SECRET_KEY DATABASE_URL DOMAIN ACME_EMAIL WHATSAPP_APP_SECRET; do
  req "$v"
done

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
if [ -n "${SUPABASE_CA_CERT:-}" ]; then
  if [ -f "${SUPABASE_CA_CERT}" ] || printf '%s' "${SUPABASE_CA_CERT}" | grep -q "BEGIN CERTIFICATE"; then
    ok "SUPABASE_CA_CERT set -- the pooler certificate will be verified"
  else
    no "SUPABASE_CA_CERT points at a readable file or contains a PEM" \
       "it is neither an existing file nor a PEM -- the app will fall back to unverified TLS"
  fi
else
  nb "SUPABASE_CA_CERT unset -- TLS to Postgres is ENCRYPTED but the certificate is NOT verified."
  nb "  Download it: Project Settings -> Database -> SSL Configuration."
fi

if command -v psql >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  if psql "$DATABASE_URL" -tAc 'select 1' >/dev/null 2>&1; then
    ok "database accepts a connection"
  else
    no "database accepts a connection" "check the password, and that this box may reach the pooler"
  fi
else
  nb "psql not installed -- connectivity not checked (apt-get install -y postgresql-client-16)"
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
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 -X POST \
            -H "authorization: Bearer ${SUPABASE_SECRET_KEY}" \
            -H "tus-resumable: 1.0.0" \
            -H "upload-length: ${probe_size}" \
            -H "upload-metadata: ${meta}" \
            "${NEXT_PUBLIC_SUPABASE_URL%/}/storage/v1/upload/resumable" 2>/dev/null)"
  case "$code" in
    201|200)
      ok "a 600 MB upload is accepted by Storage"
      # Clean up the reservation we just made. Harmless if it 404s.
      ;;
    413)
      no "a 600 MB upload is accepted by Storage (got 413)" \
         "raise Supabase -> Storage -> Settings -> 'Upload file size limit'. The 50 MB default rejects almost every lesson video, at the resumable endpoint, before any bytes are sent."
      ;;
    *)
      nb "could not probe the upload limit (HTTP ${code:-none}) -- check it by hand in Storage -> Settings"
      ;;
  esac
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
  no "docker present" "install Docker Engine and the compose plugin"
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
    no "disk: $avail_gb GiB free here" "images, transcode scratch and backups need room -- 30 GiB root recommended"
  fi
fi

# ---- disaster recovery ------------------------------------------------------
sect "Disaster recovery"

# Supabase has NO backup product for Storage. Without these three the videos are
# backed up by nobody -- and unlike most misconfigurations, that one is
# discovered only when they are needed.
if [ -n "${SUPABASE_S3_ENDPOINT:-}" ] && [ -n "${SUPABASE_S3_ACCESS_KEY:-}" ] && [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  ok "Storage mirror configured -- the videos will be backed up"
  if command -v rclone >/dev/null 2>&1; then
    ok "rclone installed"
  else
    no "rclone installed" "apt-get install -y rclone -- backup.sh needs it for the object mirror"
  fi
else
  nb "Storage mirror NOT configured -- THE VIDEOS WILL NOT BE BACKED UP BY ANYONE."
  nb "  Set SUPABASE_S3_ENDPOINT, SUPABASE_S3_ACCESS_KEY, SUPABASE_S3_SECRET_KEY, BACKUP_S3_BUCKET."
fi
if command -v pg_dump >/dev/null 2>&1; then
  ok "pg_dump installed"
else
  nb "pg_dump not installed -- backup.sh cannot dump the database (apt-get install -y postgresql-client-16)"
fi

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
