// Governance test for spec 108 — SM-5 deploy pre-flight.
//
// PARTLY INVERTED. Spec 108's own contribution — refuse to deploy on a stale
// restore drill, before anything starts — is untouched and still asserted. What
// changed is everything the test said about the four steps AFTER the drill,
// because scripts/deploy.sh has been rewritten: the version these assertions
// pinned could not complete on a clean host, and three of the assertions were
// pinning the specific reasons it could not.
//
//   1. It polled http://localhost:3000/api/health. NO SERVICE PUBLISHES PORT
//      3000 — only caddy publishes anything (80/443). The wait could never
//      succeed, so the script exited 1 after 60 seconds on every run. The old
//      "health-wait between boot and migrate" test asserted that loop existed
//      and said nothing about whether the address was reachable.
//   2. It then ran `docker compose exec -T app pnpm --filter @gml/db migrate`,
//      and the old test pinned that command LITERALLY. The app image is a
//      Next.js standalone build: no pnpm, no tsx, no packages/db. That command
//      cannot work in that container, by construction — so the test guaranteed
//      the presence of a line that always failed.
//   3. Migrations already run: the `migrate` service gates `app` through
//      depends_on/service_completed_successfully. Re-running them after the app
//      was already up was redundant AND out of order.
//   4. Its final line printed the literal text ${DOMAIN} (a backslash inside a
//      double-quoted string), so the operator was directed to a placeholder.
//      The old success-message test matched loosely enough not to notice.
//
// New flow: preflight -> build -> migrate on its own (stop on failure, nothing
// serving touched) -> tag :previous -> up -> health THROUGH CADDY -> seed in the
// migrate image -> verify-auth. The assertions below follow that order and additionally
// pin the absence of each defect above, so a revert would be caught.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

/**
 * `#`-comment-stripped view of a shell script. Required for every absence
 * assertion here: deploy.sh's header documents the four defects above by name,
 * so an unstripped search for "localhost:3000" or "placeholder" finds the
 * explanation of the removal rather than the thing removed.
 */
const code = (src) => src.replace(/(^|\s)#.*$/gm, "$1");

const DEPLOY_PATH = "scripts/deploy.sh";
const README_PATH = "README-IT.md";
const MAKEFILE_PATH = "Makefile";
const SPEC_DIR = "specs/108-sm5-deploy-preflight";

test("spec 108: scripts/deploy.sh exists and is non-empty", () => {
  assert.ok(existsSync(resolve(root, DEPLOY_PATH)), `${DEPLOY_PATH} must exist`);
  const src = read(DEPLOY_PATH);
  assert.ok(src.length > 100, "deploy.sh must not be empty");
});

test("spec 108: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 108: deploy.sh starts with the bash shebang", () => {
  const src = read(DEPLOY_PATH);
  // Either the very first line is the shebang, or there's a leading BOM/blank
  // we tolerate via a substring check at the start of the file.
  assert.match(
    src.split(/\r?\n/, 1)[0],
    /^#!\/usr\/bin\/env bash$/,
    "deploy.sh first line must be '#!/usr/bin/env bash'",
  );
});

test("spec 108: deploy.sh declares 'set -euo pipefail'", () => {
  const src = read(DEPLOY_PATH);
  assert.match(
    src,
    /set\s+-euo\s+pipefail/,
    "deploy.sh must declare 'set -euo pipefail' to abort on any failure",
  );
});

test("spec 108: deploy.sh invokes check-restore-drill BEFORE docker compose up", () => {
  const src = read(DEPLOY_PATH);
  const drillIdx = src.indexOf("check-restore-drill.mjs");
  const upIdx = src.indexOf("docker compose up");
  assert.ok(drillIdx >= 0, "deploy.sh must reference scripts/check-restore-drill.mjs");
  assert.ok(upIdx >= 0, "deploy.sh must invoke 'docker compose up'");
  assert.ok(
    drillIdx < upIdx,
    "check-restore-drill.mjs must be called BEFORE 'docker compose up' (SM-5 pre-flight ordering)",
  );
});

test("spec 108: deploy.sh waits on /api/health AFTER the migrate gate, through caddy", () => {
  const src = code(read(DEPLOY_PATH));
  assert.match(src, /curl/, "deploy.sh must curl /api/health for the health-wait");
  assert.match(src, /\/api\/health/, "deploy.sh must reference the /api/health endpoint");

  // The order is inverted from the original assertion, because the migration
  // step moved: `migrate` is a compose service that `app` blocks on, so by the
  // time anything can answer /api/health the migrations have already succeeded.
  // Health is therefore the LAST gate, not a step before migrating.
  //
  // RE-ORDERED again. This required `docker compose up` BEFORE a migrate exit
  // code read back from `compose ps -a` -- the order that took the site down:
  // up's create phase removes the serving app before migrate even runs, and up
  // itself then exits non-zero, so under set -e the check after it never ran.
  // Migrations now run on their own first, and up only once they succeeded
  // (tests/scripts/deploy-flow.test.mjs executes the failing case).
  const upIdx = src.indexOf("docker compose up");
  const migrateGateIdx = src.search(/if ! docker compose run --rm --no-deps migrate; then/);
  const curlIdx = src.search(/until\s+curl|curl[^\n]*HEALTH_URL/);
  assert.ok(upIdx >= 0, "deploy.sh must invoke 'docker compose up'");
  assert.ok(migrateGateIdx >= 0, "deploy.sh must run the migrations on their own and stop when they fail");
  assert.ok(curlIdx >= 0, "deploy.sh must contain a curl-based health-wait loop");
  assert.ok(
    migrateGateIdx < upIdx && upIdx < curlIdx,
    "order must be: migrate (stop on failure) -> docker compose up -> health-wait",
  );

  // The defect that made the old loop unsatisfiable. Nothing publishes 3000.
  assert.ok(
    !/localhost:3000|127\.0\.0\.1:3000/.test(src),
    "the health probe must not target port 3000 — only caddy publishes ports (80/443), " +
      "so polling 3000 could never succeed and timed the deploy out every single run",
  );

  // INVERTED. This used to pin the LITERAL default
  //     HEALTH_URL:-http://127.0.0.1/api/health
  // as "what is actually listening". It is what is listening, and it can never
  // reach the app: docker/Caddyfile has one site block, {$DOMAIN:localhost},
  // so Caddy matches on Host, and Host 127.0.0.1 matches no site. Every deploy
  // timed out at the health step and never seeded an administrator — and this
  // assertion held that address under governance protection, so fixing it
  // turned the suite red. Pinning a literal address is how a URL that cannot
  // work stayed protected; what is pinned now is the PROPERTY: the probe asks
  // for the site Caddy serves (derived from DOMAIN), pinned to this box.
  // tests/scripts/deploy-flow.test.mjs proves it behaviourally.
  assert.ok(
    !/127\.0\.0\.1\/api\/health/.test(src),
    "the probe must not address Caddy by raw loopback IP — Host 127.0.0.1 matches no site block",
  );
  assert.match(
    src,
    /HEALTH_URL="\$\{HEALTH_URL:-https:\/\/\$\{DOMAIN_VALUE\}\/api\/health\}"/,
    "the probe target must be derived from DOMAIN, the name Caddy's site block matches",
  );
  assert.match(
    src,
    /curl[^\n]*--resolve "\$\{DOMAIN_VALUE\}:443:127\.0\.0\.1"[^\n]*"\$\{HEALTH_URL\}"/,
    "the probe must pin DOMAIN to this box (--resolve), so it neither depends on the box's DNS nor leaves it",
  );
  assert.match(
    read("docker/Caddyfile"),
    /^\{\$DOMAIN:localhost\} \{/m,
    "deriving the probe from DOMAIN is only right while DOMAIN is the Caddyfile's site address",
  );
});

test("spec 108: rollback.sh's health verdict can reach the app too", () => {
  // Same defect, worse: rollback.sh hard-coded http://127.0.0.1/api/health with
  // no override, so every rollback ended "still unhealthy after 120s" AFTER
  // the containers had been restarted — a wrong verdict on a rollback that
  // worked. tests/scripts/rollback-sh.test.mjs proves the fix behaviourally.
  const src = code(read("scripts/rollback.sh"));
  assert.ok(!/127\.0\.0\.1\/api\/health/.test(src), "rollback.sh must not probe Caddy by raw loopback IP");
  assert.match(src, /curl[^\n]*--resolve "\$\{DOMAIN_VALUE\}:443:127\.0\.0\.1"[^\n]*"\$\{HEALTH_URL\}"/);
});

test("spec 108: migrations run in the migrate service, and the seed runs in the migrate IMAGE", () => {
  const src = code(read(DEPLOY_PATH));
  const yaml = read("docker-compose.yml");

  // Was: a literal pin on `docker compose exec -T app pnpm --filter @gml/db
  // migrate`. That command could not work — the app image is a Next.js
  // standalone build with no pnpm, no tsx and no packages/db in it. Asserting
  // it kept a guaranteed-failing line under governance protection.
  assert.ok(
    !/docker compose exec[^\n]*\bapp\b[^\n]*migrate/.test(src),
    "deploy.sh must not exec migrations inside the app container — that image has no " +
      "pnpm, no tsx and no packages/db, so the command fails by construction",
  );

  // The ordering guarantee now lives in compose, where it is enforced by the
  // engine rather than by the order of lines in a script.
  assert.match(
    yaml,
    /migrate:\n\s+condition: service_completed_successfully/,
    "app/worker must block on the migrate service completing successfully — that is " +
      "what makes it impossible for the stack to come up against an unmigrated database",
  );

  // Migration failure must be surfaced, not left in the logs -- and must stop
  // the deploy before anything that is serving is touched.
  assert.match(
    src,
    /if ! docker compose run --rm --no-deps migrate; then[\s\S]*?migrations FAILED[\s\S]*?exit 1/,
    "deploy.sh must stop the deploy, saying so, when the migrations fail",
  );

  // The seed still runs, and still after migrations — but in the one image that
  // actually contains pnpm, tsx and packages/db.
  assert.match(
    src,
    /docker compose run[^\n]*migrate[^\n]*seed_all\.ts/,
    "deploy.sh must run seed_all.ts in the migrate image (the only one with pnpm + tsx + packages/db)",
  );
  assert.ok(
    src.search(/if ! docker compose run --rm --no-deps migrate; then/) < src.indexOf("seed_all.ts"),
    "migrations must be confirmed before the seed runs",
  );
});

test("spec 108: deploy.sh emits a final success message with the REAL domain", () => {
  const src = code(read(DEPLOY_PATH));
  // The original assertion (`/\[deploy\][^\n]*(stack is up|done|success)/i`)
  // was satisfied by the old script's last line — which printed the literal
  // characters ${DOMAIN}, because the `$` was backslash-escaped inside a
  // double-quoted string. The operator was told to visit a placeholder. The
  // test matched the word "done" and never looked at what followed it.
  assert.match(
    src,
    /log "done[^\n]*"/,
    "deploy.sh must log a recognisable success message at the bottom",
  );
  assert.match(
    src,
    /log\(\)\s*\{\s*echo "\[deploy\]/,
    "the log helper must carry the [deploy] prefix so cron mail is attributable",
  );
  assert.ok(
    !/\\\$\{DOMAIN\}/.test(src),
    "the final message must not print the literal text ${DOMAIN} — escaping the $ is " +
      "what sent operators to a placeholder URL",
  );
  assert.match(
    src,
    /DOMAIN_VALUE="\$\(grep[^\n]*\.env/,
    "the final message must resolve DOMAIN out of .env so the printed URL is the real one",
  );
});

test("spec 108: deploy.sh leaves a rollback target behind, and rollback.sh exists", () => {
  const src = code(read(DEPLOY_PATH));
  // New. The repository previously had NO rollback procedure at all — not in
  // README-IT.md, not in the deploy script, nowhere. The only recovery posture
  // was the passive one (a failed migration means `app` never starts and the
  // old container keeps serving), which covers a bad migration and nothing
  // else. Re-tagging :current -> :previous before a build is what gives
  // scripts/rollback.sh something to go back to, so the two are pinned together.
  //
  // RE-SHAPED. This pinned `docker tag :current :previous`, unconditional and
  // before the build. Every re-run of the same code -- which the runbook
  // prescribes after a failed health check or a config change -- then moved
  // :previous onto the release just deployed, and rollback.sh restarted the
  // image it was rolling back from. The invariant is: the serving image IDs
  // are recorded BEFORE the build moves :current, and one becomes :previous
  // only when the build produced a different image.
  // tests/scripts/deploy-flow.test.mjs executes both cases.
  const recorded = src.search(/was_current\[\$\{svc\}\]="\$\(docker image inspect --format '\{\{\.Id\}\}' "gml-lms-\$\{svc\}:current"/);
  assert.ok(
    recorded >= 0 && recorded < src.indexOf("docker compose build"),
    "deploy.sh must record the serving image IDs BEFORE the build overwrites :current",
  );
  assert.match(
    src,
    /elif \[ "\$\{was_current\[\$\{svc\}\]\}" != "\$\{built\}" \]; then\s+docker tag "\$\{was_current\[\$\{svc\}\]\}" "gml-lms-\$\{svc\}:previous"/,
    "deploy.sh must move :previous to the serving image only when the build changed it",
  );
  assert.ok(existsSync(resolve(root, "scripts/rollback.sh")), "scripts/rollback.sh must exist");
  assert.match(
    code(read("scripts/rollback.sh")),
    /previous/,
    "rollback.sh must roll back to the :previous tag deploy.sh leaves behind",
  );
});

test("spec 108: README-IT.md step 3 directs operators to ./scripts/deploy.sh (or `make deploy`)", () => {
  const src = read(README_PATH);
  assert.match(
    src,
    /\.\/scripts\/deploy\.sh|make\s+deploy/,
    "README-IT.md must reference ./scripts/deploy.sh or 'make deploy' as the deploy entry point",
  );
});

test("spec 108: README-IT.md preserves the manual docker-compose commands as fallback", () => {
  const src = read(README_PATH);
  // The fallback section must mention both manual primitives so operators can drop down.
  assert.match(
    src,
    /Manual fallback|manual fallback|fallback/i,
    "README-IT.md must label a manual-fallback section",
  );
  assert.match(src, /docker compose up -d/, "README-IT.md fallback must keep 'docker compose up -d'");

  // INVERTED. This required the README to document
  //     docker compose exec app pnpm --filter @gml/db migrate
  // as the manual fallback — the exact command scripts/deploy.sh was rewritten
  // to eliminate, because the app image is a Next.js standalone build with no
  // pnpm, no tsx and no packages/db in it.
  //
  // The assertion did not merely tolerate a broken instruction; it REQUIRED
  // one. As written, the README could never drop the string, so a governance
  // test was actively holding a guaranteed-failing command in the operator
  // runbook.
  //
  // The working fallback runs in the MIGRATE image, which has all three.
  assert.match(
    src,
    /docker compose run[^\n]*migrate/,
    "the manual fallback must run migrations in the migrate image, not the app container",
  );
});

test("spec 108: Makefile exposes a 'deploy:' target that calls scripts/deploy.sh", () => {
  // Makefile is optional per the spec, but if it exists, it MUST wire deploy: → scripts/deploy.sh.
  if (!existsSync(resolve(root, MAKEFILE_PATH))) {
    // Acceptable absence — the README reference is the alternative path.
    // Re-assert the README-IT.md reference to keep the chain unambiguous.
    const readme = read(README_PATH);
    assert.match(
      readme,
      /\.\/scripts\/deploy\.sh/,
      "If Makefile is absent, README-IT.md must reference ./scripts/deploy.sh unambiguously",
    );
    return;
  }
  const mk = read(MAKEFILE_PATH);
  assert.match(mk, /^deploy:/m, "Makefile must declare a 'deploy:' target");
  assert.match(
    mk,
    /scripts\/deploy\.sh/,
    "Makefile 'deploy:' target must invoke scripts/deploy.sh",
  );
});

test("spec 108: deploy.sh has a health-wait timeout (no indefinite hang)", () => {
  const src = read(DEPLOY_PATH);
  // The loop must reference a timeout / deadline guard so a wedged app
  // doesn't keep the operator's terminal hanging forever.
  assert.match(
    src,
    /HEALTH_TIMEOUT_SECONDS|timeout|60/,
    "deploy.sh must enforce a timeout on the /api/health wait loop",
  );
});

test("spec 108: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});

test("spec 108: no stub / TODO / placeholder markers in deploy.sh", () => {
  // Comments stripped. The header now uses the word "placeholder" to explain
  // the ${DOMAIN} defect this rewrite fixed, and an unstripped search would
  // fail the test on the sentence describing the fix. The property being
  // protected is about executable lines, not prose.
  const src = code(read(DEPLOY_PATH));
  assert.ok(!/\bTODO\b/i.test(src), "deploy.sh must not contain TODO markers");
  assert.ok(!/\bFIXME\b/i.test(src), "deploy.sh must not contain FIXME markers");
  assert.ok(!/placeholder/i.test(src), "deploy.sh must not contain 'placeholder' literals");
});
