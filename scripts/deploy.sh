#!/usr/bin/env bash
# Deploy the GML LMS stack.
#
# ── WHAT THE PREVIOUS VERSION GOT WRONG ──────────────────────────────────────
#
# It could not complete on a clean host, in four distinct ways:
#
#   1. It polled http://localhost:3000/api/health. NO SERVICE PUBLISHES PORT
#      3000 — only caddy publishes anything (80/443), so the wait could never
#      succeed and the script exited 1 after 60 seconds every single time.
#   2. It then ran `docker compose exec app pnpm --filter @gml/db migrate`.
#      The app image is a Next.js standalone build: no pnpm, no tsx, no
#      packages/db. That command cannot work in that container, by construction.
#   3. Migrations already run: the `migrate` service gates `app` via
#      depends_on/service_completed_successfully. Running them again after the
#      app was up was both redundant and out of order.
#   4. Its final line printed the literal text ${DOMAIN} — a backslash inside a
#      double-quoted string — so the operator was told to visit a placeholder.
#
# ── WHAT IT DOES NOW ─────────────────────────────────────────────────────────
#
#   preflight -> build -> up (migrate gates app) -> health via caddy -> seed
#
# Idempotent. Safe to re-run: the migration ledgers make a re-run a no-op, and
# the seed never rotates a live account's password or an existing gate.

set -euo pipefail

cd "$(dirname "$0")/.."

# Health is checked THROUGH CADDY, because that is the only thing listening.
# Two signals: the app container's own healthcheck, and an HTTP probe that must
# actually reach the application and read ok:true out of its body.
#
# THE PROBE USED TO BE INERT. It was:
#
#     HEALTH_URL=http://127.0.0.1/api/health
#     until curl -fsS -o /dev/null "$HEALTH_URL"; do ...
#
# Caddy answers plaintext with a 308 redirect to HTTPS, and `curl -f` only
# fails on 4xx and 5xx -- a 3xx exits 0. So the loop succeeded the moment CADDY
# came up, with an empty body, having never contacted the app. Measured:
#
#     $ curl -fsS -o /dev/null http://127.0.0.1/api/health ; echo $?
#     0                        # http_code=308, body empty
#
# A deploy with a crash-looping app, an unreachable database or failed
# migrations would have reported "healthy after 3s" and gone on to seed. The
# gate whose entire purpose is to catch that was the thing that could not.
#
# The comment above it also claimed the container healthcheck was the primary
# signal. No part of the script read it. Both are fixed below.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1/api/health}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-3}"

log() { echo "[deploy] $(date -Iseconds) — $*"; }
fail() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# DRY RUN — resolve configuration, print it, and stop. Testing hook only.
#
# tests/scripts/deploy-sh.test.mjs uses this to prove that the HEALTH_*
# variables the health probe dereferences at the bottom of this script are
# actually DEFINED. Under `set -euo pipefail` an undefined one aborts the
# deploy, and `bash -n` cannot see that — an undefined variable is a runtime
# failure, not a syntax error. Only executing the script catches it, and until
# tests/scripts/ existed nothing executed this script at all.
#
# SCOPE, STATED HONESTLY: the echo list below is hand-maintained, and it covers
# HEALTH_* only. It does NOT prove that every variable anywhere in this file is
# defined — nothing after the `exit 0` runs, so `set -u` never reaches it. The
# test asserts exactly what this block demonstrates and no more.
#
# OFF MUST MEAN OFF. This used to be `[ -n "${DEPLOY_DRY_RUN:-}" ]`, under which
# DEPLOY_DRY_RUN=0 and =false are both TRUE — so an operator writing either to
# mean "not a dry run" would get a no-op that printed three lines and exited 0,
# and `git pull && ./scripts/deploy.sh` would report success having deployed
# nothing. The seed scripts in packages/db/src/scripts/ already use the strict
# `=== "true"` form; this matches them, and the banner goes to stderr so a dry
# run can never be mistaken for a deploy.
case "${DEPLOY_DRY_RUN:-}" in
  ""|0|false|no|off) : ;;
  toolchain)
    # Host-toolchain check only: runs the loop below, then stops. Lets the test
    # drive it with a stripped PATH without needing docker to be installed.
    DEPLOY_DRY_RUN_TOOLCHAIN=1
    ;;
  *)
    echo "[deploy] DRY RUN — configuration only. NOTHING WAS DEPLOYED." >&2
    echo "HEALTH_URL=${HEALTH_URL}"
    echo "HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS}"
    echo "HEALTH_INTERVAL_SECONDS=${HEALTH_INTERVAL_SECONDS}"
    exit 0
    ;;
esac

# ── 0. Preflight ─────────────────────────────────────────────────────────────

# THE HOST TOOLCHAIN, CHECKED BEFORE ANYTHING IS BUILT.
#
# This script needs four host binaries and checks for none of them today:
#
#   docker  obvious, and its absence fails obviously.
#   node    the SM-5 restore-drill gate below is a plain `node` invocation,
#           under `set -euo pipefail`, BEFORE the first `docker compose build`.
#           On a host without node the deploy dies there with 127 having built
#           nothing, for a reason that reads like a missing script.
#   pnpm    the post-deploy smoke check at the very bottom. That one is worse:
#           it sits AFTER health, seed and verify-auth, so a host with node but
#           no pnpm gets a fully working stack and THEN a 127 abort — and the
#           operator is told the deploy failed when it in fact worked.
#   curl    the health probe. Worst of the four, because curl is used as a LOOP
#           CONDITION, not a command: without it the probe simply never
#           succeeds, the script spins the full HEALTH_TIMEOUT_SECONDS and then
#           reports "not healthy after 180s" and dumps app logs — blaming the
#           application for a missing host binary.
#
# All four become a named blocker here instead. README-deploy.md 2.5 ("Prepare
# the instance") installs them; nothing in either runbook says the host needs
# any toolchain at all, including Docker.
#
# `docker` alone does not prove Compose v2 is present, and `docker compose
# build` below is the first thing that would fail on it, so probe the plugin.
for cmd in docker node pnpm curl; do
  command -v "${cmd}" >/dev/null 2>&1 \
    || fail "${cmd} is not installed on this host — see README-deploy.md 2.5, 'Prepare the instance'"
done
docker compose version >/dev/null 2>&1 \
  || fail "the Docker Compose v2 plugin is not available (\`docker compose version\` failed) — see README-deploy.md 2.5"

# See the DEPLOY_DRY_RUN block above: this mode exists so the toolchain check
# itself is testable without docker being installed on the test machine.
if [ -n "${DEPLOY_DRY_RUN_TOOLCHAIN:-}" ]; then
  echo "[deploy] DRY RUN (toolchain) — all required host binaries present. NOTHING WAS DEPLOYED." >&2
  echo "TOOLCHAIN_OK=1"
  exit 0
fi

[ -f .env ] || fail ".env not found. Copy .env.example to .env and fill it in."

# Refuse to run with a world-readable secrets file. This holds the Supabase
# service-role key, which bypasses RLS entirely.
perms="$(stat -c '%a' .env 2>/dev/null || echo '')"
case "${perms}" in
  ""|600|400) : ;;   # empty means stat is unavailable (e.g. on Windows) — skip
  *) echo "[deploy] WARNING: .env is mode ${perms}; run 'chmod 600 .env'" >&2 ;;
esac

missing=""
for var in DOMAIN ACME_EMAIL DATABASE_URL NEXT_PUBLIC_SUPABASE_URL \
           NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY \
           WHATSAPP_APP_SECRET; do
  grep -qE "^${var}=.+" .env || missing="${missing} ${var}"
done
[ -z "${missing}" ] || fail "these variables are unset or empty in .env:${missing}"

# SM-5: refuse to deploy on a stale restore drill. Self-skips outside
# production, so this is a no-op on a staging box.
log "restore-drill preflight"
node scripts/check-restore-drill.mjs

# ── 1. Build ─────────────────────────────────────────────────────────────────
# Tag whatever is running now as ':previous' FIRST, so scripts/rollback.sh has
# something to go back to. Without this step a rollback has no target, which is
# how the repository ended up with no rollback procedure at all.
for svc in app worker; do
  if docker image inspect "gml-lms-${svc}:current" >/dev/null 2>&1; then
    docker tag "gml-lms-${svc}:current" "gml-lms-${svc}:previous"
    log "tagged gml-lms-${svc}:current -> :previous"
  fi
done

log "building images"
# Compose writes straight into gml-lms-<svc>:current, because docker-compose.yml
# now names that tag explicitly on each service.
#
# WHAT WAS HERE, AND WHY IT COULD NOT WORK:
#
#     built="$(docker compose images -q "${svc}" | head -1)"
#     docker tag "${built}" "gml-lms-${svc}:current"
#
# `docker compose images` lists the images of CREATED CONTAINERS, not the ones
# just built. It ran after `build` but before `up`, so at that moment the
# containers were still the OLD ones -- and on a first deploy there are no
# containers at all, so it returned nothing and tagged nothing. Neither
# gml-lms-app:current nor :previous has ever actually existed on a deployed
# box, which is why rollback.sh always aborted with ":previous does not exist".
docker compose build

# ── 2. Up ────────────────────────────────────────────────────────────────────
# `migrate` runs first and `app`/`worker` block on it exiting 0. If the schema
# change fails, the new containers never start and the PREVIOUS ones keep
# serving — that is the rollback posture, and it is why this is safe to run
# against a live box.
log "starting stack (migrate runs first and gates app/worker)"
docker compose up -d --remove-orphans

# Surface the migration outcome explicitly rather than leaving it in the logs.
migrate_exit="$(docker compose ps -a --format '{{.Service}} {{.ExitCode}}' 2>/dev/null | awk '$1=="migrate"{print $2}' | head -1)"
if [ -n "${migrate_exit}" ] && [ "${migrate_exit}" != "0" ]; then
  echo "[deploy] migrations FAILED (exit ${migrate_exit}). The previous app container is still serving." >&2
  docker compose logs --no-color --tail 40 migrate >&2
  exit 1
fi
log "migrations applied"

# ── 3. Health ────────────────────────────────────────────────────────────────
# The app container's own healthcheck verdict: healthy | unhealthy | starting.
app_container_health() {
  docker compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null     | awk '$1=="app"{print $2}' | head -1
}

# Reaches the APPLICATION and reads its verdict, rather than whatever the proxy
# says first.
#
#   -L  follow Caddy's 308 to HTTPS. Without it curl stops at the redirect and
#       exits 0 -- the defect described above.
#   -k  the redirect lands on https://127.0.0.1 while the certificate is issued
#       for $DOMAIN, so the name will not match from the box itself. Certificate
#       validity is not what this check is for; scripts/verify-tls-local.sh and
#       any browser cover that. What is being checked here is the application.
#   grep the body, because /api/health answers 503 with ok:false when the
#       database, storage or migrations are not right, and a status code alone
#       would not distinguish "app is up" from "app is up and working".
app_http_healthy() {
  curl -fsSLk -m 10 "${HEALTH_URL}" 2>/dev/null | grep -q '"ok":true'
}

log "waiting for health at ${HEALTH_URL} (timeout ${HEALTH_TIMEOUT_SECONDS}s)"
elapsed=0
until app_http_healthy; do
  if [ "${elapsed}" -ge "${HEALTH_TIMEOUT_SECONDS}" ]; then
    echo "[deploy] not healthy after ${HEALTH_TIMEOUT_SECONDS}s." >&2
    echo "[deploy] /api/health returns 503 until db, storage AND migrations all pass." >&2
    echo "[deploy] app container health: $(app_container_health)" >&2
    echo "[deploy] last /api/health body:" >&2
    curl -sLk -m 10 "${HEALTH_URL}" || true
    echo >&2
    docker compose logs --no-color --tail 40 app >&2
    exit 1
  fi
  sleep "${HEALTH_INTERVAL_SECONDS}"
  elapsed=$((elapsed + HEALTH_INTERVAL_SECONDS))
done
log "healthy after ${elapsed}s (app container: $(app_container_health))"

# ── 4. Seed ──────────────────────────────────────────────────────────────────
# Run in the MIGRATE image, which has pnpm, tsx and packages/db. The app image
# has none of them — that was defect 2 above.
log "seeding (idempotent: skips anything that already exists)"
docker compose run --rm --no-deps migrate pnpm exec tsx src/scripts/seed_all.ts

# ── 5. Verify ────────────────────────────────────────────────────────────────
log "verifying auth configuration"
docker compose run --rm --no-deps migrate node scripts/verify-auth.mjs

# ── 6. Smoke ─────────────────────────────────────────────────────────────────
# Drives the deployment that was just made, over real HTTP, through Caddy. It
# FAILS rather than skips when it cannot reach the target — this suite used to
# skip itself on an unreachable app AND be run with `|| true`, so it was
# structurally incapable of failing and reported green whether the deploy had
# worked or not.
log "post-deploy smoke check"
SMOKE_BASE_URL="http://127.0.0.1" pnpm test:smoke

DOMAIN_VALUE="$(grep -E '^DOMAIN=' .env | cut -d= -f2- | tr -d '"'"'"' ')"
log "done. Sign in at https://${DOMAIN_VALUE}/"
