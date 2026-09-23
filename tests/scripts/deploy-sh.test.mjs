// deploy.sh — every variable it dereferences must actually be defined.
//
// ── WHY THIS TEST EXISTS ─────────────────────────────────────────────────────
//
// A change to deploy.sh deleted the block defining HEALTH_URL,
// HEALTH_TIMEOUT_SECONDS and HEALTH_INTERVAL_SECONDS while leaving seven
// dereferences of them at lines 145-162. The script runs under `set -euo
// pipefail`, so the first `${HEALTH_URL}` aborts it with "unbound variable".
//
// Nothing caught this. `bash -n scripts/deploy.sh` exits 0 — an undefined
// variable is a RUNTIME failure, not a syntax error — and no test executed the
// script at all. The abort would have landed in the middle of a production
// deploy, AFTER `docker compose build` and AFTER the migrate gate, which is the
// worst possible place for it: images rebuilt, migrations applied, and the
// operator looking at a failure that names a variable rather than a cause.
//
// ── WHY A DRY RUN RATHER THAN A GREP ─────────────────────────────────────────
//
// A governance-style regex ("the file contains HEALTH_URL=") would have passed
// on the broken file, because the string was still present seven times as a
// dereference. The only thing that distinguishes "defined" from "referenced" is
// running the script under `set -u` and seeing whether it survives.
//
// DEPLOY_DRY_RUN=1 makes deploy.sh resolve its configuration, echo it, and exit
// before it touches docker, the database or the network. It deliberately sits
// before the .env checks so this test needs no secrets and runs in CI.
//
// The expected variable set is DERIVED FROM THE SOURCE rather than hardcoded,
// so a future variable added to the script is covered without editing this file
// — and so this test cannot quietly stop guarding anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT = "scripts/deploy.sh";

function dryRun(extraEnv = {}) {
  return spawnSync("bash", [SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEPLOY_DRY_RUN: "1", ...extraEnv },
  });
}

/** Every `${HEALTH_…}` the script dereferences, read out of the source. */
function referencedHealthVars() {
  const src = readFileSync(resolve(root, SCRIPT), "utf8");
  const names = new Set();
  for (const m of src.matchAll(/\$\{(HEALTH_[A-Z_]+)[:}]/g)) names.add(m[1]);
  return [...names].sort();
}

test("deploy.sh dry-run completes without an unbound variable", () => {
  const r = dryRun();
  assert.equal(
    r.status,
    0,
    `deploy.sh exited ${r.status} under DEPLOY_DRY_RUN.\nstderr:\n${r.stderr}`,
  );
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
    `expected the health probe to read at least 3 variables, found ${referenced.length}`,
  );

  const r = dryRun();
  assert.equal(r.status, 0, `dry-run failed:\n${r.stderr}`);

  const resolved = new Map(
    r.stdout
      .split(/\r?\n/)
      .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );

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

test("the health probe's timing is overridable from the environment", () => {
  // Proves the defaults are `${VAR:-default}` rather than bare assignments, so
  // an operator can shorten the wait on a slow box without editing the script.
  const r = dryRun({ HEALTH_TIMEOUT_SECONDS: "7", HEALTH_INTERVAL_SECONDS: "2" });
  assert.equal(r.status, 0, `dry-run failed:\n${r.stderr}`);
  assert.match(r.stdout, /^HEALTH_TIMEOUT_SECONDS=7$/m);
  assert.match(r.stdout, /^HEALTH_INTERVAL_SECONDS=2$/m);
});
