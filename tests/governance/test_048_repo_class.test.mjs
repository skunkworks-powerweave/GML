import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const DETAIL = "apps/web/src/app/(authenticated)/repo/class/[id]/page.tsx";
const LEARNERS = "apps/web/src/app/(authenticated)/repo/class/[id]/learners/page.tsx";

test("Spec 048: repo class detail route file exists", () => {
  assert.ok(existsSync(resolve(root, DETAIL)), `${DETAIL} must exist`);
});

test("Spec 048: repo class learners sub-route file exists", () => {
  assert.ok(existsSync(resolve(root, LEARNERS)), `${LEARNERS} must exist`);
});

test("Spec 048: detail page is force-dynamic server component", () => {
  const src = read(DETAIL);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
});

test("Spec 048: detail page queries classes + schools + subjects + sessions + teachers", () => {
  const src = read(DETAIL);
  assert.match(src, /from\s+"@gml\/db"/);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  for (const t of ["classes", "schools", "subjects", "sessions", "teachers"]) {
    assert.match(src, new RegExp(`\\b${t}\\b`), `detail must reference ${t} table`);
  }
  // drizzle-orm helpers used
  assert.match(src, /from\s+"drizzle-orm"/);
  assert.match(src, /\beq\(/);
  assert.match(src, /\bdesc\(/);
});

test("Spec 048: detail page renders KV details and a 1.6fr / 1fr grid (matches JSX prototype)", () => {
  const src = read(DETAIL);
  assert.match(src, /gridTemplateColumns:\s*"1\.6fr 1fr"/);
  assert.match(src, /Class teacher/);
  assert.match(src, /Stage/);
  assert.match(src, /Sections/);
  assert.match(src, /Students/);
});

test("Spec 048: stage chip maps Primary/Middle/High to lichen/indigo/saffron", () => {
  const src = read(DETAIL);
  assert.match(src, /Primary.*var\(--lichen-soft\)/s);
  assert.match(src, /Middle.*var\(--indigo-soft\)/s);
  assert.match(src, /High.*var\(--saffron-soft\)/s);
});

test("Spec 048: Hindi name rendering uses --deva font and is conditional (SM-7)", () => {
  const src = read(DETAIL);
  assert.match(src, /teacherHindi/);
  assert.match(src, /var\(--deva\)/);
  assert.match(src, /s\.teacherHindi\s*\?/);
});

test("Spec 048: learners sub-route gates on role + super_admin + programme_admin (SM-9)", () => {
  const src = read(LEARNERS);
  assert.match(src, /requireRole\(\[\s*"super_admin"\s*,\s*"programme_admin"\s*\]\)/);
});

test("Spec 048: learners sub-route writes audit_log via recordAudit BEFORE the SELECT (SM-9)", () => {
  const src = read(LEARNERS);
  assert.match(src, /from\s+"@\/lib\/audit"/);
  assert.match(src, /recordAudit\(/);
  assert.match(src, /action:\s*"learners\.view"/);
  assert.match(src, /entityType:\s*"class"/);
  // Sanity: the recordAudit call appears before the learners SELECT in the source.
  const auditIdx = src.indexOf("recordAudit(");
  const selectIdx = src.indexOf(".from(learners)");
  assert.ok(auditIdx > -1 && selectIdx > -1, "both calls must be present");
  assert.ok(auditIdx < selectIdx, "audit must fire before the learners SELECT");
});

test("Spec 048: learners sub-route is force-dynamic + filters by classId and excludes soft-deleted rows", () => {
  const src = read(LEARNERS);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.match(src, /eq\(learners\.classId,\s*id\)/);
  assert.match(src, /isNull\(learners\.deletedAt\)/);
});

test("Spec 048: detail page conditionally renders 'View learners' link only for privileged roles", () => {
  const src = read(DETAIL);
  assert.match(src, /role === "super_admin"/);
  assert.match(src, /role === "programme_admin"/);
  assert.match(src, /\/repo\/class\/\$\{id\}\/learners/);
});
