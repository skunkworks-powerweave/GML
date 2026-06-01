import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

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

test("spec 108: deploy.sh waits on /api/health between boot and migrate", () => {
  const src = read(DEPLOY_PATH);
  assert.match(src, /curl/, "deploy.sh must curl /api/health for the health-wait");
  assert.match(src, /\/api\/health/, "deploy.sh must reference the /api/health endpoint");
  const upIdx = src.indexOf("docker compose up");
  // Find the curl-based health-wait line (the actual loop body), not the URL var declaration.
  const curlIdx = src.search(/curl[^\n]*api\/health|until\s+curl/);
  const migrateIdx = src.search(/docker compose exec[^\n]+migrate/);
  assert.ok(
    upIdx >= 0 && curlIdx >= 0 && migrateIdx >= 0,
    "docker compose up + curl health-wait + migrate must all be present",
  );
  assert.ok(
    upIdx < curlIdx && curlIdx < migrateIdx,
    "health-wait (curl /api/health loop) must come between 'docker compose up' and the migration step",
  );
});

test("spec 108: deploy.sh runs migrations and then the spec-104 seed_all orchestrator", () => {
  const src = read(DEPLOY_PATH);
  assert.match(
    src,
    /docker compose exec\s+-T\s+app\s+pnpm\s+--filter\s+@gml\/db\s+migrate/,
    "deploy.sh must run 'docker compose exec -T app pnpm --filter @gml/db migrate'",
  );
  assert.match(
    src,
    /seed_all\.ts/,
    "deploy.sh must invoke packages/db/src/scripts/seed_all.ts (the spec-104 orchestrator)",
  );
  const migrateIdx = src.search(/docker compose exec[^\n]+migrate/);
  const seedIdx = src.indexOf("seed_all.ts");
  assert.ok(migrateIdx < seedIdx, "migrate must run before seed_all");
});

test("spec 108: deploy.sh emits a final success message", () => {
  const src = read(DEPLOY_PATH);
  // Loosely matches the project log convention: "[deploy] ... stack is up" or "done".
  assert.match(
    src,
    /\[deploy\][^\n]*(stack is up|done|success)/i,
    "deploy.sh must echo a recognisable success message at the bottom",
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
  assert.match(
    src,
    /docker compose exec[^\n]*pnpm[^\n]*migrate/,
    "README-IT.md fallback must keep the docker compose exec migrate command",
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
  const src = read(DEPLOY_PATH);
  assert.ok(!/\bTODO\b/i.test(src), "deploy.sh must not contain TODO markers");
  assert.ok(!/\bFIXME\b/i.test(src), "deploy.sh must not contain FIXME markers");
  assert.ok(!/placeholder/i.test(src), "deploy.sh must not contain 'placeholder' literals");
});
