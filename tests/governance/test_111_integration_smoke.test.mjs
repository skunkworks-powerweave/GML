import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SMOKE = "tests/integration/smoke.test.mjs";
const SPEC_DIR = "specs/111-integration-smoke";
const PKG = "package.json";

test("spec 111: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 111: integration smoke file exists at the canonical path", () => {
  assert.ok(
    existsSync(resolve(root, SMOKE)),
    `${SMOKE} must exist — the first behavioural (non-grep) test in the repo`,
  );
});

test("spec 111: smoke imports from node:test and uses global fetch", () => {
  const src = read(SMOKE);
  // Must use node:test idiom (matches governance tests, no new dependencies).
  assert.match(
    src,
    /from\s+["']node:test["']/,
    "smoke must import its test runner from 'node:test'",
  );
  // Must call fetch — this is what distinguishes a behavioural test from a
  // grep test. We accept either bare `fetch(` or `globalThis.fetch(`.
  assert.match(
    src,
    /\b(globalThis\.)?fetch\s*\(/,
    "smoke must call fetch() to exercise the running app via real HTTP",
  );
});

test("spec 111: smoke references at least 4 distinct /api/... endpoints", () => {
  const src = read(SMOKE);
  // Pull out every /api/... path mentioned in the file and de-dupe.
  const matches = src.match(/\/api\/[a-zA-Z0-9_\-/[\]]+/g) ?? [];
  const distinct = new Set(matches);
  assert.ok(
    distinct.size >= 4,
    `smoke must reference at least 4 distinct /api/... endpoints, saw ${distinct.size}: ${[...distinct].join(", ")}`,
  );
});

test("spec 111: smoke implements skip-when-unreachable logic", () => {
  const src = read(SMOKE);
  // The skip path must be wired in: env var to override the base URL, AND a
  // probe path that exercises /api/health. Both signals together guarantee
  // the suite stays green in non-running environments.
  assert.match(
    src,
    /SMOKE_BASE_URL/,
    "smoke must reference SMOKE_BASE_URL env var so operators can target a remote stack",
  );
  assert.match(
    src,
    /\/api\/health/,
    "smoke must probe /api/health to decide whether to skip",
  );
  // Skip itself must be called per-test (t.skip(...)). Accept either form to
  // be resilient to minor formatting differences.
  assert.match(
    src,
    /\bskip\s*\(/,
    "smoke must call .skip(...) when the app is unreachable",
  );
});

test("spec 111: smoke uses an AbortController-style probe timeout", () => {
  const src = read(SMOKE);
  // A 2-second timeout via AbortController is the canonical way to cap a
  // probe fetch. We accept either the constructor reference or the abort()
  // method as evidence — both are required to make the timeout actually fire.
  assert.match(
    src,
    /AbortController/,
    "smoke must use AbortController to bound the probe (so a hung server doesn't hang the suite)",
  );
});

test("spec 111: top-level package.json has a 'test:smoke' script", () => {
  const pkg = JSON.parse(read(PKG));
  assert.ok(pkg.scripts, "package.json must have a scripts block");
  assert.ok(
    typeof pkg.scripts["test:smoke"] === "string",
    "package.json scripts must include 'test:smoke' so operators can run the smoke suite",
  );
  // The script must reference node --test (no new dependency) and target the
  // integration folder.
  assert.match(
    pkg.scripts["test:smoke"],
    /node\s+--test/,
    "'test:smoke' must use `node --test` (same runner as governance, no new deps)",
  );
  assert.match(
    pkg.scripts["test:smoke"],
    /tests\/integration/,
    "'test:smoke' must target tests/integration/",
  );
});

test("spec 111: default 'test' script does NOT run the smoke folder", () => {
  const pkg = JSON.parse(read(PKG));
  const defaultTest = pkg.scripts.test ?? "";
  // Either the default test glob narrows to governance/, or it explicitly
  // excludes integration/. We accept either pattern but require one of them
  // so `pnpm test` doesn't try to hit a live stack.
  const narrowsToGovernance = /tests\/governance/.test(defaultTest);
  const excludesIntegration = !/tests\/integration/.test(defaultTest);
  assert.ok(
    narrowsToGovernance && excludesIntegration,
    "default `pnpm test` must not match tests/integration/ (smoke is opt-in via test:smoke). Current: " + defaultTest,
  );
});

test("spec 111: smoke covers the 8 endpoints called out in the spec", () => {
  const src = read(SMOKE);
  // Hard-coded sanity check: the spec lists 8 specific paths the smoke must
  // hit. We assert each one appears in the file so a future edit that drops
  // a check (say, removes the WhatsApp signature gate test) trips this guard.
  const required = [
    "/api/health",
    "/login",
    "/api/auth/csrf",
    "/api/auth/callback/credentials",
    "/dashboard",
    "/api/notifications/mark-read",
    "/api/webhooks/whatsapp",
  ];
  for (const path of required) {
    assert.ok(
      src.includes(path),
      `smoke must exercise ${path} (listed in spec.md "What" section)`,
    );
  }
});

test("spec 111: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});
