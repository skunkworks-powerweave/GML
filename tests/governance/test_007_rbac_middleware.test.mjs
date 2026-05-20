import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("middleware.ts exists and uses Auth.js auth() + route matcher", () => {
  const src = read("apps/web/src/middleware.ts");
  assert.match(src, /export\s+default\s+auth\(/, "must export default auth(handler) — Auth.js v5 pattern");
  assert.match(src, /matcher/, "must declare matcher config");
});

test("guards.tsx exports Guarded + requireRole", () => {
  const src = read("apps/web/src/lib/guards.tsx");
  assert.match(src, /requireRole/);
  assert.match(src, /Guarded/);
});

test("shared roles.ts has ROLE_RANK and hasRole", () => {
  const src = read("packages/shared/src/auth/roles.ts");
  assert.match(src, /ROLE_RANK/);
  assert.match(src, /hasRole/);
  for (const r of ["super_admin", "programme_admin", "mentor", "observer", "teacher"]) {
    assert.match(src, new RegExp(r));
  }
});

test("forbidden page exists", () => {
  assert.ok(existsSync(resolve(root, "apps/web/src/app/forbidden/page.tsx")));
});

test("dashboard page exists", () => {
  assert.ok(existsSync(resolve(root, "apps/web/src/app/dashboard/page.tsx")));
});
