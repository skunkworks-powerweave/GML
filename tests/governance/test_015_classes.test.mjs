import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("schema/classes.ts exports `classes` Drizzle table", () => {
  const src = read("packages/db/src/schema/classes.ts");
  assert.match(src, /export const classes\b/);
  assert.match(src, /pgTable\(\s*"classes"/);
  // FK to schools + UNIQUE (school_id, grade)
  assert.match(src, /references\(\(\)\s*=>\s*schools\.id/);
  assert.match(src, /classes_school_grade_uq/);
  // CHECK 1..12
  assert.match(src, /classes_grade_check/);
});

test("schema/index.ts barrels classes", () => {
  const src = read("packages/db/src/schema/index.ts");
  assert.match(src, /from\s+"\.\/classes"/);
});

test("admin registry exposes `classes` slug bound to classesEntity", () => {
  const src = read("apps/web/src/admin/registry.ts");
  assert.match(src, /from\s+"\.\/entities\/classes"/);
  assert.match(src, /classes:\s*classesEntity/);
});

test("migration 0003 exists with `classes` CREATE TABLE", () => {
  const dir = resolve(root, "packages/db/src/migrations");
  const files = readdirSync(dir);
  const m = files.find((f) => f.startsWith("0003_") && f.endsWith(".sql"));
  assert.ok(m, `0003_*.sql must exist`);
  const sql = readFileSync(resolve(dir, m), "utf8");
  assert.match(sql, /CREATE TABLE "classes"/);
});
