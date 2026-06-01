import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ROUTE = "apps/web/src/app/(authenticated)/repo/page.tsx";

test("Spec 046: /repo route file exists", () => {
  assert.ok(existsSync(resolve(root, ROUTE)), `${ROUTE} must exist`);
});

test("Spec 046: route is a server component with force-dynamic", () => {
  const src = read(ROUTE);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.match(src, /export default async function/);
});

test("Spec 046: route imports the 8 entity tables + count from drizzle", () => {
  const src = read(ROUTE);
  assert.match(src, /import\s*\{\s*db\s*\}\s*from\s*"@gml\/db"/);
  for (const tbl of [
    "schools",
    "classes",
    "subjects",
    "courseOutlines",
    "sessions",
    "resources",
    "teachers",
    "mentors",
    "learners",
  ]) {
    assert.match(src, new RegExp(`\\b${tbl}\\b`), `must import/use ${tbl}`);
  }
  assert.match(src, /\bcount\b/);
  assert.match(src, /\bbetween\b/);
});

test("Spec 046: queries are run in parallel via Promise.all", () => {
  const src = read(ROUTE);
  assert.match(src, /Promise\.all\(/);
  // Should issue count() against every entity at least once.
  const m = src.match(/db\.select\(\{[^}]*count\(\)/g) ?? [];
  assert.ok(m.length >= 8, `expected >=8 count() calls, got ${m.length}`);
});

test("Spec 046: this-week sessions table queries scheduled_date with between()", () => {
  const src = read(ROUTE);
  assert.match(src, /between\(\s*sessions\.scheduledDate/);
  assert.match(src, /limit\(\s*8\s*\)/);
  assert.match(src, /leftJoin\(\s*schools/);
  assert.match(src, /leftJoin\(\s*subjects/);
});

test("Spec 046: renders the 5 stat labels from RepoHome JSX", () => {
  const src = read(ROUTE);
  for (const label of ["Schools", "Classes", "Subjects", "Sessions logged", "Resources"]) {
    assert.match(src, new RegExp(`label="${label}"`), `must render Stat "${label}"`);
  }
});

test("Spec 046: Browse sidebar lists all 8 entities with correct slugs", () => {
  const src = read(ROUTE);
  for (const slug of ["schools", "subjects", "outlines", "sessions", "teachers", "mentors", "learners", "resources"]) {
    assert.match(src, new RegExp(`id:\\s*"${slug}"`), `Browse must include slug "${slug}"`);
  }
  // Every Browse row is a Link to /repo/<slug>.
  assert.match(src, /href=\{`\/repo\/\$\{b\.id\}`\}/);
});

test("Spec 046: status pill mapping covers planned / in_progress / complete", () => {
  const src = read(ROUTE);
  for (const status of ["planned", "in_progress", "complete"]) {
    assert.match(src, new RegExp(`\\b${status}\\b\\s*:\\s*\\{`), `SESSION_STATUS must include ${status}`);
  }
});

test("Spec 046: typography + color tokens from globals.css are used (no hard-coded hex)", () => {
  const src = read(ROUTE);
  assert.match(src, /var\(--serif\)/);
  assert.match(src, /var\(--mono\)/);
  assert.match(src, /var\(--ink-3\)/);
  assert.match(src, /var\(--line\)/);
  assert.match(src, /var\(--r-3\)/);
  // No raw hex colors should leak in.
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(src), "route file must not contain hex colors (use CSS variables)");
});

test("Spec 046: spec-kit files exist", () => {
  for (const f of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(existsSync(resolve(root, `specs/046-repo-home/${f}`)), `specs/046-repo-home/${f} must exist`);
  }
});
