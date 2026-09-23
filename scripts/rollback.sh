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

log "images currently available"
docker images --format '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}' \
  | grep -E '^gml-lms-(app|worker)' || fail "no gml-lms images found — nothing to roll back to"

# `previous` is the tag deploy.sh leaves behind. Without it there is nothing to
# roll back TO, and saying so is better than starting containers from whatever
# `latest` happens to point at.
for svc in ${SERVICES}; do
  docker image inspect "gml-lms-${svc}:previous" >/dev/null 2>&1 \
    || fail "gml-lms-${svc}:previous does not exist. Nothing to roll back to — this deploy was the first, or the previous image has been pruned."
done

log "confirming"
echo
echo "  This will stop ${SERVICES} and restart them from the ':previous' image."
echo "  The DATABASE IS NOT TOUCHED. If a migration is the problem, this will"
echo "  not help — see README-deploy.md, 'Restoring from backup'."
echo
read -r -p "  Type 'rollback' to continue: " confirm
[ "${confirm}" = "rollback" ] || fail "aborted"

for svc in ${SERVICES}; do
  log "retagging gml-lms-${svc}:previous -> current"
  docker tag "gml-lms-${svc}:previous" "gml-lms-${svc}:current"
done

log "restarting ${SERVICES}"
# --no-deps so this does not re-run `migrate`: the schema is already where it
# is, and re-running it on a rollback is at best a no-op and at worst confusing.
# shellcheck disable=SC2086
docker compose up -d --no-deps ${SERVICES}

# The SAME defect deploy.sh had: Caddy answers plaintext with a 308, and
# `curl -f` does not fail on a 3xx, so this loop exited 0 the moment Caddy was
# up -- without ever reaching the app. A rollback onto an image that cannot
# start would have reported "rolled back and healthy".
#
#   -L  follow the redirect to HTTPS
#   -k  the redirect lands on 127.0.0.1 while the certificate names $DOMAIN;
#       certificate validity is not what this gate is for
#   grep the body, because /api/health answers 503 with ok:false when the
#       database, storage or migrations are wrong -- and a rollback is most
#       often run precisely when something is wrong
rollback_healthy() {
  curl -fsSLk -m 10 "http://127.0.0.1/api/health" 2>/dev/null | grep -q '"ok":true'
}

log "waiting for health"
elapsed=0
until rollback_healthy; do
  if [ "${elapsed}" -ge 120 ]; then
    echo "[rollback] still unhealthy after 120s — the previous image may not be compatible" >&2
    echo "[rollback] with the CURRENT schema. Check 'docker compose logs app'." >&2
    exit 1
  fi
  sleep 3
  elapsed=$((elapsed + 3))
done

log "rolled back and healthy after ${elapsed}s"
log "the database was NOT changed. Verify the application behaves as expected."
