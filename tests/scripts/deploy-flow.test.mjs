// deploy.sh, run END TO END — against stubs, never against a real host.
//
// ── WHY THIS IS SAFE WHEN deploy-sh.test.mjs WARNS SO HARD ───────────────────
//
// deploy-sh.test.mjs never runs past deploy.sh's `.env` gate, because its
// PATH is the inherited one and a real docker could be on it. This file runs
// the WHOLE script, and is safe for a different, structural reason (see
// _sandbox.mjs): the PATH contains only the sandbox's bin/, where docker,
// node, pnpm and curl are logging stubs and no directory holding the real
// ones is present at all. The harness proves that before every run —
// `assertContained()` refuses to start if any of those names resolves outside
// the sandbox. The script is a copy rooted in a temp directory whose .env is
// fake; nothing here can build an image, start a container or reach a host.
//
// ── WHAT IT PINS ─────────────────────────────────────────────────────────────
//
// 1. THE HEALTH PROBE MUST BE ABLE TO REACH THE APP. It curled
//    http://127.0.0.1/api/health. docker/Caddyfile has one site block,
//    {$DOMAIN:localhost}, so Caddy matches on Host, and Host 127.0.0.1 matches
//    no site: the probe could never read the app's `"ok":true`, every deploy
//    timed out at the health step, and seed, verify-auth and smoke never ran.
//    The curl stub below answers like that Caddy does.
// 2. The smoke step targets the same site, not 127.0.0.1.
// 3. The SM-5 gate is ARMED on a host that has deployed before (it self-skips
//    unless NODE_ENV=production, and deploy.sh never set it), and is not a
//    chicken-and-egg blocker on the very first deploy, when no backup can
//    exist yet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { caddyCurl, makeSandbox, root } from "./_sandbox.mjs";

const sb_src = () => readFileSync(resolve(root, "scripts/deploy.sh"), "utf8");

const DOMAIN = "lms.example.test";

const ENV_FILE = `DOMAIN=${DOMAIN}
ACME_EMAIL=ops@example.test
DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub
NEXT_PUBLIC_SUPABASE_URL=https://abcdefgh.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=stub
SUPABASE_SECRET_KEY=stub
WHATSAPP_APP_SECRET=stub
`;

const DOCKER = `
case "$*" in
  "image inspect gml-lms-app:current"|"image inspect gml-lms-worker:current")
    [ -n "\${FAKE_FIRST_DEPLOY:-}" ] && exit 1
    exit 0 ;;
  "compose ps -a --format"*) echo "migrate 0" ;;
  "compose ps --format"*) echo "app healthy" ;;
  *verify-auth.mjs*) exit "\${FAKE_VERIFY_AUTH_EXIT:-0}" ;;
esac
exit 0
`;

const NODE = `
printf 'node-env NODE_ENV=%s\\n' "\${NODE_ENV:-}" >> "$SANDBOX_LOG"
[ -n "\${FAKE_DRILL_REFUSES:-}" ] && { echo "[SM-5] restore drill is 45 days old" >&2; exit 1; }
exit 0
`;

const PNPM = `
printf 'pnpm-env SMOKE_BASE_URL=%s\\n' "\${SMOKE_BASE_URL:-}" >> "$SANDBOX_LOG"
exit 0
`;

function deploySandbox({ healthy = true, deployedBefore = true } = {}) {
  const sb = makeSandbox({ files: ["scripts/deploy.sh"], prefix: "gml-deploy-" });
  sb.write(".env", ENV_FILE);
  // A host that has completed a deploy carries the marker deploy.sh writes after
  // seed and verify-auth. It is what arms the SM-5 gate -- not the image.
  if (deployedBefore) sb.write("workspace/.deploy-completed", "2026-09-01T00:00:00Z");
  sb.stub("docker", DOCKER);
  sb.stub("node", NODE);
  sb.stub("pnpm", PNPM);
  sb.stub("curl", caddyCurl(DOMAIN, { healthy }));
  return sb;
}

const FAST = { HEALTH_TIMEOUT_SECONDS: "4", HEALTH_INTERVAL_SECONDS: "1" };

test("a deploy onto a healthy stack gets past health and runs seed, verify-auth and smoke", () => {
  const sb = deploySandbox();
  try {
    const r = sb.run("scripts/deploy.sh", { env: FAST });
    const calls = sb.invocations();
    assert.equal(
      r.status,
      0,
      `deploy.sh did not complete against a healthy stack.\nstderr:\n${r.stderr}\ninvoked:\n${calls.join("\n")}`,
    );
    assert.match(r.stdout, new RegExp(`done\\. Sign in at https://${DOMAIN.replaceAll(".", "\\.")}/`));

    const probe = calls.find((l) => /^curl .*\/api\/health/.test(l));
    assert.ok(probe, "the health probe must curl /api/health");
    assert.ok(
      probe.includes(`--resolve ${DOMAIN}:443:127.0.0.1`) && probe.includes(`https://${DOMAIN}/api/health`),
      `the probe must carry a Host that Caddy's site block matches, pinned to this box: ${probe}`,
    );
    assert.ok(
      calls.some((l) => /^docker compose run --rm --no-deps migrate pnpm exec tsx src\/scripts\/seed_all\.ts/.test(l)),
      "the seed must run once health passes",
    );
    assert.ok(calls.some((l) => /verify-auth\.mjs/.test(l)), "verify-auth must run");
    assert.ok(calls.includes("pnpm test:smoke"), "the smoke suite must run");
    assert.ok(
      calls.includes(`pnpm-env SMOKE_BASE_URL=https://${DOMAIN}`),
      `the smoke suite must target the site Caddy serves, not 127.0.0.1:\n${calls.join("\n")}`,
    );
  } finally {
    sb.cleanup();
  }
});

test("an unhealthy app still fails the deploy at the health step", () => {
  // The fix must not make the probe pass vacuously.
  const sb = deploySandbox({ healthy: false });
  try {
    const r = sb.run("scripts/deploy.sh", { env: FAST });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not healthy after 4s/);
    assert.ok(
      !sb.invocations().some((l) => /seed_all\.ts/.test(l)),
      "nothing may be seeded onto an unhealthy stack",
    );
  } finally {
    sb.cleanup();
  }
});

test("the SM-5 restore-drill gate is ARMED on a host that has deployed before", () => {
  const sb = deploySandbox();
  try {
    const r = sb.run("scripts/deploy.sh", { env: FAST });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      sb.invocations().includes("node-env NODE_ENV=production"),
      "check-restore-drill.mjs self-skips unless NODE_ENV=production, and deploy.sh never set it — " +
        `so the gate had never once run on a deploy.\n${sb.invocations().join("\n")}`,
    );
  } finally {
    sb.cleanup();
  }
});

test("a refused restore drill stops the deploy before anything is built", () => {
  const sb = deploySandbox();
  try {
    const r = sb.run("scripts/deploy.sh", { env: { ...FAST, FAKE_DRILL_REFUSES: "1" } });
    assert.notEqual(r.status, 0);
    assert.ok(
      !sb.invocations().some((l) => /^docker (tag|compose build|compose up)/.test(l)),
      `a stale drill must block the deploy BEFORE images are touched:\n${sb.invocations().join("\n")}`,
    );
  } finally {
    sb.cleanup();
  }
});

test("the first deploy on a host is not blocked by a drill that cannot exist yet", () => {
  // There is nothing to back up before the first deploy, so a gate that
  // demanded a drill here would make a fresh EC2 host undeployable.
  const sb = deploySandbox({ deployedBefore: false });
  try {
    const r = sb.run("scripts/deploy.sh", { env: { ...FAST, FAKE_FIRST_DEPLOY: "1", FAKE_DRILL_REFUSES: "1" } });
    assert.equal(r.status, 0, `the first deploy was blocked:\n${r.stderr}`);
    assert.match(
      `${r.stdout}${r.stderr}`,
      /first deploy[\s\S]*restore\.sh/i,
      "the skip must be loud and say what to run before the next deploy",
    );
  } finally {
    sb.cleanup();
  }
});

test("DOMAIN exported in the shell wins over .env, exactly as Compose resolves it for Caddy", () => {
  const sb = makeSandbox({ files: ["scripts/deploy.sh"], prefix: "gml-deploy-" });
  try {
    sb.write(".env", ENV_FILE);
    sb.stub("docker", DOCKER);
    sb.stub("node", NODE);
    sb.stub("pnpm", PNPM);
    sb.stub("curl", caddyCurl("override.example.test"));
    const r = sb.run("scripts/deploy.sh", { env: { ...FAST, DOMAIN: "override.example.test" } });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    sb.cleanup();
  }
});

// ── The first-deploy deadlock (review of fix/deploy-handover) ────────────────
//
// The SM-5 gate used to arm whenever the image gml-lms-app:current existed.
// `docker compose build` creates that image BEFORE migrate, health and seed,
// so a first deploy that failed part-way -- at health, the step most likely to
// fail on a fresh host (DNS or certificate not ready) -- left the host looking
// as if it had deployed before. The re-run was refused for want of a restore
// drill; the drill could not pass, because only the seed creates a user row to
// restore; and every deploy after that was refused the same way. On main the
// gate self-skipped, so this could not happen before the fix that armed it.
//
// The signal is now a marker written only after seed and verify-auth succeed:
// the point after which a backup can contain users and a drill can pass.

const MARKER = "workspace/.deploy-completed";

test("a first deploy that fails at health does NOT lock the host out of re-running", () => {
  const sb = deploySandbox({ healthy: false, deployedBefore: false });
  try {
    const first = sb.run("scripts/deploy.sh", { env: FAST });
    assert.notEqual(first.status, 0, "the unhealthy first deploy should fail at health");
    assert.ok(!sb.exists(MARKER), "a deploy that never seeded must not mark the host as deployed");

    // The operator fixes DNS and runs it again. No drill can exist yet -- the
    // seed never ran, so there is no user to back up -- and the drill stub is
    // set to refuse, exactly as the real one would. The gate must not be armed.
    sb.stub("curl", caddyCurl(DOMAIN, { healthy: true }));
    const second = sb.run("scripts/deploy.sh", { env: { ...FAST, FAKE_DRILL_REFUSES: "1" } });
    assert.equal(
      second.status,
      0,
      `the re-run after a failed first deploy was refused -- the host is locked out:\n${second.stderr}`,
    );
    assert.ok(sb.exists(MARKER), "a deploy that seeded and verified auth must mark the host");
  } finally {
    sb.cleanup();
  }
});

test("once a deploy completes, the next one arms the restore-drill gate", () => {
  const sb = deploySandbox({ deployedBefore: false });
  try {
    const first = sb.run("scripts/deploy.sh", { env: FAST });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(sb.exists(MARKER), "a completed deploy must leave the marker");

    // The invocation log is cumulative across runs, so look only at what the
    // SECOND run did -- the first one built, legitimately.
    const before = sb.invocations().length;
    const second = sb.run("scripts/deploy.sh", { env: { ...FAST, FAKE_DRILL_REFUSES: "1" } });
    const during = sb.invocations().slice(before);
    assert.notEqual(second.status, 0, "a stale drill must block a deploy on a host that has deployed");
    assert.ok(
      !during.some((l) => /^docker (tag|compose build|compose up)/.test(l)),
      `the gate must refuse BEFORE anything is built or tagged:\n${during.join("\n")}`,
    );
  } finally {
    sb.cleanup();
  }
});

test("the marker is written after verify-auth, never before seed", () => {
  // The order is the whole fix: write it earlier and the deadlock is back.
  const src = sb_src();
  const seed = src.indexOf("seed_all.ts");
  const verify = src.indexOf("scripts/verify-auth.mjs");
  const mark = src.indexOf('> "${DEPLOYED_MARKER}"');
  assert.ok(seed > 0 && verify > 0 && mark > 0, "seed, verify-auth and the marker write must all exist");
  assert.ok(mark > verify && verify > seed, "the marker must be written after seed AND verify-auth");
});

// ── WhatsApp is optional ─────────────────────────────────────────────────────

test("a deploy without WhatsApp configured completes, and says WhatsApp ingest is off", () => {
  const sb = deploySandbox();
  try {
    sb.write(".env", ENV_FILE.replace(/^WHATSAPP_APP_SECRET=.*\n/m, ""));
    const r = sb.run("scripts/deploy.sh", { env: FAST });
    assert.equal(r.status, 0, `WhatsApp is switched on later; it must not block a deploy.\nstderr:\n${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /WhatsApp ingest is OFF/i, "the operator must be told, not left to discover it");
  } finally {
    sb.cleanup();
  }
});

// ── The image store: what :current and :previous actually name ──────────────
//
// The stubs above answer `image inspect` with a bare exit code. These need the
// tags to MEAN something, so this docker keeps a small store in the sandbox
// ($SANDBOX_DIR/images, one file per tag holding an image id):
//
//   compose build             every service's :current -> sha256:<FAKE_BUILD>-<svc>
//   tag SRC DST               DST -> SRC's id (SRC may itself be an id)
//   image inspect --format {{.Id}} REF    REF's id, or exit 1 if REF is untagged
//   compose build             ... unless FAKE_BUILD_FAIL is set: then only app
//                             finishes and is tagged, and the build exits 1 --
//                             what real Compose does when one target fails
//   image rm REF              untags REF
//   compose run --rm --no-deps migrate    exits FAKE_MIGRATE_EXIT (default 0)
//   compose up ...            exits FAKE_UP_EXIT (default 0) -- or 1 when the
//                             migration fails, as the real one does after it
//                             has already recreated app and worker
//   compose ps --status running -q app    a container id, or nothing when
//                             FAKE_NOTHING_RUNNING is set (no stack is up)

const STORE_DOCKER = `
store="$SANDBOX_DIR/images"; mkdir -p "$store"
tagfile() { printf '%s/%s' "$store" "$(printf %s "$1" | tr ':/' '__')"; }
case "$*" in
  "image inspect --format {{.Id}} "*)
    f="$(tagfile "$5")"; [ -f "$f" ] || exit 1; cat "$f"; echo; exit 0 ;;
  "tag "*)
    if [ -f "$(tagfile "$2")" ]; then id="$(cat "$(tagfile "$2")")"; else id="$2"; fi
    printf '%s' "$id" > "$(tagfile "$3")"; exit 0 ;;
  "image rm "*) rm -f "$(tagfile "$3")"; exit 0 ;;
  "compose build"*)
    if [ -n "\${FAKE_BUILD_FAIL:-}" ]; then
      printf '%s' "sha256:\${FAKE_BUILD:-v1}-app" > "$(tagfile "gml-lms-app:current")"
      echo "target worker: failed to solve: process did not complete successfully: exit code: 100" >&2
      exit 1
    fi
    for s in app worker migrate; do printf '%s' "sha256:\${FAKE_BUILD:-v1}-$s" > "$(tagfile "gml-lms-$s:current")"; done
    exit 0 ;;
  "compose run --rm --no-deps migrate") exit "\${FAKE_MIGRATE_EXIT:-0}" ;;
  "compose up"*) [ "\${FAKE_MIGRATE_EXIT:-0}" = 0 ] || exit 1; exit "\${FAKE_UP_EXIT:-0}" ;;
  "compose ps --status running -q app") [ -n "\${FAKE_NOTHING_RUNNING:-}" ] || echo "0123456789ab" ;;
  "compose ps --format"*) echo "app healthy" ;;
esac
exit 0
`;

/** A host that has deployed before, serving `serving` with `previous` behind it. */
function storeSandbox({ serving = "v1", previous = "v0", healthy = true, deployedBefore = true } = {}) {
  const sb = makeSandbox({ files: ["scripts/deploy.sh"], prefix: "gml-deploy-" });
  sb.write(".env", ENV_FILE);
  if (deployedBefore) sb.write("workspace/.deploy-completed", "2026-09-01T00:00:00Z");
  for (const svc of ["app", "worker", "migrate"]) {
    if (serving) sb.write(`images/gml-lms-${svc}_current`, `sha256:${serving}-${svc}`);
    if (previous && svc !== "migrate") sb.write(`images/gml-lms-${svc}_previous`, `sha256:${previous}-${svc}`);
  }
  sb.stub("docker", STORE_DOCKER);
  sb.stub("node", NODE);
  sb.stub("pnpm", PNPM);
  sb.stub("curl", caddyCurl(DOMAIN, { healthy }));
  return sb;
}

const imageId = (sb, ref) => (sb.exists(`images/${ref.replace(/[:/]/g, "_")}`) ? sb.read(`images/${ref.replace(/[:/]/g, "_")}`) : null);

// A spawn allowance for machines where every stubbed process costs a second.
const SLOW = 240_000;

test("re-running deploy.sh on unchanged code keeps :previous on the release before it", () => {
  // v1 is serving. v2 is deployed and fails at health; the runbook says to
  // re-run deploy.sh. The re-run builds the same v2.
  const sb = storeSandbox({ serving: "v1", previous: "v0", healthy: false });
  try {
    const env = { HEALTH_TIMEOUT_SECONDS: "0", HEALTH_INTERVAL_SECONDS: "1", FAKE_BUILD: "v2" };
    const first = sb.run("scripts/deploy.sh", { env, timeout: SLOW });
    assert.notEqual(first.status, 0, "the v2 deploy is meant to fail at health");
    assert.equal(imageId(sb, "gml-lms-app:current"), "sha256:v2-app");
    assert.equal(imageId(sb, "gml-lms-app:previous"), "sha256:v1-app", "after the v2 build, :previous is v1");

    const second = sb.run("scripts/deploy.sh", { env, timeout: SLOW });
    assert.notEqual(second.status, 0);
    for (const svc of ["app", "worker"]) {
      assert.equal(
        imageId(sb, `gml-lms-${svc}:previous`),
        `sha256:v1-${svc}`,
        `re-running deploy.sh on the same code moved gml-lms-${svc}:previous onto the release it had just ` +
          `deployed, so rollback.sh would restart the broken one. :previous must move only when the build ` +
          `produced a different image.\n${second.stdout}${second.stderr}`,
      );
    }
  } finally {
    sb.cleanup();
  }
});

test("a build that changed the image moves :previous to what was serving", () => {
  const sb = storeSandbox({ serving: "v1", previous: "v0" });
  try {
    const r = sb.run("scripts/deploy.sh", { env: { ...FAST, FAKE_BUILD: "v2" }, timeout: SLOW });
    assert.equal(r.status, 0, r.stderr);
    for (const svc of ["app", "worker"]) {
      assert.equal(imageId(sb, `gml-lms-${svc}:previous`), `sha256:v1-${svc}`);
      assert.equal(imageId(sb, `gml-lms-${svc}:current`), `sha256:v2-${svc}`);
    }
  } finally {
    sb.cleanup();
  }
});

// ── A first deploy that creates no administrator ─────────────────────────────
//
// SUPER_ADMIN_* are not REQUIRED, and with them empty the seed skips the
// bootstrap and succeeds. deploy.sh then wrote the marker that arms SM-5 and
// printed "done. Sign in at ..." on a system with no account at all -- whose
// restore drill could never pass, so the gate refused the re-deploy that would
// have created one. verify-auth now fails that state
// (tests/behaviour/seed-bootstrap.test.ts); these pin what deploy.sh does.

test("a first deploy with SUPER_ADMIN_* unset says so before it builds anything", () => {
  const sb = deploySandbox({ deployedBefore: false });
  try {
    const r = sb.run("scripts/deploy.sh", { env: FAST });
    const out = `${r.stdout}${r.stderr}`;
    const warned = out.search(/SUPER_ADMIN_EMAIL and SUPER_ADMIN_INITIAL_PASSWORD are not both set/);
    assert.ok(warned >= 0, `the operator must be told no administrator will be created:\n${out}`);
    assert.ok(warned < out.indexOf("building images"), "and told before the build, not after it");
  } finally {
    sb.cleanup();
  }
});

test("a first deploy with SUPER_ADMIN_* set does not warn", () => {
  const sb = deploySandbox({ deployedBefore: false });
  try {
    sb.write(".env", `${ENV_FILE}SUPER_ADMIN_EMAIL=it@example.test\nSUPER_ADMIN_INITIAL_PASSWORD=Initial-Pass-4821\n`);
    const r = sb.run("scripts/deploy.sh", { env: FAST });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /not both set/);
  } finally {
    sb.cleanup();
  }
});

test("when verify-auth fails, the host is not marked deployed and no success is claimed", () => {
  const sb = deploySandbox({ deployedBefore: false });
  try {
    const r = sb.run("scripts/deploy.sh", { env: { ...FAST, FAKE_VERIFY_AUTH_EXIT: "1" } });
    assert.notEqual(r.status, 0);
    assert.ok(!sb.exists(MARKER), "the SM-5 gate must not be armed on a deploy that failed verification");
    assert.doesNotMatch(r.stdout, /done\. Sign in/);
  } finally {
    sb.cleanup();
  }
});

// ── A failed migration must leave the serving release alone ─────────────────
//
// `docker compose up -d` recreates every service whose image changed in its
// CREATE phase -- stopping and removing the old container -- and waits on
// migrate's service_completed_successfully only in its START phase. So with
// `up` as the first step, a failing migration left no app at all and the whole
// site answered 502. And `up` exits non-zero in that case, so under set -e the
// script died on that line: its "migrations FAILED ... still serving" branch
// never ran. The stub above said "migrate 0" to `compose ps -a`, so neither
// path had ever executed.

test("a failed migration restarts nothing: the release that was serving keeps serving", () => {
  const sb = storeSandbox({ serving: "v1", previous: "v0" });
  try {
    const r = sb.run("scripts/deploy.sh", {
      env: { ...FAST, FAKE_BUILD: "v2", FAKE_MIGRATE_EXIT: "1" },
      timeout: SLOW,
    });
    const calls = sb.invocations();
    assert.notEqual(r.status, 0, "a failed migration must fail the deploy");
    assert.ok(
      !calls.some((l) => /^docker compose up/.test(l)),
      "`docker compose up` ran although migrations had not succeeded. Its create phase removes the " +
        `serving app before migrate even starts, so the site goes 502.\n${calls.join("\n")}`,
    );
    assert.ok(calls.includes("docker compose run --rm --no-deps migrate"), "migrations must run on their own, first");
    assert.match(r.stderr, /migrations FAILED[\s\S]*still serving/);
    assert.ok(!calls.some((l) => /seed_all\.ts/.test(l)), "nothing may be seeded after a failed migration");
    for (const svc of ["app", "worker"]) {
      assert.equal(
        imageId(sb, `gml-lms-${svc}:current`),
        `sha256:v1-${svc}`,
        `gml-lms-${svc}:current must name the release still serving, so a later \`up\` cannot start the unmigrated build`,
      );
      assert.equal(imageId(sb, `gml-lms-${svc}:previous`), `sha256:v0-${svc}`, "the rollback target must not move");
    }
  } finally {
    sb.cleanup();
  }
});

// W3-49. The failure message said "the previous containers are still serving"
// whatever was running. On a first deploy there are none: migrate is the
// first container this host ever starts, and the site is down until a deploy
// succeeds. The operator deciding how urgent the fix is must be told that.

test("a failed migration on a host where nothing is running does not claim anything is still serving", () => {
  const sb = storeSandbox({ serving: null, previous: null, deployedBefore: false });
  try {
    const r = sb.run("scripts/deploy.sh", {
      env: { ...FAST, FAKE_BUILD: "v1", FAKE_MIGRATE_EXIT: "1", FAKE_NOTHING_RUNNING: "1" },
      timeout: SLOW,
    });
    assert.notEqual(r.status, 0, "a failed migration must fail the deploy");
    assert.match(r.stderr, /migrations FAILED/);
    assert.doesNotMatch(
      r.stderr,
      /still serving/,
      `nothing is running on this host, yet the operator was told the previous containers are still serving:\n${r.stderr}`,
    );
    assert.match(r.stderr, /no release is running on this host/, `say what is actually true:\n${r.stderr}`);
    for (const svc of ["app", "worker", "migrate"]) {
      assert.equal(
        imageId(sb, `gml-lms-${svc}:current`),
        null,
        `gml-lms-${svc}:current must not name a build whose migration failed and which never served`,
      );
    }
  } finally {
    sb.cleanup();
  }
});

// ── A partly failed build must not move :current ────────────────────────────
//
// W3-45. `docker compose build` writes each service that finishes straight
// into gml-lms-<svc>:current, even when another target then fails and the
// command exits 1 (verified on Compose v5 / BuildKit 0.26, with and without
// bake). deploy.sh ran it bare under `set -e`, so a transient failure in one
// image -- an apt mirror blip in the worker's layer, an OOM in app's
// `next build` -- aborted the script with :current naming an image that never
// served and was never migrated. The next deploy then took THAT as "what was
// serving": :previous stayed on the release before, the release really
// serving lost its last tag, and the prune removed it.

test("a build that fails part-way leaves :current and :previous on the releases that served", () => {
  const sb = storeSandbox({ serving: "v1", previous: "v0" });
  try {
    const r = sb.run("scripts/deploy.sh", {
      env: { ...FAST, FAKE_BUILD: "v2", FAKE_BUILD_FAIL: "1" },
      timeout: SLOW,
    });
    const calls = sb.invocations();
    assert.notEqual(r.status, 0, "a failed build must fail the deploy");
    assert.ok(
      !calls.some((l) => /^docker compose (run|up)/.test(l)),
      `nothing may be migrated or started after a failed build:\n${calls.join("\n")}`,
    );
    for (const svc of ["app", "worker", "migrate"]) {
      assert.equal(
        imageId(sb, `gml-lms-${svc}:current`),
        `sha256:v1-${svc}`,
        `gml-lms-${svc}:current must still name the release that is serving; the half-finished build ` +
          `left it on an image that never served and was never migrated.\n${r.stderr}`,
      );
    }
    for (const svc of ["app", "worker"]) {
      assert.equal(imageId(sb, `gml-lms-${svc}:previous`), `sha256:v0-${svc}`, "the rollback target must not move");
    }
    assert.match(r.stderr, /build FAILED/, `the operator must be told what failed:\n${r.stderr}`);

    // The build is fixed and re-run: the release that was serving becomes the
    // rollback target of BOTH services, not of one.
    const again = sb.run("scripts/deploy.sh", { env: { ...FAST, FAKE_BUILD: "v2" }, timeout: SLOW });
    assert.equal(again.status, 0, again.stderr);
    for (const svc of ["app", "worker"]) {
      assert.equal(imageId(sb, `gml-lms-${svc}:previous`), `sha256:v1-${svc}`, `gml-lms-${svc}:previous after the re-run`);
    }
  } finally {
    sb.cleanup();
  }
});

test("migrations are applied before `docker compose up` on a normal deploy", () => {
  const sb = storeSandbox({ serving: "v1", previous: "v0" });
  try {
    const r = sb.run("scripts/deploy.sh", { env: { ...FAST, FAKE_BUILD: "v2" }, timeout: SLOW });
    assert.equal(r.status, 0, r.stderr);
    const calls = sb.invocations();
    const migrate = calls.indexOf("docker compose run --rm --no-deps migrate");
    const up = calls.findIndex((l) => /^docker compose up/.test(l));
    assert.ok(migrate >= 0 && up > migrate, `migrate must run before up:\n${calls.join("\n")}`);
  } finally {
    sb.cleanup();
  }
});

test("a failing `docker compose up` is reported with the container state, not a bare abort", () => {
  const sb = storeSandbox({ serving: "v1", previous: "v0" });
  try {
    const r = sb.run("scripts/deploy.sh", { env: { ...FAST, FAKE_BUILD: "v2", FAKE_UP_EXIT: "1" }, timeout: SLOW });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /'docker compose up' failed/, `the failure must be explained:\n${r.stderr}`);
    assert.ok(sb.invocations().includes("docker compose ps -a"), "the operator must be shown the container state");
  } finally {
    sb.cleanup();
  }
});

// ── Disk: what the builds leave behind ───────────────────────────────────────
//
// Every deploy builds, and nothing ever pruned: each release's images went
// dangling at the next deploy and the build cache grew without bound, on the
// small root volume. deploy.sh now prunes -- dangling images only, so :current
// and :previous survive -- once the new release is healthy and verified.

test("a completed deploy prunes dangling images and week-old build cache", () => {
  const sb = deploySandbox();
  try {
    const r = sb.run("scripts/deploy.sh", { env: FAST });
    assert.equal(r.status, 0, r.stderr);
    const calls = sb.invocations();
    assert.ok(calls.includes("docker image prune -f"), `dangling images were never pruned:\n${calls.join("\n")}`);
    assert.ok(
      calls.includes("docker builder prune -f --filter until=168h"),
      `the build cache was never pruned:\n${calls.join("\n")}`,
    );
    assert.ok(
      !calls.some((l) => /^docker (image|system) prune .*(-a|--all)/.test(l)),
      "only DANGLING images may go: an --all prune would delete the tagged :previous rollback target",
    );
  } finally {
    sb.cleanup();
  }
});

test("a deploy that fails prunes nothing", () => {
  const sb = deploySandbox({ healthy: false });
  try {
    const r = sb.run("scripts/deploy.sh", { env: { HEALTH_TIMEOUT_SECONDS: "0", HEALTH_INTERVAL_SECONDS: "1" } });
    assert.notEqual(r.status, 0);
    assert.ok(!sb.invocations().some((l) => /prune/.test(l)), "keep everything for diagnosis when the deploy failed");
  } finally {
    sb.cleanup();
  }
});
