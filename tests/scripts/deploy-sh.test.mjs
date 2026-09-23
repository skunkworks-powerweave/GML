// deploy.sh — executed, not grepped.
//
// ── WHAT THIS TIER IS FOR ────────────────────────────────────────────────────
//
// `scripts/*.sh` had no tests of any kind. The failure mode that motivated this
// file is a variable that is DEREFERENCED but never DEFINED: under
// `set -euo pipefail` that aborts the deploy, and it is invisible to the other
// tiers.
//
//   bash -n scripts/deploy.sh   exits 0 — an undefined variable is a RUNTIME
//                               failure, not a syntax error.
//   tests/governance/           cannot execute anything. It does have a related
//                               assertion — test_108:129 matches the string
//                               `HEALTH_URL:-http://127.0.0.1/api/health` — but
//                               that is an UNANCHORED SUBSTRING, so an `echo`
//                               containing the same default satisfies it just
//                               as well as an assignment does. (An earlier
//                               version of this comment called it an assignment
//                               check. It is not.)
//
// ── RUNNING deploy.sh IN A TEST IS DANGEROUS, AND TWICE WAS NOT ENOUGH ───────
//
// This file has twice shipped a test that executed the REAL deploy path.
//
//   v1  spawned deploy.sh with the inherited environment and assumed it would
//       die on something missing. On a host where nothing is missing it does
//       not die: it re-tags gml-lms-*:current to :previous — destroying the
//       image scripts/rollback.sh rolls back to — then `docker compose build`
//       and `docker compose up -d --remove-orphans`. Five times per run.
//
//   v2  "fixed" this by narrowing PATH to bash's own directory, on the
//       assumption that it would not contain docker/node/pnpm. On Ubuntu it is
//       /usr/bin, which routinely contains all four. Exposure went from five
//       spawns to eight, one of them silent.
//
// Both attempts guarded with the ENVIRONMENT. The environment is not a
// boundary. What follows is structural instead, and rests on two facts about
// the script rather than about the host:
//
//   1. deploy.sh does `cd "$(dirname "$0")/.."` — it changes to a directory
//      relative to ITSELF, not to the caller's cwd. A copy under a temp
//      directory therefore roots itself in that temp directory.
//   2. `[ -f .env ] || fail` sits at deploy.sh:156. The first destructive
//      command, `docker tag`, is at :185. So a run that cannot find a .env
//      aborts 29 lines before it can touch anything.
//
// So: copy the script somewhere with no .env above it, and put logging stubs
// first on PATH. The stubs let the toolchain check pass, and they RECORD every
// invocation — which is what turns "it should not reach docker" from an
// assumption into an assertion. If a future edit moves the .env gate below the
// build, the tripwire fails the test instead of eating someone's rollback
// image.
//
// ── WHAT THESE TESTS DO AND DO NOT PROVE ─────────────────────────────────────
//
// They prove the HEALTH_* set is defined at top level, non-empty, overridable,
// and that "off" values do not take the dry-run exit.
//
// They do NOT prove:
//   - that every variable anywhere in deploy.sh is defined. Nothing after the
//     dry-run `exit 0` executes, so `set -u` never reaches it.
//   - that a HEALTH_* definition is REACHABLE. The top-level check below is a
//     source-presence test: `unset` after the assignment, an assignment inside
//     an uncalled function, or one sitting in a heredoc all satisfy it while
//     the real probe still aborts. It catches the regressions that actually
//     occurred here (a definition moved into a branch, or replaced by a default
//     baked into the echo) and it is not a general guarantee.
//   - that a newly added HEALTH_* is covered with no edit to this file. The
//     derivation finds it, but test 3 then requires a sentinel for it and says
//     so by name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT = "scripts/deploy.sh";

/** Commands that must never be reached by a test. */
const DESTRUCTIVE = /\b(tag|build|up|down|rm)\b/;

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

/**
 * Run a COPY of deploy.sh rooted where there is no .env, with logging stubs
 * ahead of the real binaries. Returns the result plus everything the script
 * tried to invoke. See the header for why this is structural and PATH was not.
 */
function runSandboxed(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-sh-"));
  try {
    mkdirSync(join(dir, "scripts"));
    copyFileSync(resolve(root, SCRIPT), join(dir, "scripts", "deploy.sh"));

    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const log = join(dir, "invocations.log");
    for (const tool of ["docker", "node", "pnpm", "curl"]) {
      const stub = join(binDir, tool);
      // Exit 0 so the toolchain check passes and the script proceeds to the
      // .env gate — which is the boundary being demonstrated.
      writeFileSync(stub, `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
      chmodSync(stub, 0o755);
    }

    const r = spawnSync("bash", [join(dir, "scripts", "deploy.sh")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, ...env, PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` },
    });

    let invocations = [];
    try {
      invocations = readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      invocations = []; // nothing was invoked at all
    }
    return { ...r, invocations };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Fail loudly if a sandboxed run got anywhere near a mutating command. */
function assertNothingDestructive(r, label) {
  const bad = r.invocations.filter((line) => DESTRUCTIVE.test(line));
  assert.deepEqual(
    bad,
    [],
    `${label} reached a mutating command. This test must never be able to do that — ` +
      `\`docker tag …:current …:previous\` destroys the rollback target and ` +
      `\`docker compose up\` restarts the live stack. Invoked:\n  ${r.invocations.join("\n  ")}`,
  );
}

/** Every `${HEALTH_…}` the script dereferences, read out of the source. */
function referencedHealthVars() {
  const src = readFileSync(resolve(root, SCRIPT), "utf8");
  const names = new Set();
  for (const m of src.matchAll(/\$\{(HEALTH_[A-Z_]+)[:}]/g)) names.add(m[1]);
  return [...names].sort();
}

function resolvedVars(stdout) {
  return new Map(
    (stdout ?? "")
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
  // Without this, an author could literalise one echo —
  //     echo "HEALTH_URL=http://127.0.0.1/api/health"
  // — delete the matching definition, and leave the suite green while the real
  // probe aborts. Requiring each name to reflect a value only the environment
  // could have supplied makes the echo prove the variable rather than a string.
  const sentinel = {
    HEALTH_URL: "https://deploy-sh-test.invalid/probe",
    HEALTH_TIMEOUT_SECONDS: "7",
    HEALTH_INTERVAL_SECONDS: "2",
  };
  for (const name of referencedHealthVars()) {
    assert.ok(
      name in sentinel,
      `${name} is dereferenced by the probe but has no sentinel here. Add one — ` +
        `otherwise a literalised echo of it would go unnoticed. (This is the edit ` +
        `the file header warns a new HEALTH_* variable requires.)`,
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
  // `[ -n "$DEPLOY_DRY_RUN" ]` treated every one of these as TRUE, so an
  // operator writing DEPLOY_DRY_RUN=false to disable the dry run got a silent
  // no-op that exited 0.
  //
  // Sandboxed — see the file header. The script roots itself in a temp
  // directory with no .env and aborts at deploy.sh:156, which is upstream of
  // every mutating command, and the stubs record anything it does invoke.
  for (const off of ["0", "false", "no", "off", "", "FALSE", "Off"]) {
    const r = runSandboxed({ DEPLOY_DRY_RUN: off });
    const label = `DEPLOY_DRY_RUN=${JSON.stringify(off)}`;

    assertNothingDestructive(r, label);
    assert.doesNotMatch(
      r.stderr ?? "",
      /DRY RUN — configuration only/,
      `${label} took the dry-run path; "off" must mean off`,
    );
    assert.ok(
      !resolvedVars(r.stdout).has("HEALTH_URL"),
      `${label} printed the dry-run configuration block`,
    );
    // Positive evidence it continued into the script proper and stopped at the
    // .env gate, rather than exiting early for some unrelated reason.
    assert.match(
      r.stderr ?? "",
      /\.env not found/,
      `${label} should have continued past the dry-run block to the .env gate. stderr:\n${r.stderr}`,
    );
  }
});

test("an exported DEPLOY_DRY_RUN_TOOLCHAIN cannot silently no-op a deploy", () => {
  // The toolchain arm sets this variable and it is read further down. If the
  // off arm does not clear it, an operator who exported it directly gets exit 0
  // having deployed nothing — the same defect through a second variable.
  const r = runSandboxed({ DEPLOY_DRY_RUN: "", DEPLOY_DRY_RUN_TOOLCHAIN: "1" });
  assertNothingDestructive(r, "DEPLOY_DRY_RUN_TOOLCHAIN=1");
  assert.doesNotMatch(
    r.stdout ?? "",
    /TOOLCHAIN_OK=1/,
    "an inherited DEPLOY_DRY_RUN_TOOLCHAIN took the toolchain exit; the off arm must clear it",
  );
});

test("each HEALTH_* variable has a real top-level assignment, not just an echo", () => {
  // ── WHAT THIS CATCHES, AND WHAT IT DOES NOT ───────────────────────────────
  //
  // Echoing a value does not prove a definition. Two mutations kept the rest of
  // this suite green while the live probe aborted on an unbound variable:
  //
  //   echo "HEALTH_URL=${HEALTH_URL:-http://127.0.0.1/api/health}"  + no definition
  //   move all three definitions INSIDE the dry-run branch
  //
  // Requiring the assignment at column 0 catches both. It does NOT establish
  // that the definition is REACHABLE: an `unset` after it, an assignment inside
  // a function that is never called, or the same text inside a heredoc all
  // satisfy this check while the real probe still dies. Proving reachability
  // would mean running the script past the health probe, which is exactly the
  // part a test must not execute. This is the honest bound.
  const src = readFileSync(resolve(root, SCRIPT), "utf8");
  for (const name of referencedHealthVars()) {
    assert.match(
      src,
      new RegExp(String.raw`^${name}=`, "m"),
      `${name} is dereferenced by the health probe but has no top-level assignment in ${SCRIPT}. ` +
        `A definition nested inside the dry-run branch, or a default baked into its echo, ` +
        `leaves the real probe aborting on an unbound variable while this suite stays green.`,
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
  // BOUNDED, and the bound is the allow-list below — a tool outside it (say
  // `openssl`) would be invoked and demanded of nobody. Deriving the candidate
  // set from the script instead is not straightforward: `for cmd in ...` and
  // `docker compose run ... psql` are both "words followed by arguments", so a
  // general derivation would demand container-only tools of the host. The list
  // is the honest compromise; extend it when a dependency is added.
  const src = readFileSync(resolve(root, SCRIPT), "utf8");
  const body = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l)) // comments name tools without invoking them
    .join("\n");

  const loop = body.match(/for\s+cmd\s+in\s+([^;]+);\s*do/);
  assert.ok(loop, "deploy.sh must check its host toolchain in a `for cmd in ...` loop");
  const checked = new Set(loop[1].trim().split(/\s+/));

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

  // `command -v docker` does not prove the Compose v2 PLUGIN is installed, and
  // `docker compose build` is the first thing that would fail on a host with
  // only the v1 `docker-compose` binary.
  if (/(^|[;&|(\s])docker compose\s/m.test(body)) {
    assert.match(
      body,
      /docker compose version\b/,
      "deploy.sh runs `docker compose` but never probes `docker compose version`. " +
        "On a host with only Compose v1 the first failure would be `docker compose build`, " +
        "mid-deploy, rather than a named blocker in preflight.",
    );
  }
});

test("the host-toolchain check names the missing binary instead of failing later", () => {
  // Sandboxed with NO stubs on PATH at all, so every required binary is absent
  // and the loop must abort. Uses the temp copy for the same structural reason
  // as the tests above: whatever happens, it cannot reach a mutating command.
  //
  // The failure this guards is not "docker is missing" (that fails obviously)
  // but node, pnpm and curl, each of which fails late and misleadingly: node
  // after nothing has been built, pnpm after a WORKING deploy, and curl not at
  // all — curl is a loop condition, so its absence reads as "the app never
  // became healthy" and dumps application logs.
  const dir = mkdtempSync(join(tmpdir(), "deploy-sh-tc-"));
  try {
    mkdirSync(join(dir, "scripts"));
    copyFileSync(resolve(root, SCRIPT), join(dir, "scripts", "deploy.sh"));
    const emptyBin = join(dir, "bin");
    mkdirSync(emptyBin);

    // bash must still be findable or we measure the launcher, not the script.
    const where = spawnSync(
      "bash",
      [
        "-c",
        'd="$(dirname "$(command -v bash)")"; if command -v cygpath >/dev/null 2>&1; then cygpath -w "$d"; else printf %s "$d"; fi',
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(where.status, 0, `could not locate bash: ${where.stderr}`);
    const sep = process.platform === "win32" ? ";" : ":";

    const r = spawnSync("bash", [join(dir, "scripts", "deploy.sh")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        DEPLOY_DRY_RUN: "toolchain",
        PATH: `${emptyBin}${sep}${where.stdout.trim()}`,
      },
    });

    assert.notEqual(
      r.status,
      null,
      `bash did not start — the test would be measuring the launcher. error: ${r.error?.message ?? "none"}`,
    );
    assert.notEqual(r.status, 0, "a missing host binary must abort the deploy");
    assert.match(
      r.stderr ?? "",
      /is not installed on this host|Compose v2 plugin is not available/,
      `the abort must NAME the missing tool and point at the runbook. stderr:\n${r.stderr}`,
    );
    assert.match(r.stderr ?? "", /README-deploy\.md/, "the operator must be told where to fix it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
