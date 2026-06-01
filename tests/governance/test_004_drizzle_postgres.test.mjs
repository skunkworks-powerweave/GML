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

test("schema/identity.ts has Auth.js v5 tables", () => {
  const src = read("packages/db/src/schema/identity.ts");
  for (const t of ["users", "accounts", "verificationTokens"]) {
    assert.match(src, new RegExp(`export const ${t}`), `${t} must be exported`);
  }
  // v2 (spec 017): the Auth.js session table is exported as either `sessions` (v1) or
  // `authSessions` (v2 — bare `sessions` name freed for the classroom-sessions module).
  assert.ok(
    /export const (sessions|authSessions)\b/.test(src),
    "Auth.js session table must be exported as `sessions` or `authSessions`",
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
