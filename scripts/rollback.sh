#!/usr/bin/env bash
# Roll the application back to the previous image.
#
# This script DID NOT EXIST. The repository referenced no rollback procedure
# anywhere — not in README-IT.md, not in the deploy script, nowhere. The only
# recovery posture was the passive one: if `migrate` exits non-zero, `app` never
# starts and the old container keeps serving. That is genuinely useful and it
# only covers one failure (a bad migration). It does nothing for the case that
# actually happens — migrations fine, application broken.
#
# ── WHAT THIS CAN AND CANNOT UNDO ────────────────────────────────────────────
#
# CAN:    the application containers. Docker keeps the previous image; this
#         retags and restarts against it.
#
# CANNOT: the database. Migrations are forward-only by design and there are no
#         down-sections. If a migration is the problem, restoring the database
#         from a backup is the procedure (see README-deploy.md, "Restoring"),
#         and it is a deliberate, destructive act with data loss between the
#         backup and now — not something a script should do on your behalf.
#
# This asymmetry is the reason deploys should ADD columns before code reads
# them and DROP them a release later, never in the same deploy.

set -euo pipefail

cd "$(dirname "$0")/.."

log() { echo "[rollback] $(date -Iseconds) — $*"; }
fail() { echo "[rollback] ERROR: $*" >&2; exit 1; }

SERVICES="${SERVICES:-app worker}"

# The health probe's target, resolved exactly as scripts/deploy.sh resolves it
# (see the note there): the site Caddy serves, pinned to this box. DOMAIN from
# the shell wins over .env, as it does when Compose interpolates it for caddy.
DOMAIN_VALUE="${DOMAIN:-}"
if [ -z "${DOMAIN_VALUE}" ] && [ -f .env ]; then
  DOMAIN_VALUE="$(grep -E '^DOMAIN=' .env | tail -n 1 | cut -d= -f2- | tr -d '"'"'"' [:cntrl:]' || true)"
fi
DOMAIN_VALUE="${DOMAIN_VALUE:-localhost}"
HEALTH_URL="${HEALTH_URL:-https://${DOMAIN_VALUE}/api/health}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-120}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-3}"

log "images currently available"
docker images --format '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}' \
  | grep -E '^gml-lms-(app|worker)' || fail "no gml-lms images found — nothing to roll back to"

# `previous` is the tag deploy.sh leaves behind. Without it there is nothing to
# roll back TO, and saying so is better than starting containers from whatever
# `latest` happens to point at.
#
# And :previous must be a DIFFERENT image from the one running, for at least
# one service. deploy.sh used to overwrite :previous with :current on every
# run, so after a re-run of the same code the two named one image, and this
# script retagged it onto itself and reported a rollback; that state is still
# refused. A service whose :previous IS its :current was not changed by the
# last release (deploy.sh moves every :previous together, so this is its
# image in the release being rolled back to) and is left running.
ROLL=""
for svc in ${SERVICES}; do
  prev_id="$(docker image inspect --format '{{.Id}}' "gml-lms-${svc}:previous" 2>/dev/null || true)"
  [ -n "${prev_id}" ] \
    || fail "gml-lms-${svc}:previous does not exist. Nothing to roll back to — this deploy was the first, or the previous image has been pruned."
  cur_id="$(docker image inspect --format '{{.Id}}' "gml-lms-${svc}:current" 2>/dev/null || true)"
  if [ "${prev_id}" = "${cur_id}" ]; then
    log "gml-lms-${svc}: unchanged by the last release -- left running"
  else
    ROLL="${ROLL:+${ROLL} }${svc}"
  fi
done
[ -n "${ROLL}" ] \
  || fail "every :previous is the image already running (${SERVICES}). A rollback would restart the same release. Check out the release you want and run ./scripts/deploy.sh instead."

log "confirming"
echo
echo "  This will stop ${ROLL} and restart it from the ':previous' image."
echo "  The DATABASE IS NOT TOUCHED. If a migration is the problem, this will"
echo "  not help — see README-deploy.md, 'Restoring from backup'."
echo
read -r -p "  Type 'rollback' to continue: " confirm
[ "${confirm}" = "rollback" ] || fail "aborted"

for svc in ${ROLL}; do
  log "retagging gml-lms-${svc}:previous -> current"
  docker tag "gml-lms-${svc}:previous" "gml-lms-${svc}:current"
done

log "restarting ${ROLL}"
# --no-deps so this does not re-run `migrate`: the schema is already where it
# is, and re-running it on a rollback is at best a no-op and at worst confusing.
# shellcheck disable=SC2086
docker compose up -d --no-deps ${ROLL}

# The SAME defects deploy.sh had, twice over. First the probe exited 0 on
# whatever the proxy answered, never reaching the app. Then it was made strict
# but kept a hard-coded http://127.0.0.1/api/health -- and Host 127.0.0.1
# matches no Caddy site block, so it could NEVER read the app's `"ok":true`.
# Every rollback therefore ended "still unhealthy after 120s", AFTER the
# containers had already been restarted from :previous: the rollback happened
# and only the verdict was wrong, which trains an operator to distrust a
# rollback that worked.
#
#   --resolve  the site name Caddy serves, pinned to this box
#   -k         certificate validity is not what this gate is for
#   grep the body, because /api/health answers 503 with ok:false when the
#              database, storage or migrations are wrong -- and a rollback is
#              most often run precisely when something is wrong
#
# tests/scripts/rollback-sh.test.mjs runs this script against a curl stub that
# answers the way this stack's Caddy does.
rollback_healthy() {
  curl -fsSk -m 10 --resolve "${DOMAIN_VALUE}:443:127.0.0.1" "${HEALTH_URL}" 2>/dev/null | grep -q '"ok":true'
}

log "waiting for health at ${HEALTH_URL} via this box's Caddy"
elapsed=0
until rollback_healthy; do
  if [ "${elapsed}" -ge "${HEALTH_TIMEOUT_SECONDS}" ]; then
    echo "[rollback] still unhealthy after ${HEALTH_TIMEOUT_SECONDS}s — the previous image may not be compatible" >&2
    echo "[rollback] with the CURRENT schema. Check 'docker compose logs app'." >&2
    exit 1
  fi
  sleep "${HEALTH_INTERVAL_SECONDS}"
  elapsed=$((elapsed + HEALTH_INTERVAL_SECONDS))
done

log "rolled back and healthy after ${elapsed}s"
log "the database was NOT changed. Verify the application behaves as expected."
