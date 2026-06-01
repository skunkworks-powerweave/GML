import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("admin registry exists with ADMIN_ENTITIES export", () => {
  const src = read("apps/web/src/admin/registry.ts");
  assert.match(src, /ADMIN_ENTITIES/);
});

test("admin/data/[entity] route exists", () => {
  assert.ok(existsSync(resolve(root, "apps/web/src/app/admin/data/[entity]/page.tsx")));
  assert.ok(existsSync(resolve(root, "apps/web/src/app/admin/data/[entity]/actions.ts")));
});

test("admin actions use withAudit", () => {
  const src = read("apps/web/src/app/admin/data/[entity]/actions.ts");
  assert.match(src, /withAudit/);
});

test("admin index page exists", () => {
  assert.ok(existsSync(resolve(root, "apps/web/src/app/admin/page.tsx")));
});
