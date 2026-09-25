// rollback.sh, run end to end against stubs (structural sandbox: _sandbox.mjs).
//
// It had the SAME probe defect as deploy.sh, hard-coded with no override:
// `curl ... http://127.0.0.1/api/health`. Host 127.0.0.1 matches no Caddy site
// block, so the probe could never read the app's `"ok":true`, and every
// rollback ended "still unhealthy after 120s" — AFTER the containers had
// already been restarted from :previous. The rollback happened; only the
// verdict was wrong, and a wrong verdict trains an operator to distrust a
// rollback that worked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { caddyCurl, makeSandbox } from "./_sandbox.mjs";

const DOMAIN = "lms.example.test";

// `image inspect --format {{.Id}}` answers a distinct id per tag -- or, with
// FAKE_SAME_IMAGE, the same id for :previous and :current, which is what a
// re-run of deploy.sh on unchanged code used to leave behind.
const DOCKER = `
case "$*" in
  images*) printf 'gml-lms-app:previous\\t2026-09-20\\ngml-lms-worker:previous\\t2026-09-20\\n' ;;
  "image inspect --format {{.Id}} "*)
    ref="$5"
    [ -n "\${FAKE_SAME_IMAGE:-}" ] && ref="\${ref%:*}"
    echo "sha256:$(printf %s "$ref" | tr ':' '-')" ;;
esac
exit 0
`;

function rollbackSandbox({ healthy = true } = {}) {
  const sb = makeSandbox({ files: ["scripts/rollback.sh"], prefix: "gml-rollback-" });
  sb.write(".env", `DOMAIN=${DOMAIN}\nACME_EMAIL=ops@example.test\n`);
  sb.stub("docker", DOCKER);
  sb.stub("curl", caddyCurl(DOMAIN, { healthy }));
  return sb;
}

// Current code ignores these and waits its hardcoded 120s; the spawn timeout
// leaves room for that so the red run reports the real failure.
const FAST = { HEALTH_TIMEOUT_SECONDS: "4", HEALTH_INTERVAL_SECONDS: "1" };

test("a rollback onto a healthy app reports healthy", () => {
  const sb = rollbackSandbox();
  try {
    const r = sb.run("scripts/rollback.sh", { env: FAST, input: "rollback\n", timeout: 200_000 });
    const calls = sb.invocations();
    assert.equal(r.status, 0, `rollback reported failure on a healthy app.\nstderr:\n${r.stderr}\n${calls.join("\n")}`);
    assert.match(r.stdout, /rolled back and healthy/);
    const probe = calls.find((l) => /^curl .*\/api\/health/.test(l));
    assert.ok(
      probe?.includes(`--resolve ${DOMAIN}:443:127.0.0.1`) && probe.includes(`https://${DOMAIN}/api/health`),
      `rollback's probe must carry a Host that Caddy serves: ${probe}`,
    );
    assert.ok(calls.some((l) => l === "docker compose up -d --no-deps app worker"));
  } finally {
    sb.cleanup();
  }
});

test("a rollback onto a broken app still reports unhealthy, quickly when told to", () => {
  const sb = rollbackSandbox({ healthy: false });
  try {
    const r = sb.run("scripts/rollback.sh", { env: FAST, input: "rollback\n", timeout: 200_000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /still unhealthy after 4s/);
  } finally {
    sb.cleanup();
  }
});

test("rollback.sh asks before doing anything, and aborts without the word", () => {
  const sb = rollbackSandbox();
  try {
    const r = sb.run("scripts/rollback.sh", { env: FAST, input: "no\n" });
    assert.notEqual(r.status, 0);
    assert.ok(
      !sb.invocations().some((l) => /^docker (tag|compose up)/.test(l)),
      "nothing may be retagged or restarted without confirmation",
    );
  } finally {
    sb.cleanup();
  }
});

test("rollback.sh refuses when :previous is the image already running", () => {
  // deploy.sh used to retag :current -> :previous on every run, so a re-run of
  // the same code left both naming one image -- and this script retagged it
  // onto itself, restarted the release it was meant to leave, and reported a
  // rollback.
  const sb = rollbackSandbox();
  try {
    const r = sb.run("scripts/rollback.sh", { env: { ...FAST, FAKE_SAME_IMAGE: "1" }, input: "rollback\n", timeout: 200_000 });
    assert.notEqual(r.status, 0, `a rollback onto the running image must be refused:\n${r.stdout}`);
    assert.match(r.stderr, /already running/);
    assert.ok(
      !sb.invocations().some((l) => /^docker (tag|compose up)/.test(l)),
      `nothing may be retagged or restarted:\n${sb.invocations().join("\n")}`,
    );
  } finally {
    sb.cleanup();
  }
});
