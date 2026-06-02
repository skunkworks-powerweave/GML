import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const WORKER_PATH = "apps/worker/src/index.ts";
const WORKER_QUEUES_PATH = "apps/worker/src/queues.ts";
const RETENTION_PATH = "packages/db/src/scripts/retention.ts";
const DB_BARREL_PATH = "packages/db/src/index.ts";
const SPEC_DIR = "specs/107-sm8-retention-cron";

test("spec 107: all five spec-kit files present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 107: a Queue named 'retention' is constructed in the worker package", () => {
  // Producer queue construction moved to queues.ts (split from index.ts) so the
  // web app can import producers without dragging in the Worker bootstrap.
  const src = read(WORKER_QUEUES_PATH);
  assert.match(
    src,
    /new\s+Queue\s*(?:<[^>]*>)?\s*\(\s*["']retention["']/,
    "apps/worker/src/queues.ts must construct new Queue('retention', ...)",
  );
});

test("spec 107: worker defines a Worker for the 'retention' queue", () => {
  const src = read(WORKER_PATH);
  assert.match(
    src,
    /new\s+Worker\s*(?:<[^>]*>)?\s*\(\s*["']retention["']/,
    "apps/worker/src/index.ts must construct new Worker('retention', ...)",
  );
});

test("spec 107: worker schedules the retention job with cron '0 3 * * *'", () => {
  const src = read(WORKER_PATH);
  assert.match(
    src,
    /cron\s*:\s*["']0\s+3\s+\*\s+\*\s+\*["']/,
    "apps/worker/src/index.ts must reference cron '0 3 * * *'",
  );
});

test("spec 107: worker uses fixed jobId 'retention:nightly' for the repeat schedule", () => {
  const src = read(WORKER_PATH);
  assert.match(
    src,
    /jobId\s*:\s*["']retention:nightly["']/,
    "apps/worker/src/index.ts must pin the repeat schedule under jobId 'retention:nightly'",
  );
});

test("spec 107: worker enqueues a 'deleteOldNotifications' job", () => {
  const src = read(WORKER_PATH);
  assert.match(
    src,
    /\.add\s*\(\s*["']deleteOldNotifications["']/,
    "apps/worker/src/index.ts must add a job named 'deleteOldNotifications' to the retention queue",
  );
});

test("spec 107: worker imports deleteOldNotifications from @gml/db", () => {
  const src = read(WORKER_PATH);
  assert.match(
    src,
    /import\s*\{[^}]*\bdeleteOldNotifications\b[^}]*\}\s*from\s*["']@gml\/db(?:\/scripts\/retention)?["']/,
    "apps/worker/src/index.ts must import deleteOldNotifications from @gml/db (root or /scripts/retention subpath)",
  );
});

test("spec 107: retention.ts exports deleteOldNotifications", () => {
  const src = read(RETENTION_PATH);
  assert.match(
    src,
    /export\s+async\s+function\s+deleteOldNotifications\b/,
    "packages/db/src/scripts/retention.ts must export an async function 'deleteOldNotifications'",
  );
});

test("spec 107: retention.ts preserves the SM-8 90-day retention contract", () => {
  const src = read(RETENTION_PATH);
  assert.match(src, /RETAIN_DAYS\s*=\s*90/);
  assert.match(src, /db\.delete\(notifications\)/);
  assert.match(src, /lt\(notifications\.createdAt/);
});

test("spec 107: retention.ts CLI entry point is guarded so imports don't auto-run", () => {
  const src = read(RETENTION_PATH);
  assert.match(
    src,
    // Allow other node:url imports alongside (spec 163 added fileURLToPath
    // for the basename-fallback in isDirectInvocation).
    /import\s*\{[^}]*\bpathToFileURL\b[^}]*\}\s*from\s*["']node:url["']/,
    "retention.ts must import pathToFileURL from node:url (other named imports OK)",
  );
  assert.match(
    src,
    /import\.meta\.url\s*===\s*pathToFileURL\(/,
    "retention.ts must guard auto-run with import.meta.url === pathToFileURL(...)",
  );
});

test("spec 107: db barrel does NOT re-export retention (would drag CLI code into web bundles)", () => {
  // Reverted in the build-stability follow-up: re-exporting retention.ts from
  // the @gml/db barrel pulled the CLI (process.exit guard + node:url import)
  // into every web-side import path that touched @gml/db, breaking
  // `next build`. Worker now imports via the explicit subpath
  // `@gml/db/scripts/retention`.
  const src = read(DB_BARREL_PATH);
  assert.ok(
    !/export\s*\{[^}]*\bdeleteOldNotifications\b[^}]*\}/.test(src),
    "packages/db/src/index.ts must NOT re-export deleteOldNotifications (use subpath @gml/db/scripts/retention)",
  );
});

test("spec 107: retention.ts uses the correct schema import path (no '../src/schema' typo)", () => {
  const src = read(RETENTION_PATH);
  assert.ok(
    !/from\s*["']\.\.\/src\/schema\//.test(src),
    "retention.ts must not import from '../src/schema/...' (that resolves to packages/db/src/src/...)",
  );
  assert.match(
    src,
    /from\s*["']\.\.\/schema\/notifications["']/,
    "retention.ts must import notifications from '../schema/notifications'",
  );
});

test("spec 107: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});
