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
