import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("@gml/db deps include drizzle-orm and pg", () => {
  const pkg = JSON.parse(read("packages/db/package.json"));
  assert.ok(pkg.dependencies?.["drizzle-orm"]);
  assert.ok(pkg.dependencies?.["pg"]);
  assert.ok(pkg.devDependencies?.["drizzle-kit"]);
});

test("drizzle.config.ts points at schema and migrations", () => {
  const cfg = read("packages/db/drizzle.config.ts");
  assert.match(cfg, /dialect:\s*['"]postgresql['"]/);
  assert.match(cfg, /schema:/);
  assert.match(cfg, /migrations/);
});

test("schema/enums.ts exports roleEnum with 5 roles", () => {
  const src = read("packages/db/src/schema/enums.ts");
  assert.match(src, /roleEnum/);
  for (const r of ["super_admin", "programme_admin", "mentor", "observer", "teacher"]) {
    assert.match(src, new RegExp(`['"]${r}['"]`), `roleEnum must include ${r}`);
  }
});

test("schema/identity.ts declares users as a Supabase-keyed profile table", () => {
  const src = read("packages/db/src/schema/identity.ts");
  assert.match(src, /export const users\b/, "users must be exported");

  // The Auth.js adapter tables are gone. accounts / auth_sessions /
  // verification_tokens were already INERT under `session: { strategy: "jwt" }`
  // -- the adapter wrote to them and nothing ever read them back -- and
  // password_reset_tokens backed a flow that bcrypt-scanned every live token on
  // an unthrottled endpoint. All four are dropped by _post/003.
  for (const gone of ["accounts", "authSessions", "verificationTokens", "passwordResetTokens"]) {
    assert.ok(
      !new RegExp(`export const ${gone}\b`).test(src),
      `${gone} must not be exported — Supabase Auth owns identity now`,
    );
  }

  // No .defaultRandom() on the primary key. 19 foreign keys point at
  // public.users(id) and none are ON UPDATE CASCADE, so the uuid has to be
  // adopted from auth.users rather than generated here; generating one would
  // orphan the profile from the auth record it mirrors.
  assert.match(
    src,
    /id:\s*uuid\("id"\)\.primaryKey\(\)\s*,/,
    "users.id must have no default — the id comes from auth.users (see _post/003)",
  );
});

test("client.ts creates a pg Pool + drizzle client", () => {
  const src = read("packages/db/src/client.ts");
  assert.match(src, /from\s+['"]pg['"]/);
  assert.match(src, /drizzle/);
  assert.match(src, /DATABASE_URL/);
});

test("migrator script exists", () => {
  assert.ok(existsSync(resolve(root, "packages/db/scripts/migrate.ts")));
});

test("index.ts barrel re-exports", () => {
  const src = read("packages/db/src/index.ts");
  assert.match(src, /export/);
  assert.match(src, /schema/);
});
