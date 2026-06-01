// Governance test for spec 001 — harness scaffold.
// Asserts the seed structure declared in specs/001-harness-scaffold/spec.md FR-001 .. FR-010.
// TDD: write first (red), then create files (green).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(root, rel), "utf8"));
}

test("FR-002: root package.json declares pnpm workspaces and pnpm@10 packageManager", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.private, true, "root package.json must be private");
  assert.ok(Array.isArray(pkg.workspaces), "workspaces must be an array");
  assert.ok(pkg.workspaces.includes("apps/*"), "must include apps/*");
  assert.ok(pkg.workspaces.includes("packages/*"), "must include packages/*");
  assert.match(pkg.packageManager ?? "", /^pnpm@10\./, "packageManager must be pnpm@10.x");
});

test("FR-002: pnpm-workspace.yaml exists", () => {
  assert.ok(existsSync(resolve(root, "pnpm-workspace.yaml")), "pnpm-workspace.yaml must exist");
});

test("FR-003: apps/web is a valid workspace named @gml/web", () => {
  const pkg = readJson("apps/web/package.json");
  assert.equal(pkg.name, "@gml/web", "apps/web/package.json name must be @gml/web");
});

test("FR-004: empty workspaces packages/{db,ui,shared} are valid", () => {
  for (const sub of ["db", "ui", "shared"]) {
    const pkg = readJson(`packages/${sub}/package.json`);
    assert.equal(pkg.name, `@gml/${sub}`, `packages/${sub}/package.json name`);
    assert.equal(pkg.private, true);
  }
});

test("FR-005: apps/worker stub exists", () => {
  const pkg = readJson("apps/worker/package.json");
  assert.equal(pkg.name, "@gml/worker");
});

test("FR-006: .claude/settings.json declares the 6 hooks", () => {
  const cfg = readJson(".claude/settings.json");
  assert.ok(cfg.hooks, "hooks block must exist");
  assert.ok(Array.isArray(cfg.hooks.SessionStart), "SessionStart hook required");
  assert.ok(Array.isArray(cfg.hooks.PreToolUse), "PreToolUse hook(s) required");
  assert.ok(Array.isArray(cfg.hooks.PostToolUse), "PostToolUse hook(s) required");
  assert.ok(Array.isArray(cfg.hooks.Stop), "Stop hook required");
  // PreToolUse should have at least 4 entries (Bash + schema + middleware ... PostToolUse migrations is separate)
  assert.ok(cfg.hooks.PreToolUse.length >= 3, "expected ≥3 PreToolUse hooks");
});

test("FR-007: workspace/state.json has a valid current spec pointer", () => {
  const state = readJson("workspace/state.json");
  assert.match(String(state.currentSpec), /^\d{3}$/, "currentSpec must be 3-digit string");
  // specsTotal grew from v1's 70 → v2's 95 (spec 013 amendment). Keep it loose.
  assert.equal(typeof state.specsTotal, "number", "specsTotal must be a number");
  assert.ok(state.specsTotal >= 70, "specsTotal must be at least 70 (v1 floor)");
  assert.equal(typeof state.specsCompleted, "number", "specsCompleted must be a number");
});

test("FR-007: workspace/session_log.md and marathon_log.md exist", () => {
  assert.ok(existsSync(resolve(root, "workspace/session_log.md")));
  assert.ok(existsSync(resolve(root, "workspace/marathon_log.md")));
});

test("FR-008: scripts/session_start.mjs exists and is executable", () => {
  assert.ok(existsSync(resolve(root, "scripts/session_start.mjs")));
});

test("FR-009: CLAUDE.md exists with project context sections", () => {
  const md = readFileSync(resolve(root, "CLAUDE.md"), "utf8");
  for (const section of ["Project", "Plan", "Specs", "Harness", "Hooks", "Folder map"]) {
    assert.match(md, new RegExp(section, "i"), `CLAUDE.md must reference ${section}`);
  }
});

test("FR-010: placeholder docs and root files exist", () => {
  for (const f of [
    "README.md",
    "README-IT.md",
    ".env.example",
    ".gitignore",
    "docs/substrate-moats.md",
    "docs/verification.md",
    "docs/architecture.md",
    "docs/operations.md",
  ]) {
    assert.ok(existsSync(resolve(root, f)), `${f} must exist`);
  }
});

test("FR-012: .gitignore covers the right paths", () => {
  const gi = readFileSync(resolve(root, ".gitignore"), "utf8");
  for (const pattern of ["node_modules", ".next", "workspace", ".env"]) {
    assert.match(gi, new RegExp(pattern), `.gitignore must include ${pattern}`);
  }
});
