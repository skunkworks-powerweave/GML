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

test("spec 103: the bootstrap creates the credential in Supabase Auth first", () => {
  const src = read(SEED_PATH);

  // This can no longer be a single INSERT. The credential lives in auth.users,
  // the profile lives in public.users, and the uuid must be the SAME on both
  // sides -- 19 foreign keys point at public.users(id) and none are
  // ON UPDATE CASCADE, so generating an id here would orphan every audit row,
  // form draft, quiz attempt and video submission the account ever produced.
  // auth.users is written first and its id is adopted, never the reverse.
  assert.match(
    src,
    /auth\.admin\.createUser\(/,
    "the super-admin credential must be minted through the Supabase admin API",
  );
  assert.match(
    src,
    /email_confirm:\s*true/,
    "email_confirm: true is not optional — without it GoTrue treats the address " +
      "as unverified and refuses password sign-in, so the account exists, looks " +
      "correct in the dashboard, and simply does not work",
  );
  assert.match(src, /'super_admin'|"super_admin"/, "the profile must be promoted to super_admin");
});

test("spec 103: the bootstrap promotes the trigger-created profile rather than racing it", () => {
  const src = read(SEED_PATH);
  // on_auth_user_created writes the profile as an INACTIVE teacher the instant
  // the auth row lands. The bootstrap's job is to promote that row, so the
  // write has to tolerate its existence.
  assert.match(
    src,
    /ON\s+CONFLICT\s*\(\s*id\s*\)\s*DO\s+UPDATE/i,
    "the profile write must be an upsert on id — the trigger has already " +
      "inserted the row by the time this runs",
  );
  assert.match(
    src,
    /active\s*=\s*true/i,
    "promotion must activate the profile, or the access-token hook refuses to " +
      "mint a token and nobody can sign in",
  );
});

test("spec 103: the bootstrap is idempotent and never rotates a live password", () => {
  const src = read(SEED_PATH);
  assert.match(
    src,
    /FROM\s+auth\.users\s+WHERE\s+lower\(email\)/i,
    "an existing auth user must be detected before createUser is attempted, so " +
      "re-running the seed is a no-op rather than an error",
  );
  assert.ok(
    !/updateUserById|admin\.updateUser/.test(src),
    "re-running the seed must not reset the password of a live account — " +
      "rotation is a deliberate admin action, not a deploy side effect",
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
