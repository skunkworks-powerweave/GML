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
import { caddyCurl, makeSandbox } from "./_sandbox.mjs";

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

function deploySandbox({ healthy = true } = {}) {
  const sb = makeSandbox({ files: ["scripts/deploy.sh"], prefix: "gml-deploy-" });
  sb.write(".env", ENV_FILE);
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
  const sb = deploySandbox();
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
