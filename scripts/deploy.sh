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
# Uses the app's own container health as the primary signal and the HTTP probe
# as confirmation that the proxy path works end to end.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1/api/health}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-3}"

log() { echo "[deploy] $(date -Iseconds) — $*"; }
fail() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# ── 0. Preflight ─────────────────────────────────────────────────────────────
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
docker compose build

# Tag the freshly built images as ':current' so the next deploy can demote them.
for svc in app worker; do
  built="$(docker compose images -q "${svc}" 2>/dev/null | head -1)"
  [ -n "${built}" ] && docker tag "${built}" "gml-lms-${svc}:current"
done

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
log "waiting for health at ${HEALTH_URL} (timeout ${HEALTH_TIMEOUT_SECONDS}s)"
elapsed=0
until curl -fsS -o /dev/null "${HEALTH_URL}"; do
  if [ "${elapsed}" -ge "${HEALTH_TIMEOUT_SECONDS}" ]; then
    echo "[deploy] not healthy after ${HEALTH_TIMEOUT_SECONDS}s." >&2
    echo "[deploy] /api/health returns 503 until db, storage AND migrations all pass." >&2
    curl -s "${HEALTH_URL}" || true
    echo >&2
    docker compose logs --no-color --tail 40 app >&2
    exit 1
  fi
  sleep "${HEALTH_INTERVAL_SECONDS}"
  elapsed=$((elapsed + HEALTH_INTERVAL_SECONDS))
done
log "healthy after ${elapsed}s"

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
