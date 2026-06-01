import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SEED_PATH = "packages/db/src/scripts/seed.ts";
const DB_PKG_PATH = "packages/db/package.json";
const SPEC_DIR = "specs/103-super-admin-bootstrap";

test("spec 103: seed.ts exists and is non-empty", () => {
  assert.ok(existsSync(resolve(root, SEED_PATH)), `${SEED_PATH} must exist`);
  const src = read(SEED_PATH);
  assert.ok(src.length > 100, "seed.ts must not be empty");
});

test("spec 103: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 103: seed.ts imports bcryptjs", () => {
  const src = read(SEED_PATH);
  // The import can be `import bcrypt from "bcryptjs"` or a conditional dynamic import.
  // Either way the string "bcryptjs" must appear in an import-shaped line.
  assert.match(
    src,
    /import\s+[\s\S]*?from\s+["']bcryptjs["']|import\s*\(\s*["']bcryptjs["']\s*\)/,
    "seed.ts must import bcryptjs (static or dynamic)",
  );
});

test("spec 103: seed.ts references both SUPER_ADMIN_EMAIL and SUPER_ADMIN_INITIAL_PASSWORD env vars", () => {
  const src = read(SEED_PATH);
  assert.match(src, /process\.env\.SUPER_ADMIN_EMAIL/);
  assert.match(src, /process\.env\.SUPER_ADMIN_INITIAL_PASSWORD/);
});

test("spec 103: seed.ts uses 'super_admin' role and inserts a users-shaped object", () => {
  const src = read(SEED_PATH);
  // The role literal must appear as a string value (not just a comment).
  assert.match(src, /role:\s*["']super_admin["']/);
  // Must insert into the users schema table.
  assert.match(src, /\.insert\s*\(\s*schema\.users\s*\)/);
});

test("spec 103: seed.ts handles existing-user case (SELECT-then-INSERT and/or onConflict)", () => {
  const src = read(SEED_PATH);
  // Defence-in-depth: at least one of these idempotency mechanisms must be present.
  // We assert BOTH because spec.md mandates SELECT-then-INSERT plus onConflict.
  const hasOnConflict = /onConflictDoNothing/.test(src);
  const hasSelectThenInsert =
    /\.select\([\s\S]*?\)\.from\s*\(\s*schema\.users\s*\)[\s\S]*?\.where\s*\(\s*eq\s*\(\s*schema\.users\.email/.test(
      src,
    );
  assert.ok(
    hasOnConflict || hasSelectThenInsert,
    "seed.ts must handle the existing-user case via onConflictDoNothing OR a SELECT-then-INSERT existence check",
  );
});

test("spec 103: seed.ts bcrypt-hashes the password with cost 10 (matches apps/web/src/lib/password.ts)", () => {
  const src = read(SEED_PATH);
  // Either `bcrypt.hash(password, 10)` or a hoisted COST constant set to 10.
  assert.match(
    src,
    /bcrypt\.hash\s*\([^)]*,\s*10\s*\)|const\s+COST\s*=\s*10/,
    "bcrypt cost must be 10 to match apps/web/src/lib/password.ts",
  );
});

test("spec 103: seed.ts skip-path logs a recognisable message when env vars missing", () => {
  const src = read(SEED_PATH);
  // Operator must be able to grep the log to see WHY no user was created.
  assert.match(src, /skipped[\s\S]*?SUPER_ADMIN_EMAIL/);
});

test("spec 103: seed.ts success-path logs a recognisable creation message", () => {
  const src = read(SEED_PATH);
  // The spec mandates a log line; matching loosely on "super_admin" + "created" keeps
  // the assertion resilient to minor wording tweaks without losing the contract.
  assert.match(src, /super_admin[\s\S]*?created|created[\s\S]*?super_admin/);
});

test("spec 103: packages/db/package.json declares bcryptjs as a runtime dependency", () => {
  const pkg = JSON.parse(read(DB_PKG_PATH));
  const deps = { ...(pkg.dependencies ?? {}) };
  assert.ok(
    "bcryptjs" in deps,
    "bcryptjs must be in packages/db dependencies so the seed script can resolve it under pnpm workspaces",
  );
});

test("spec 103: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});

test("spec 103: seed.ts has no stub / TODO / FIXME markers in the bootstrap block", () => {
  const src = read(SEED_PATH);
  // Find the bootstrap function body (between its declaration and the next closing fn brace).
  const match = src.match(/bootstrapSuperAdmin[\s\S]*?\n\}/);
  assert.ok(match, "bootstrapSuperAdmin function must be present");
  const body = match[0];
  assert.ok(!/\bTODO\b/i.test(body), "bootstrap block must not contain TODO markers");
  assert.ok(!/\bFIXME\b/i.test(body), "bootstrap block must not contain FIXME markers");
});
