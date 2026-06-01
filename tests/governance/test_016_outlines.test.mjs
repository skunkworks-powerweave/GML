import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("schema/outlines.ts exports courseOutlines + outlineLessons", () => {
  const src = read("packages/db/src/schema/outlines.ts");
  assert.match(src, /export const courseOutlines\b/);
  assert.match(src, /export const outlineLessons\b/);
  assert.match(src, /pgTable\(\s*"course_outlines"/);
  assert.match(src, /pgTable\(\s*"outline_lessons"/);
  assert.match(src, /course_outlines_subject_grade_term_uq/);
  assert.match(src, /outline_lessons_outline_sequence_uq/);
  assert.match(src, /references\(\(\)\s*=>\s*subjects\.id/);
  assert.match(src, /references\(\(\)\s*=>\s*teachers\.id/);
  assert.match(src, /references\(\(\)\s*=>\s*courseOutlines\.id/);
});

test("schema/index.ts barrels outlines", () => {
  const src = read("packages/db/src/schema/index.ts");
  assert.match(src, /from\s+"\.\/outlines"/);
});

test("admin registry exposes course-outlines + outline-lessons slugs", () => {
  const src = read("apps/web/src/admin/registry.ts");
  assert.match(src, /"course-outlines"\s*:\s*courseOutlinesEntity/);
  assert.match(src, /"outline-lessons"\s*:\s*outlineLessonsEntity/);
});

test("migration 0004 exists with both CREATE TABLEs", () => {
  const dir = resolve(root, "packages/db/src/migrations");
  const files = readdirSync(dir);
  const m = files.find((f) => f.startsWith("0004_") && f.endsWith(".sql"));
  assert.ok(m, `0004_*.sql must exist`);
  const sql = readFileSync(resolve(dir, m), "utf8");
  assert.match(sql, /CREATE TABLE "course_outlines"/);
  assert.match(sql, /CREATE TABLE "outline_lessons"/);
});
