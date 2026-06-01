import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("schema/subjects.ts exports curriculum `subjects` Drizzle table", () => {
  const src = read("packages/db/src/schema/subjects.ts");
  assert.match(src, /export const subjects\b/);
  assert.match(src, /pgTable\(\s*"subjects"/);
  // Required + unique columns
  assert.match(src, /name.*\.notNull\(\)\.unique\(\)/s);
  assert.match(src, /code.*\.notNull\(\)\.unique\(\)/s);
  // CHECK constraints for grade range
  assert.match(src, /subjects_grades_min_check/);
  assert.match(src, /subjects_grades_max_check/);
  assert.match(src, /subjects_grades_min_le_max_check/);
});

test("schema/index.ts barrels subjects", () => {
  const src = read("packages/db/src/schema/index.ts");
  assert.match(src, /from\s+"\.\/subjects"/);
});

test("admin registry has curriculum `subjects` entity at slug `subjects`", () => {
  const src = read("apps/web/src/admin/registry.ts");
  assert.match(src, /from\s+"\.\/entities\/subjects"/);
  assert.match(src, /subjects:\s*subjectsEntity/);
});

test("admin entity has uppercase-code validator + grades cross-check", () => {
  const src = read("apps/web/src/admin/entities/subjects.ts");
  assert.match(src, /\[A-Z\]\[A-Z0-9_-\]\*/);
  assert.match(src, /grades_min must be ≤ grades_max/);
});

test("migration 0002 exists with `subjects` CREATE TABLE", () => {
  const dir = resolve(root, "packages/db/src/migrations");
  const files = readdirSync(dir);
  const m = files.find((f) => f.startsWith("0002_") && f.endsWith(".sql"));
  assert.ok(m, `0002_*.sql must exist; found: ${files.filter((f) => f.endsWith(".sql")).join(", ")}`);
  const sql = readFileSync(resolve(dir, m), "utf8");
  assert.match(sql, /CREATE TABLE "subjects"/);
});
