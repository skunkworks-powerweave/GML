import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("schema/learners.ts exports `learners` with PII columns + CHECKs", () => {
  const src = read("packages/db/src/schema/learners.ts");
  assert.match(src, /export const learners\b/);
  assert.match(src, /pgTable\(\s*"learners"/);
  // PII columns
  for (const col of ["name", "age", "guardian", "rollNumber", "section", "attendancePct"]) {
    assert.match(src, new RegExp(col), `learners must have ${col}`);
  }
  // CHECK constraints
  assert.match(src, /learners_grade_check/);
  assert.match(src, /learners_age_check/);
  assert.match(src, /learners_attendance_check/);
  // soft delete for PII compliance
  assert.match(src, /deletedAt/);
});

test("AdminEntity type has `piiAudited` flag", () => {
  const src = read("apps/web/src/admin/types.ts");
  assert.match(src, /piiAudited\?\s*:\s*boolean/);
});

test("learners entity is piiAudited and super_admin-only mutate", () => {
  const src = read("apps/web/src/admin/entities/learners.ts");
  assert.match(src, /piiAudited:\s*true/);
  assert.match(src, /mutateRoles:\s*\["super_admin"\]/);
});

test("SM-9 enforcement: admin page calls recordAudit when piiAudited", () => {
  const src = read("apps/web/src/app/admin/data/[entity]/page.tsx");
  assert.match(src, /piiAudited/);
  assert.match(src, /recordAudit/);
  assert.match(src, /\$\{entity\.slug\}\.view/);
});

test("registry registers learners at slug `learners`", () => {
  assert.match(read("apps/web/src/admin/registry.ts"), /learners:\s*learnersEntity/);
});

test("migration 0008 exists with learners CREATE TABLE", () => {
  const dir = resolve(root, "packages/db/src/migrations");
  const m = readdirSync(dir).find((f) => f.startsWith("0008_") && f.endsWith(".sql"));
  assert.ok(m, "0008_*.sql must exist");
  assert.match(readFileSync(resolve(dir, m), "utf8"), /CREATE TABLE "learners"/);
});
