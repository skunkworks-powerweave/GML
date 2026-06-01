import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("schema/resources.ts exports resources + resourceSubjects with constraints", () => {
  const src = read("packages/db/src/schema/resources.ts");
  assert.match(src, /export const resources\b/);
  assert.match(src, /export const resourceSubjects\b/);
  assert.match(src, /pgTable\(\s*"resources"/);
  assert.match(src, /pgTable\(\s*"resource_subjects"/);
  assert.match(src, /resources_kind_check/);
  assert.match(src, /resources_has_source_check/);
  assert.match(src, /primaryKey\(\{\s*columns:\s*\[t\.resourceId,\s*t\.subjectId\]/);
});

test("barrel + registry expose resources + resource-subjects slugs", () => {
  assert.match(read("packages/db/src/schema/index.ts"), /from\s+"\.\/resources"/);
  const reg = read("apps/web/src/admin/registry.ts");
  assert.match(reg, /resources:\s*resourcesEntity/);
  assert.match(reg, /"resource-subjects":\s*resourceSubjectsEntity/);
});

test("admin entity for resources requires at least one source (file_key or external_url)", () => {
  const src = read("apps/web/src/admin/entities/resources.ts");
  assert.match(src, /resource must have either a file_key or an external_url/);
});

test("migration 0007 exists with both resources tables", () => {
  const dir = resolve(root, "packages/db/src/migrations");
  const m = readdirSync(dir).find((f) => f.startsWith("0007_") && f.endsWith(".sql"));
  assert.ok(m, "0007_*.sql must exist");
  const sql = readFileSync(resolve(dir, m), "utf8");
  assert.match(sql, /CREATE TABLE "resources"/);
  assert.match(sql, /CREATE TABLE "resource_subjects"/);
});
