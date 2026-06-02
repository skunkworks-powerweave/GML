// Governance test for spec 165 — CI/CD pipeline
// (Workflow Run 16 audit-closure BLOCKER).
//
// Files under audit:
//
//   1. .github/workflows/test.yml (CREATED)
//      — single GitHub Actions workflow `test-and-build`;
//        triggers on push to main + pull_request (any branch);
//        single ubuntu-latest job runs:
//          checkout → pnpm setup → node 22 (cache: pnpm) →
//          pnpm install --frozen-lockfile →
//          pnpm test → pnpm build → pnpm -r typecheck →
//          pnpm test:smoke || true.
//        Sets DATABASE_URL at the job env level so the build can
//        load packages/db/src/client.ts without crashing.
//
//   2. .github/workflows/README.md (CREATED)
//      — short note (under 10 lines) explaining what the workflow
//        gates and which spec authored it.
//
// Plus the five spec-kit files under specs/165-ci-cd-pipeline/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const WORKFLOW_PATH = ".github/workflows/test.yml";
const README_PATH = ".github/workflows/README.md";
const SPEC_DIR = "specs/165-ci-cd-pipeline";

// ---------- Spec-kit + plan.md contract ----------

test("spec 165 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the CI/CD pipeline spec`,
    );
  }
});

test("spec 165 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // The two touched files must be named in plan.md so a reader
  // auditing the contract knows where the surface area lives.
  for (const file of ["test.yml", "README.md"]) {
    assert.match(
      src,
      new RegExp(file),
      `plan.md must call out the ${file} touchpoint so the surface is discoverable`,
    );
  }
});

// ---------- (1) Workflow file exists + structural shape ----------

test("spec 165 — .github/workflows/test.yml exists", () => {
  assert.ok(
    existsSync(resolve(root, WORKFLOW_PATH)),
    `${WORKFLOW_PATH} must exist as the CI gate`,
  );
});

test("spec 165 — workflow is structurally parseable as YAML (key markers present)", () => {
  const src = read(WORKFLOW_PATH);
  // We don't pull in a YAML parser as a dep — instead we pin the
  // load-bearing structural keys with regex. If a future contributor
  // accidentally indents the file wrong or strips a required key,
  // these assertions catch the diff.
  assert.match(
    src,
    /^name:\s*test-and-build/m,
    "workflow must declare `name: test-and-build` at the top level so the PR check UI shows a self-documenting label",
  );
  assert.match(
    src,
    /^on:\s*$/m,
    "workflow must declare an `on:` top-level key for the trigger block",
  );
  assert.match(
    src,
    /^jobs:\s*$/m,
    "workflow must declare a `jobs:` top-level key for the job block",
  );
  assert.match(
    src,
    /runs-on:\s*ubuntu-latest/,
    "workflow job must declare `runs-on: ubuntu-latest` — the only supported CI runner per spec 165",
  );
});

// ---------- (2) Triggers cover push (main) + pull_request ----------

test("spec 165 — workflow triggers on both push (main) and pull_request", () => {
  const src = read(WORKFLOW_PATH);
  // The `push:` trigger with the main branch. Pin both segments so
  // a future contributor can't accidentally drop the branch filter
  // (which would make the workflow run on every push to every
  // branch — wasting CI minutes) or remove the trigger entirely.
  assert.match(
    src,
    /push:\s*\n\s*branches:\s*\[\s*main\s*\]/,
    "workflow must trigger on `push:` with `branches: [main]` so merges to main are gated",
  );
  // The `pull_request:` trigger. No branch filter is required —
  // pull_request implicitly covers all branches.
  assert.match(
    src,
    /pull_request:/,
    "workflow must trigger on `pull_request:` so PRs from any branch are gated before merge",
  );
});

// ---------- (3) Setup actions: pnpm + node with cache ----------

test("spec 165 — workflow uses pnpm/action-setup@v4 and actions/setup-node@v4", () => {
  const src = read(WORKFLOW_PATH);
  assert.match(
    src,
    /uses:\s*pnpm\/action-setup@v4/,
    "workflow must use `pnpm/action-setup@v4` so the pnpm version is auto-detected from the packageManager field in package.json",
  );
  assert.match(
    src,
    /uses:\s*actions\/setup-node@v4/,
    "workflow must use `actions/setup-node@v4` for Node 22 + pnpm caching",
  );
  assert.match(
    src,
    /uses:\s*actions\/checkout@v4/,
    "workflow must use `actions/checkout@v4` to pull the source before any other step",
  );
});

test("spec 165 — setup-node step declares cache: \"pnpm\" so dependency cache is restored", () => {
  const src = read(WORKFLOW_PATH);
  // The `cache: "pnpm"` (or unquoted `cache: pnpm`) input on the
  // setup-node step. Pin both shapes — YAML accepts either.
  assert.match(
    src,
    /cache:\s*["']?pnpm["']?/,
    "setup-node step must declare `cache: \"pnpm\"` so the pnpm store is restored across runs (saves ~30s per build)",
  );
  assert.match(
    src,
    /node-version:\s*22/,
    "setup-node step must declare `node-version: 22` to match the engines field in root package.json",
  );
});

// ---------- (4) Command steps: install + test + build + typecheck ----------

test("spec 165 — workflow runs pnpm install --frozen-lockfile", () => {
  const src = read(WORKFLOW_PATH);
  // The `--frozen-lockfile` flag is load-bearing for the
  // reproducibility gate — without it, pnpm would silently update
  // the lockfile if package.json drifted.
  assert.match(
    src,
    /pnpm\s+install\s+--frozen-lockfile/,
    "workflow must run `pnpm install --frozen-lockfile` so a stale lockfile fails the build instead of being silently fixed",
  );
});

test("spec 165 — workflow runs pnpm test, pnpm build, and pnpm -r typecheck", () => {
  const src = read(WORKFLOW_PATH);
  // Pin each of the four mandatory script invocations. Order is
  // not pinned here (a future spec could reorder) but presence is.
  assert.match(
    src,
    /pnpm\s+test\b/,
    "workflow must run `pnpm test` to exercise the 1423 governance assertions",
  );
  assert.match(
    src,
    /pnpm\s+build\b/,
    "workflow must run `pnpm build` to verify Next.js + worker compile cleanly",
  );
  assert.match(
    src,
    /pnpm\s+-r\s+typecheck/,
    "workflow must run `pnpm -r typecheck` to fan out tsc --noEmit across every workspace that declares the script",
  );
});

test("spec 165 — workflow runs pnpm test:smoke leniently (|| true)", () => {
  const src = read(WORKFLOW_PATH);
  // The `|| true` keeps the gate lenient when the Docker stack is
  // unreachable on the runner. The smoke tests themselves already
  // test.skip on connection refusal per spec 003, but `|| true` is
  // belt-and-suspenders for a runner with no Docker at all.
  assert.match(
    src,
    /pnpm\s+test:smoke\s*\|\|\s*true/,
    "workflow must run `pnpm test:smoke || true` — the smoke suite is opportunistic and shouldn't fail the gate when the Docker stack is unreachable on the runner",
  );
});

// ---------- (5) DATABASE_URL env so build doesn't crash ----------

test("spec 165 — workflow sets DATABASE_URL at the job env level for build-time client load", () => {
  const src = read(WORKFLOW_PATH);
  // The DATABASE_URL placeholder. Pin both the key and a literal
  // postgres:// prefix so a future contributor can't accidentally
  // delete the env block (which would re-introduce the build-time
  // crash that spec 143's build-safe fallback covers — explicit is
  // better than implicit on a fresh CI runner).
  assert.match(
    src,
    /DATABASE_URL:\s*postgres:\/\//,
    "workflow must set `DATABASE_URL: postgres://...` at the job env level so packages/db/src/client.ts loads its singleton without crashing during pnpm build",
  );
});

// ---------- (6) README ----------

test("spec 165 — .github/workflows/README.md exists and is short", () => {
  assert.ok(
    existsSync(resolve(root, README_PATH)),
    `${README_PATH} must exist explaining the gates`,
  );
  const src = read(README_PATH);
  const lines = src.split(/\r?\n/);
  assert.ok(
    lines.length < 15,
    `${README_PATH} must be short (under 15 lines) — it's a pointer note, not a manual`,
  );
  // The README must reference the spec number so a reader can
  // find the authoring context.
  assert.match(
    src,
    /Spec 165|spec 165/,
    `${README_PATH} must mention Spec 165 so a reader can locate the authoring spec`,
  );
});

// ---------- (7) No-regression / hygiene ----------

test("spec 165 — workflow file references no secrets (this gate runs without prod credentials)", () => {
  const src = read(WORKFLOW_PATH);
  // The CI gate is a build/test verifier — it does not touch any
  // real production database, S3 bucket, or queue. If a future
  // contributor adds a `secrets.X` reference, it should be
  // intentional and reviewed; pinning the absence here makes a
  // future addition a deliberate diff rather than a quiet slip.
  assert.ok(
    !/\$\{\{\s*secrets\./.test(src),
    `${WORKFLOW_PATH} must not reference any \${{ secrets.* }} — this CI gate runs only as a build/test verifier and does not need production credentials. A future deploy job spec can add a secrets-bearing job separately.`,
  );
});
