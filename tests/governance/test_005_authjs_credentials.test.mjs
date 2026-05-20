import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("apps/web declares auth deps", () => {
  const pkg = JSON.parse(read("apps/web/package.json"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(deps["next-auth"]);
  assert.ok(deps["@auth/drizzle-adapter"]);
  assert.ok(deps["bcryptjs"]);
  assert.ok(deps["ioredis"]);
  assert.ok(deps["@gml/db"]);
});

test("auth.ts wires Drizzle adapter + Credentials", () => {
  const src = read("apps/web/src/auth.ts");
  assert.match(src, /next-auth/);
  assert.match(src, /DrizzleAdapter/);
  assert.match(src, /Credentials/);
  assert.match(src, /jwt/);
});

test("[...nextauth] route exports GET + POST", () => {
  const src = read("apps/web/src/app/api/auth/[...nextauth]/route.ts");
  assert.match(src, /handlers/);
});

test("password.ts verifies bcrypt", () => {
  const src = read("apps/web/src/lib/password.ts");
  assert.match(src, /bcrypt/);
  assert.match(src, /compare/);
});

test("rate-limit.ts uses Redis sliding window", () => {
  const src = read("apps/web/src/lib/rate-limit.ts");
  assert.match(src, /ioredis|Redis/);
  assert.match(src, /ZADD|zadd|sliding|window/i);
});

test("login page + server action exist", () => {
  assert.ok(existsSync(resolve(root, "apps/web/src/app/login/page.tsx")));
  assert.ok(existsSync(resolve(root, "apps/web/src/app/login/actions.ts")));
});
