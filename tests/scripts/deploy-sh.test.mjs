// deploy.sh — executed, not grepped.
//
// ── WHAT THIS TIER IS FOR ────────────────────────────────────────────────────
//
// `scripts/*.sh` had no tests of any kind. The failure mode that motivated this
// file is a variable that is DEREFERENCED but never DEFINED: under
// `set -euo pipefail` that aborts the deploy, and it is invisible to every
// other tier we have.
//
//   bash -n scripts/deploy.sh   exits 0 — an undefined variable is a RUNTIME
//                               failure, not a syntax error
//   tests/governance/           regex over source text; "HEALTH_URL" appears
//                               seven times as a dereference, so a grep for it
//                               passes whether or not it is ever assigned
//
// Only running the script distinguishes the two. `DEPLOY_DRY_RUN` resolves the
// configuration and exits before touching docker, the database or the network,
// so this runs in CI with no secrets and no stack.
//
// ── WHAT THESE TESTS DO AND DO NOT PROVE ─────────────────────────────────────
//
// They prove the HEALTH_* set is defined, non-empty, and overridable. They do
// NOT prove that every variable anywhere in deploy.sh is defined: nothing after
// the dry-run `exit 0` executes, so `set -u` never reaches it. An earlier draft
// of this header claimed the general property; it did not hold, and a test file
// that overstates its own coverage is worse than the gap it hides.
//
// The expected variable set is DERIVED FROM THE SOURCE rather than hardcoded,
// so a HEALTH_* variable added to the probe is covered without editing this
// file. Each is also asserted to honour an environment override, which is what
// stops the dry-run block from drifting into a hand-written echo of literals
// that would stay green while the real body aborted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT = "scripts/deploy.sh";

function run(extraEnv = {}) {
  const r = spawnSync("bash", [SCRIPT], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, DEPLOY_DRY_RUN: "1", ...extraEnv },
  });
  if (r.error) {
    assert.fail(
      `could not execute bash ${SCRIPT}: ${r.error.message}. ` +
        `This tier needs bash on PATH (Git Bash on Windows).`,
    );
  }
  return r;
}

/** Every `${HEALTH_…}` the script dereferences, read out of the source. */
function referencedHealthVars() {
  const src = readFileSync(resolve(root, SCRIPT), "utf8");
  const names = new Set();
  for (const m of src.matchAll(/\$\{(HEALTH_[A-Z_]+)[:}]/g)) names.add(m[1]);
  names.delete("HEALTH_URL_UNUSED"); // placeholder guard; no-op today
  return [...names].sort();
}

function resolvedVars(stdout) {
  return new Map(
    stdout
      .split(/\r?\n/)
      .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
}

test("deploy.sh dry-run completes without an unbound variable", () => {
  const r = run();
  assert.equal(r.status, 0, `deploy.sh exited ${r.status}.\nstderr:\n${r.stderr}`);
  assert.doesNotMatch(
    r.stderr,
    /unbound variable/,
    "set -u aborted the script — a variable is dereferenced but never defined",
  );
});

test("every HEALTH_* variable deploy.sh dereferences is defined and non-empty", () => {
  const referenced = referencedHealthVars();
  assert.ok(
    referenced.length >= 3,
    `expected the health probe to read at least 3 variables, found ${referenced.length}. ` +
      `If the probe was rewritten, this guard has gone vacuous — fix the derivation.`,
  );

  const r = run();
  assert.equal(r.status, 0, `dry-run failed:\n${r.stderr}`);
  const resolved = resolvedVars(r.stdout);

  for (const name of referenced) {
    assert.ok(
      resolved.has(name),
      `${name} is dereferenced in ${SCRIPT} but the dry run did not resolve it — it has no definition`,
    );
    assert.notEqual(
      resolved.get(name),
      "",
      `${name} resolved to the empty string; the health probe would misbehave rather than fail loudly`,
    );
  }
});

test("every HEALTH_* variable honours an environment override", () => {
  // ── WHY THIS COVERS ALL THREE, NOT JUST THE TIMINGS ───────────────────────
  //
  // The dry-run block echoes a hand-maintained list. Without this test an
  // author could literalise one line —
  //
  //     echo "HEALTH_URL=http://127.0.0.1/api/health"   # instead of ${HEALTH_URL}
  //
  // — delete the matching definition, and leave this suite GREEN while the real
  // health probe at the bottom of the script aborts with exactly the
  // "unbound variable" this file exists to prevent. Asserting that each name
  // reflects a value only the environment could have supplied makes the echo
  // prove the variable, not the string.
  const sentinel = {
    HEALTH_URL: "https://deploy-sh-test.invalid/probe",
    HEALTH_TIMEOUT_SECONDS: "7",
    HEALTH_INTERVAL_SECONDS: "2",
  };
  const referenced = referencedHealthVars();
  for (const name of referenced) {
    assert.ok(
      name in sentinel,
      `${name} is dereferenced by the probe but has no sentinel here — add one, ` +
        `or a literalised echo of it would go unnoticed`,
    );
  }

  const r = run(sentinel);
  assert.equal(r.status, 0, `dry-run failed:\n${r.stderr}`);
  const resolved = resolvedVars(r.stdout);

  for (const [name, value] of Object.entries(sentinel)) {
    assert.equal(
      resolved.get(name),
      value,
      `${name} did not reflect the environment override — the dry run is echoing a literal, ` +
        `so it no longer demonstrates that the variable is defined`,
    );
  }
});

test("a dry run announces itself and cannot be mistaken for a deploy", () => {
  // Exit 0 plus quiet output is how a no-op passes for success. `git pull &&
  // ./scripts/deploy.sh` reports nothing wrong either way, so the banner is the
  // only thing standing between an operator and a deploy that never happened.
  const r = run();
  assert.match(
    r.stderr,
    /DRY RUN/,
    "a dry run must say so on stderr; it exits 0 and would otherwise look like a successful deploy",
  );
  assert.match(r.stderr, /NOTHING WAS DEPLOYED/);
});

test("DEPLOY_DRY_RUN=0 / false / no / off mean OFF, not on", () => {
  // `[ -n "$DEPLOY_DRY_RUN" ]` treats every one of these as TRUE. An operator
  // writing DEPLOY_DRY_RUN=false to disable the dry run would have got a
  // silent no-op that exited 0. The seed scripts in packages/db/src/scripts/
  // already use the strict form; this keeps deploy.sh consistent with them.
  //
  // Each value must fall through to the real script. We cannot run a real
  // deploy here, so we assert it did NOT take the dry-run exit: no banner, and
  // it got far enough to fail on something else (a missing binary or .env).
  for (const off of ["0", "false", "no", "off", ""]) {
    const r = run({ DEPLOY_DRY_RUN: off });
    assert.doesNotMatch(
      r.stderr,
      /DRY RUN — configuration only/,
      `DEPLOY_DRY_RUN=${JSON.stringify(off)} took the dry-run path; "off" must mean off`,
    );
    assert.ok(
      !resolvedVars(r.stdout).has("HEALTH_URL"),
      `DEPLOY_DRY_RUN=${JSON.stringify(off)} printed the dry-run configuration block`,
    );
  }
});

test("every host binary deploy.sh invokes is in the toolchain check", () => {
  // ── DERIVED FROM USAGE, NOT A HARDCODED LIST ──────────────────────────────
  //
  // `curl` was invoked twice and checked nowhere. Asserting only that "some
  // missing binary produces a named blocker" does not catch that: docker is
  // tested first, so removing curl from the list again would go unnoticed.
  //
  // So: scan the body for the tools it actually calls, and require each to be
  // in the loop. A new dependency added to the script is then covered without
  // editing this test — which is the only way this guard stays honest.
  const src = readFileSync(resolve(root, SCRIPT), "utf8");
  const body = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l)) // comments name tools without invoking them
    .join("\n");

  const loop = body.match(/for\s+cmd\s+in\s+([^;]+);\s*do/);
  assert.ok(loop, "deploy.sh must check its host toolchain in a `for cmd in ...` loop");
  const checked = new Set(loop[1].trim().split(/\s+/));

  // Host binaries this script could plausibly shell out to. Anything it does
  // invoke must be declared; anything it does not is simply absent here.
  for (const tool of ["docker", "node", "pnpm", "curl", "jq", "rclone", "psql", "pg_dump"]) {
    const invoked = new RegExp(String.raw`(^|[;&|(\s])${tool}\s`, "m").test(body);
    if (!invoked) continue;
    assert.ok(
      checked.has(tool),
      `deploy.sh invokes \`${tool}\` but does not check for it. A missing host binary must ` +
        `become a named blocker before anything is built, not a late or silent failure ` +
        `(curl is the worst case: it is a loop CONDITION, so its absence reads as ` +
        `"the app never became healthy"). Checked: ${[...checked].join(", ")}`,
    );
  }
});

test("the host-toolchain check names the missing binary instead of failing later", () => {
  // ── WHY THIS MODE EXISTS ──────────────────────────────────────────────────
  //
  // The toolchain loop sits after the dry-run exit, so the default dry run does
  // not execute it and it would otherwise ship with no coverage at all. This
  // mode runs the loop and then stops, which lets the test drive it with a
  // stripped PATH — no docker required on the machine running the suite.
  //
  // The failure it guards is not "docker is missing" (that fails obviously) but
  // node, pnpm and curl, each of which fails late and misleadingly: node after
  // nothing has been built, pnpm after a WORKING deploy, and curl not at all —
  // curl is a loop condition, so its absence reads as "the app never became
  // healthy" and dumps application logs.
  // PATH is narrowed to bash's OWN directory. An empty or bogus PATH is not an
  // option: bash then cannot start at all (on Git Bash it fails to load its
  // msys DLLs, and the test measures the launcher rather than the script).
  // Bash's own bin directory is the portable choice — it necessarily contains
  // bash, and contains none of docker, node or pnpm on either platform.
  // `dirname $(command -v bash)` yields a POSIX path (/usr/bin). On Windows
  // that is meaningless to CreateProcess, so PATH would be junk and bash would
  // not start at all — which looks like a passing assertion about the wrong
  // thing. cygpath -w converts it where it exists; elsewhere the POSIX path is
  // already correct.
  const where = spawnSync(
    "bash",
    ["-c", 'd="$(dirname "$(command -v bash)")"; if command -v cygpath >/dev/null 2>&1; then cygpath -w "$d"; else printf %s "$d"; fi'],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(where.status, 0, `could not locate bash: ${where.stderr}`);
  const bashDir = where.stdout.trim();
  assert.ok(bashDir.length > 0, "bash reported no directory for itself");

  const r = spawnSync("bash", [SCRIPT], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, DEPLOY_DRY_RUN: "toolchain", PATH: bashDir },
  });
  assert.notEqual(
    r.status,
    null,
    `bash did not start under PATH=${bashDir} — the test would be measuring the launcher, ` +
      `not the script. error: ${r.error?.message ?? "none"}`,
  );
  assert.doesNotMatch(
    r.stderr ?? "",
    /execvpe|No such file or directory.*bash/,
    "bash itself failed to launch — the test is measuring the launcher, not the script",
  );

  assert.notEqual(r.status, 0, "a missing host binary must abort the deploy");
  assert.match(
    r.stderr,
    /is not installed on this host|Compose v2 plugin is not available/,
    `the abort must NAME the missing tool and point at the runbook. stderr:\n${r.stderr}`,
  );
  assert.match(
    r.stderr,
    /README-deploy\.md/,
    "the operator must be told where to fix it",
  );
});
