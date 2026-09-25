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
#   host toolchain + .env checks + SM-5 restore-drill gate -> build
#   -> migrate (nothing serving is touched until it succeeds)
#   -> tag :previous (only what the build changed) -> up
#   -> health via caddy -> seed -> verify auth -> post-deploy smoke
#
# It does NOT run scripts/preflight.sh. That script is the read-only,
# run-it-yourself check before a FIRST deploy (README-deploy.md section 3): it
# fails when ports 80/443 are already bound, which is the normal state of every
# upgrade, so wiring it in here would make a re-deploy impossible.
#
# Idempotent. Safe to re-run: the migration ledgers make a re-run a no-op, and
# the seed never rotates a live account's password or an existing gate.

set -euo pipefail

cd "$(dirname "$0")/.."

# Health is checked THROUGH CADDY, because that is the only thing listening.
# Two signals: the app container's own healthcheck, and an HTTP probe that must
# actually reach the application and read ok:true out of its body.
#
# ── THE PROBE HAS BEEN WRONG TWICE ───────────────────────────────────────────
#
# First it was inert:
#
#     until curl -fsS -o /dev/null http://127.0.0.1/api/health; do ...
#
# and exited 0 on whatever the proxy answered first, having never contacted
# the app. Then it was made strict -- `curl -fsSLk ... | grep -q '"ok":true'`
# -- and kept the same ADDRESS, which can never reach the app at all:
#
#   docker/Caddyfile has exactly one site block, {$DOMAIN:localhost}, so Caddy
#   attaches a Host matcher to it. A request to http://127.0.0.1 carries
#   Host: 127.0.0.1, which matches no site. Whatever Caddy then answers -- the
#   Caddyfile and docker-compose.yml record a 404 for that Host; an earlier
#   version of this comment recorded a 308 to https://127.0.0.1, where there is
#   still no site and no certificate for that name -- it is never the app's
#   JSON. So the strict probe timed out after HEALTH_TIMEOUT_SECONDS on every
#   deploy, blamed the application, and seed, verify-auth and smoke never ran:
#   a fresh host ended with no administrator and nobody able to sign in.
#
# The probe now asks for the site Caddy actually serves, https://$DOMAIN, and
# pins that name to this box with `curl --resolve DOMAIN:443:127.0.0.1` -- the
# technique scripts/verify-tls-local.sh already exercises -- so it neither
# depends on the box's own DNS nor leaves it. tests/scripts/deploy-flow.test.mjs
# runs this whole script against a curl stub that answers the way that Caddy
# does.
#
# DOMAIN as Caddy will see it: Compose gives an exported shell variable
# precedence over .env when it interpolates DOMAIN for the caddy service, so
# this does the same; `localhost` is the Caddyfile's own default.
DOMAIN_VALUE="${DOMAIN:-}"
if [ -z "${DOMAIN_VALUE}" ] && [ -f .env ]; then
  DOMAIN_VALUE="$(grep -E '^DOMAIN=' .env | tail -n 1 | cut -d= -f2- | tr -d '"'"'"' [:cntrl:]' || true)"
fi
DOMAIN_VALUE="${DOMAIN_VALUE:-localhost}"

HEALTH_URL="${HEALTH_URL:-https://${DOMAIN_VALUE}/api/health}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-3}"

# The smoke suite targets the same site. Node's fetch has no --resolve, so this
# one step needs DOMAIN to resolve to this instance from this instance -- the A
# record preflight.sh checks, and the one Caddy needed to obtain a certificate
# at all. Override when that does not hold (split-horizon DNS, a test box).
SMOKE_BASE_URL="${SMOKE_BASE_URL:-https://${DOMAIN_VALUE}}"

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
# defined — nothing after the `exit 0` runs, so `set -u` never reaches it. Nor
# does echoing a value prove a DEFINITION exists: `echo "X=${X:-default}"` in
# here would print happily while the real dereference below still aborts. The
# test therefore also requires a top-level `^HEALTH_…=` assignment in this file.
#
# That assignment check is a SOURCE-PRESENCE test, not a reachability one: an
# `unset` after it, an assignment inside a function nobody calls, or the same
# text inside a heredoc would all satisfy it. It catches the two regressions
# that actually happened here and is not a general guarantee — proving
# reachability would mean running past the health probe, which is the part a
# test must not execute.
#
# OFF MUST MEAN OFF. This used to be `[ -n "${DEPLOY_DRY_RUN:-}" ]`, under which
# DEPLOY_DRY_RUN=0 and =false are both TRUE — so an operator writing either to
# mean "not a dry run" would get a no-op that printed three lines and exited 0,
# and `git pull && ./scripts/deploy.sh` would report success having deployed
# nothing. The seed scripts in packages/db/src/scripts/ already use the strict
# `=== "true"` form; this matches them, and the banner goes to stderr so a dry
# run can never be mistaken for a deploy. Matching is case-insensitive because
# FALSE and Off are the same intent as false and off.
case "$(printf %s "${DEPLOY_DRY_RUN:-}" | tr '[:upper:]' '[:lower:]')" in
  ""|0|false|no|off)
    # Clear the toolchain flag too. It is set only by the arm below, but it is
    # read later as `${DEPLOY_DRY_RUN_TOOLCHAIN:-}`, so an operator who exported
    # it directly would otherwise get the same silent exit-0 no-op that the
    # strict parsing above exists to prevent.
    DEPLOY_DRY_RUN_TOOLCHAIN=
    ;;
  toolchain)
    # Host-toolchain check only: runs the loop below, then stops. Lets the test
    # drive it with a narrowed PATH without needing docker to be installed.
    DEPLOY_DRY_RUN_TOOLCHAIN=1
    ;;
  *)
    echo "[deploy] DRY RUN — configuration only. NOTHING WAS DEPLOYED." >&2
    echo "DOMAIN_VALUE=${DOMAIN_VALUE}"
    echo "HEALTH_URL=${HEALTH_URL}"
    echo "HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS}"
    echo "HEALTH_INTERVAL_SECONDS=${HEALTH_INTERVAL_SECONDS}"
    echo "SMOKE_BASE_URL=${SMOKE_BASE_URL}"
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
# All four become a named blocker here instead.
#
# The failure messages point at README-deploy.md section 2.5, "Prepare the
# instance", which installs every one of them with copy-pasteable commands.
# (An earlier version of these messages pointed at a 2.5 that had not been
# written yet; tests/governance/test_180_deploy_runbook.test.mjs now requires
# the section to exist and to install what this loop checks.)
#
# `docker` alone does not prove Compose v2 is present, and `docker compose
# build` below is the first thing that would fail on it, so probe the plugin.
for cmd in docker node pnpm curl; do
  command -v "${cmd}" >/dev/null 2>&1 \
    || fail "${cmd} is not installed on this host — see README-deploy.md section 2.5, 'Prepare the instance'"
done
docker compose version >/dev/null 2>&1 \
  || fail "the Docker Compose v2 plugin is not available (\`docker compose version\` failed) — see README-deploy.md section 2.5, 'Prepare the instance'"

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
           NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY; do
  grep -qE "^${var}=.+" .env || missing="${missing} ${var}"
done
[ -z "${missing}" ] || fail "these variables are unset or empty in .env:${missing}"

# WhatsApp is optional. The webhook refuses every request while
# WHATSAPP_APP_SECRET is unset (it fails closed), so requiring it here added no
# protection and made an integration the programme switches on later a
# prerequisite for running the LMS at all. Say so instead of failing.
if ! grep -qE "^WHATSAPP_APP_SECRET=.+" .env; then
  log "WhatsApp ingest is OFF: WHATSAPP_APP_SECRET is not set, so the webhook refuses all traffic. Direct upload is unaffected. To switch it on, set the WHATSAPP_* variables in .env (see .env.example) and re-run this script."
fi

# SM-5: refuse to deploy on a stale or failed restore drill.
#
# THE GATE HAD NEVER RUN. check-restore-drill.mjs self-skips unless
# NODE_ENV=production, and this script never set NODE_ENV or sourced .env --
# so on the production box it printed "non-production env -- skipped" on every
# deploy, and a month of missing backups was exactly as invisible as SM-5
# exists to prevent. The stack this deploys is production by construction
# (docker-compose.yml pins NODE_ENV=production for app and worker), so the
# gate arms unless the operator deliberately exports another NODE_ENV.
#
# THE FIRST DEPLOY ON A HOST IS THE EXCEPTION. Before it there is nothing to
# back up and no drill can have passed, so an armed gate would make a fresh
# instance undeployable.
#
# THE SIGNAL IS A MARKER, NOT THE IMAGE. This used to test for the image
# gml-lms-app:current, meaning "this host has completed a build". But
# `docker compose build` below creates that image BEFORE migrate, health and
# seed -- so a first deploy that failed part-way (at health, the step most
# likely to fail on a fresh host, while DNS or the certificate is not ready)
# left the host looking deployed. The re-run was refused for want of a drill;
# the drill could not pass, because only the seed creates a user row to
# restore; and every deploy after that was refused the same way. A deadlock
# with no documented way out, on the step IT is most likely to hit first.
#
# DEPLOYED_MARKER is written only after seed AND verify-auth succeed (step 5):
# the point after which a backup can contain users and a drill can pass.
# workspace/ is gitignored, so `git clean -fdX` removes the marker -- the gate
# then disarms for one deploy, which fails OPEN rather than locking the host.
DEPLOYED_MARKER="workspace/.deploy-completed"
if [ -f "${DEPLOYED_MARKER}" ]; then
  log "restore-drill preflight (SM-5)"
  NODE_ENV="${NODE_ENV:-production}" node scripts/check-restore-drill.mjs
else
  log "FIRST DEPLOY ON THIS HOST (no ${DEPLOYED_MARKER}): the SM-5 restore-drill gate is not armed yet -- nothing can have been backed up."
  log "  Before the NEXT deploy run:  bash scripts/backup.sh && bash scripts/restore.sh   (README-deploy.md section 7)."
  log "  From then on a deploy is refused without a passing drill less than 30 days old."
  # The seed creates the first administrator only from these two, and
  # verify-auth fails the deploy when no active super_admin exists -- say so
  # now rather than after the build.
  if ! grep -qE '^SUPER_ADMIN_EMAIL=.+' .env || ! grep -qE '^SUPER_ADMIN_INITIAL_PASSWORD=.+' .env; then
    log "WARNING: SUPER_ADMIN_EMAIL and SUPER_ADMIN_INITIAL_PASSWORD are not both set in .env. On a database with no administrator yet the seed creates NONE, verify-auth then fails, and this deploy stops before marking the host deployed. Set both unless this database already has an active super_admin."
  fi
fi

# ── 1. Build ─────────────────────────────────────────────────────────────────
# scripts/rollback.sh needs a ':previous' to go back to -- without one a
# rollback has no target, which is how the repository ended up with no rollback
# procedure at all. So note, BY IMAGE ID, what :current is before the build
# moves the tag; :previous is moved from it once migrations have succeeded
# (step 2).
#
# :previous MOVES ONLY FOR AN IMAGE THE BUILD ACTUALLY CHANGED. It used to be
# retagged from :current unconditionally, first thing, on every run -- and the
# runbook says to re-run this script freely: after a failed health check, after
# a config change. Each re-run of the SAME code tagged the release it had just
# deployed as :previous, the release before it lost its last tag, and
# rollback.sh then "rolled back" to the very image it was rolling back from.
declare -A was_current=()
for svc in app worker migrate; do
  was_current[${svc}]="$(docker image inspect --format '{{.Id}}' "gml-lms-${svc}:current" 2>/dev/null || true)"
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

# ── 2. Migrate, then up ──────────────────────────────────────────────────────
# Migrations run BEFORE anything that is serving is touched.
#
# This used to be `docker compose up -d` alone, trusting migrate's depends_on
# to keep the old app serving if a migration failed. Compose does not work that
# way: its create phase recreates every service whose image changed -- stopping
# and removing the old container -- and only its start phase waits for migrate
# to complete. So a failing migration left NO app (Caddy answering 502 for the
# whole site), every deploy had a 502 window of migrate's runtime plus app
# start, and `up` itself exits non-zero then -- so under `set -e` the script
# died on that line, and the "migrations FAILED ... the previous app container
# is still serving" branch after it could never run, and would not have been
# true if it had.
#
# A one-off migrate first makes that promise true. `up` then re-runs migrate as
# the no-op its two ledgers make it, and only then recreates app and worker.
log "applying migrations (nothing that is serving is touched until they succeed)"
if ! docker compose run --rm --no-deps migrate; then
  # Put :current back on what is still serving, so a later `docker compose up`
  # cannot start the images whose migration just failed, and the next deploy
  # compares its build with the release that is really running. :previous has
  # not moved yet (below), so the rollback target is untouched too.
  for svc in app worker migrate; do
    if [ -n "${was_current[${svc}]}" ]; then
      docker tag "${was_current[${svc}]}" "gml-lms-${svc}:current"
    fi
  done
  echo "[deploy] migrations FAILED (their output is above). Nothing was restarted: the previous containers are still serving." >&2
  echo "[deploy] Fix the migration and re-run this script." >&2
  exit 1
fi
log "migrations applied"

# Only now, with the new release about to replace the serving one, does the
# serving one become :previous (see step 1).
for svc in app worker; do
  built="$(docker image inspect --format '{{.Id}}' "gml-lms-${svc}:current" 2>/dev/null || true)"
  if [ -z "${was_current[${svc}]}" ]; then
    log "gml-lms-${svc}: first build on this host -- no :previous to keep yet"
  elif [ "${was_current[${svc}]}" != "${built}" ]; then
    docker tag "${was_current[${svc}]}" "gml-lms-${svc}:previous"
    log "tagged the release that was serving as gml-lms-${svc}:previous"
  else
    log "gml-lms-${svc}: the build is unchanged -- :previous left where it was"
  fi
done

log "starting stack"
if ! docker compose up -d --remove-orphans; then
  echo "[deploy] 'docker compose up' failed. Container state and recent logs:" >&2
  docker compose ps -a >&2 || true
  docker compose logs --no-color --tail 40 migrate app worker >&2 || true
  exit 1
fi

# ── 3. Health ────────────────────────────────────────────────────────────────
# The app container's own healthcheck verdict: healthy | unhealthy | starting.
app_container_health() {
  docker compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null     | awk '$1=="app"{print $2}' | head -1
}

# Reaches the APPLICATION and reads its verdict, rather than whatever the proxy
# says first.
#
#   --resolve  send the request to this box's Caddy under the site name Caddy
#              serves ($DOMAIN), so its Host matches the one site block. See
#              the note beside HEALTH_URL above for why 127.0.0.1 never could.
#   -k         the certificate is for $DOMAIN and, on a first deploy, may be
#              seconds old; certificate validity is not what this check is
#              for (scripts/verify-tls-local.sh and any browser cover that).
#              What is being checked here is the application.
#   grep the body, because /api/health answers 503 with ok:false when the
#              database, storage or migrations are not right, and a status
#              code alone would not distinguish "app is up" from "app is up
#              and working".
app_http_healthy() {
  curl -fsSk -m 10 --resolve "${DOMAIN_VALUE}:443:127.0.0.1" "${HEALTH_URL}" 2>/dev/null | grep -q '"ok":true'
}

log "waiting for health at ${HEALTH_URL} via this box's Caddy (timeout ${HEALTH_TIMEOUT_SECONDS}s)"
elapsed=0
until app_http_healthy; do
  if [ "${elapsed}" -ge "${HEALTH_TIMEOUT_SECONDS}" ]; then
    echo "[deploy] not healthy after ${HEALTH_TIMEOUT_SECONDS}s." >&2
    echo "[deploy] /api/health returns 503 until db, storage AND migrations all pass." >&2
    echo "[deploy] If there is no body at all, Caddy may have no certificate for ${DOMAIN_VALUE} yet" >&2
    echo "[deploy] (the A record does not point here, or port 80 is blocked): see the caddy log below." >&2
    echo "[deploy] app container health: $(app_container_health)" >&2
    echo "[deploy] last /api/health body:" >&2
    curl -sk -m 10 --resolve "${DOMAIN_VALUE}:443:127.0.0.1" "${HEALTH_URL}" >&2 || true
    echo >&2
    docker compose logs --no-color --tail 40 app >&2
    docker compose logs --no-color --tail 20 caddy >&2
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
docker compose run --rm --no-deps migrate pnpm exec tsx scripts/verify-auth.mjs

# Seed and verify-auth have both succeeded: this host now holds data a backup
# can capture and a restore drill can check, so from the next deploy on the
# SM-5 gate is armed. Written HERE and nowhere earlier -- see the gate above.
mkdir -p workspace
date -u +%Y-%m-%dT%H:%M:%SZ > "${DEPLOYED_MARKER}"
log "marked this host as deployed (${DEPLOYED_MARKER}); the next deploy requires a passing restore drill"

# Reclaim what the builds leave behind. Every deploy builds, and nothing ever
# removed the results: each release's old images went dangling at the next
# deploy, and the build cache (pnpm install layers, the next build output) grew
# without bound -- on the root volume unless README-deploy.md 2.5's data-root
# step was done, where a full disk takes Docker, the next deploy and the next
# backup down together. Only now, with the new release healthy and verified:
#   image prune    DANGLING images only. :current and :previous are tagged and
#                  survive, so the rollback target is never removed.
#   builder prune  build cache nobody has used for a week; recent layers stay,
#                  so the next build is still incremental.
# Failure to prune is not a failed deploy.
log "reclaiming disk: dangling images, and build cache unused for 7 days"
docker image prune -f >/dev/null || log "WARNING: docker image prune failed -- continuing"
docker builder prune -f --filter until=168h >/dev/null || log "WARNING: docker builder prune failed -- continuing"

# ── 6. Smoke ─────────────────────────────────────────────────────────────────
# Drives the deployment that was just made, over real HTTP, through Caddy. It
# FAILS rather than skips when it cannot reach the target — this suite used to
# skip itself on an unreachable app AND be run with `|| true`, so it was
# structurally incapable of failing and reported green whether the deploy had
# worked or not.
#
# It used to target http://127.0.0.1 -- the same Host that matches no Caddy
# site -- so it could not have passed even had the health step let it run.
log "post-deploy smoke check against ${SMOKE_BASE_URL}"
if ! SMOKE_BASE_URL="${SMOKE_BASE_URL}" pnpm test:smoke; then
  echo "[deploy] post-deploy smoke FAILED against ${SMOKE_BASE_URL}." >&2
  echo "[deploy] The stack IS running: health passed and seed and verify-auth completed." >&2
  echo "[deploy] This is a failed acceptance check, not a failed rollout -- read the failures above." >&2
  echo "[deploy] If every test failed to connect, ${DOMAIN_VALUE} does not resolve to this instance" >&2
  echo "[deploy] from this instance; set SMOKE_BASE_URL and re-run 'pnpm test:smoke'." >&2
  exit 1
fi

log "done. Sign in at https://${DOMAIN_VALUE}/"
