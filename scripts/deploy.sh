#!/usr/bin/env bash
# Spec 108 — SM-5 deploy pre-flight wrapper.
# Chains four steps in order: restore-drill gate, then compose boot, then
# /api/health wait, then migrations + seed_all orchestrator.
# Failure semantics: set -euo pipefail aborts the whole chain on any single
# failure. No silent || true swallows — if a step fails the operator sees it.

set -euo pipefail

HEALTH_URL="${HEALTH_URL:-http://localhost:3000/api/health}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-2}"

echo "[deploy] $(date -Iseconds) — SM-5 restore-drill pre-flight check"
# In non-production (NODE_ENV != production) the check-restore-drill script
# self-skips. In production, this exits non-zero if workspace/last_restore_drill.json
# is missing or older than 30 days, and bash -e propagates the failure here.
node scripts/check-restore-drill.mjs

echo "[deploy] $(date -Iseconds) — docker compose up -d"
docker compose up -d

echo "[deploy] $(date -Iseconds) — waiting for app health at ${HEALTH_URL} (timeout ${HEALTH_TIMEOUT_SECONDS}s)"
elapsed=0
until curl -fsS -o /dev/null "${HEALTH_URL}"; do
  if [ "${elapsed}" -ge "${HEALTH_TIMEOUT_SECONDS}" ]; then
    echo "[deploy] app failed to become healthy in ${HEALTH_TIMEOUT_SECONDS}s — check 'docker compose logs app'" >&2
    exit 1
  fi
  sleep "${HEALTH_INTERVAL_SECONDS}"
  elapsed=$((elapsed + HEALTH_INTERVAL_SECONDS))
done
echo "[deploy] app healthy after ${elapsed}s"

echo "[deploy] $(date -Iseconds) — running migrations"
docker compose exec -T app pnpm --filter @gml/db migrate

echo "[deploy] $(date -Iseconds) — running seed_all orchestrator (spec 104)"
docker compose exec -T app pnpm --filter @gml/db exec tsx packages/db/src/scripts/seed_all.ts

echo "[deploy] $(date -Iseconds) — stack is up. Visit https://\${DOMAIN}/ to sign in as SUPER_ADMIN_EMAIL."
