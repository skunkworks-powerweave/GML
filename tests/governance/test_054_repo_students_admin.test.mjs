import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ROUTE = "apps/web/src/app/(authenticated)/repo/students/page.tsx";

test("/repo/students route file exists", () => {
  assert.ok(existsSync(resolve(root, ROUTE)), `${ROUTE} must exist`);
});

test("route is a forced-dynamic server component", () => {
  const src = read(ROUTE);
  assert.match(src, /export const dynamic\s*=\s*["']force-dynamic["']/);
});

test("route role-gates to programme_admin + super_admin via requireRole", () => {
  const src = read(ROUTE);
  assert.match(src, /requireRole\(\s*\[\s*"programme_admin"\s*,\s*"super_admin"\s*\]\s*\)/);
});

test("route queries learners + classes + schools via Drizzle", () => {
  const src = read(ROUTE);
  // imports from the workspace package
  assert.match(src, /from\s+"@gml\/db"/);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  // tables used
  assert.match(src, /\blearners\b/);
  assert.match(src, /\bclasses\b/);
  assert.match(src, /\bschools\b/);
  // joins
  assert.match(src, /leftJoin\(\s*classes/);
  assert.match(src, /leftJoin\(\s*schools/);
  // pagination
  assert.match(src, /\.limit\(\s*(PAGE_SIZE|100)\s*\)/);
  assert.match(src, /\.offset\(/);
});

test("SM-9 audit hook fires on every render with action=learners.bulk_view", () => {
  const src = read(ROUTE);
  assert.match(src, /recordAudit/);
  assert.match(src, /action:\s*["']learners\.bulk_view["']/);
  assert.match(src, /entityType:\s*["']all["']/);
  assert.match(src, /piiAudited:\s*true/);
});

test("bulk CSV export is super_admin-only", () => {
  const src = read(ROUTE);
  // resolve admin flag from session role
  assert.match(src, /["']super_admin["']/);
  // export endpoint reference
  assert.match(src, /\/api\/admin\/learners\/export/);
  // gated by an admin/super-admin check
  assert.match(src, /isSuperAdmin/);
});

test("route renders the JSX prototype layout (PII warning + table columns)", () => {
  const src = read(ROUTE);
  // saffron-soft PII warning card
  assert.match(src, /var\(--saffron-soft\)/);
  assert.match(src, /Bulk export is audited/);
  // table column headers per JSX line 954
  for (const col of ["Name", "Class", "School", "Age", "Guardian", "Attendance"]) {
    assert.match(src, new RegExp(`>${col}<`));
  }
  // attendance >90 highlight per JSX line 966
  assert.match(src, /var\(--lichen\)/);
});

test("school filter + pagination read from searchParams", () => {
  const src = read(ROUTE);
  assert.match(src, /searchParams/);
  assert.match(src, /sp\.page/);
  assert.match(src, /sp\.school/);
});
