// Governance test for spec 047 — Repo schools (index + detail).
// Pins layout/DB-query/role-gate contracts so future refactors can't silently break the
// repository surface area.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const INDEX_PATH = "apps/web/src/app/(authenticated)/repo/schools/page.tsx";
const DETAIL_PATH = "apps/web/src/app/(authenticated)/repo/school/[id]/page.tsx";

test("both route files exist", () => {
  assert.ok(existsSync(resolve(root, INDEX_PATH)), `${INDEX_PATH} must exist`);
  assert.ok(existsSync(resolve(root, DETAIL_PATH)), `${DETAIL_PATH} must exist`);
});

test("both routes are server-rendered with force-dynamic", () => {
  for (const p of [INDEX_PATH, DETAIL_PATH]) {
    const src = read(p);
    assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/, `${p} must be force-dynamic`);
  }
});

test("both routes gate on read-roles via auth() + redirect('/forbidden')", () => {
  for (const p of [INDEX_PATH, DETAIL_PATH]) {
    const src = read(p);
    assert.match(src, /from\s+"@\/auth"/, `${p} must import auth`);
    assert.match(src, /await\s+auth\(\)/, `${p} must call auth()`);
    assert.match(src, /redirect\(\s*["']\/forbidden["']\s*\)/, `${p} must redirect on forbidden`);
    // Role allowlist must include the five expected roles.
    for (const role of ["super_admin", "programme_admin", "mentor", "observer", "teacher"]) {
      assert.match(src, new RegExp(`"${role}"`), `${p} must list role ${role}`);
    }
  }
});

test("schools index queries schools + zones + districts and aggregates counts", () => {
  const src = read(INDEX_PATH);
  assert.match(src, /from\s+"@gml\/db"/);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  // Imports must include the tables we join.
  for (const tbl of ["schools", "zones", "districts", "teachers", "classes", "sessions"]) {
    assert.match(src, new RegExp(`\\b${tbl}\\b`), `index must reference ${tbl}`);
  }
  // Aggregates must be correlated subqueries.
  assert.match(src, /teacher_counts/);
  assert.match(src, /class_counts/);
  assert.match(src, /session_counts/);
  // District filter must come from searchParams.
  assert.match(src, /searchParams/);
  assert.match(src, /district/);
});

test("schools index renders district filter pills (all / leh / kgl) with count badges", () => {
  const src = read(INDEX_PATH);
  for (const v of ['v:\\s*"all"', 'v:\\s*"leh"', 'v:\\s*"kgl"']) {
    assert.match(src, new RegExp(v), `filter tab ${v} missing`);
  }
  // Each tab is a <Link> rather than a client onClick handler (server-side filtering).
  assert.match(src, /\?district=/, "district filter must use ?district= searchParam href");
  assert.match(src, /<Link[\s\S]*?href=/, "filter tabs must render <Link> elements");
});

test("schools index table has the expected columns from prototype", () => {
  const src = read(INDEX_PATH);
  for (const col of ["Code", "Name", "Zone", "District", "Teachers", "Classes", "Sessions"]) {
    assert.match(src, new RegExp(`>\\s*${col}\\s*<`), `column ${col} missing from index header`);
  }
  // Detail link uses /repo/school/[id]
  assert.match(src, /\/repo\/school\/\$\{s\.id\}/);
});

test("school detail queries the per-school joins (school, classes, teachers, sessions)", () => {
  const src = read(DETAIL_PATH);
  assert.match(src, /from\s+"@gml\/db"/);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  for (const tbl of ["schools", "zones", "districts", "teachers", "classes", "sessions", "subjects"]) {
    assert.match(src, new RegExp(`\\b${tbl}\\b`), `detail must reference ${tbl}`);
  }
  // Detail uses notFound() when the row is missing.
  assert.match(src, /notFound\(\)/);
  // params is awaited (Next 15+ async param contract).
  assert.match(src, /await\s+params/);
});

test("school detail uses 1.6fr / 1fr two-column body grid (matches JSX prototype)", () => {
  const src = read(DETAIL_PATH);
  assert.match(src, /gridTemplateColumns:\s*["']1\.6fr 1fr["']/);
});

test("school detail renders Classes table with Grade/Stage/Students/Sections/Class teacher", () => {
  const src = read(DETAIL_PATH);
  for (const col of ["Grade", "Stage", "Students", "Sections", "Class teacher"]) {
    assert.match(src, new RegExp(`>\\s*${col}\\s*<`), `Classes column ${col} missing`);
  }
});

test("school detail renders Sessions table with Date/Time/Grade/Subject/Topic/Teacher/Status", () => {
  const src = read(DETAIL_PATH);
  for (const col of ["Date", "Time", "Grade", "Subject", "Topic", "Teacher", "Status"]) {
    assert.match(src, new RegExp(`>\\s*${col}\\s*<`), `Sessions column ${col} missing`);
  }
});

test("school detail Details KV card has the expected rows from prototype", () => {
  const src = read(DETAIL_PATH);
  for (const label of ["Code", "Zone", "District", "Teachers", "Classes", "Sessions logged", "Principal", "Onboarded"]) {
    assert.match(src, new RegExp(`label="${label}"`), `KV label "${label}" missing`);
  }
});

test("school detail Teachers sidebar renders Hindi name conditionally (SM-7)", () => {
  const src = read(DETAIL_PATH);
  // SM-7: Hindi name is always conditional and uses var(--deva).
  assert.match(src, /t\.hindiName\s*\?/);
  assert.match(src, /var\(--deva\)/);
});

test("school detail cross-links to /repo/school/[id]/learners", () => {
  const src = read(DETAIL_PATH);
  assert.match(src, /\/repo\/school\/\$\{school\.id\}\/learners/);
});

test("schools index uses district-aware chip colours (indigo for Leh, saffron for Kargil)", () => {
  const src = read(INDEX_PATH);
  assert.match(src, /var\(--indigo-soft\)/);
  assert.match(src, /var\(--saffron-soft\)/);
});

test("schools index renders the Repository label + serif h1 'Schools' + subtitle", () => {
  const src = read(INDEX_PATH);
  assert.match(src, />\s*Repository\s*</);
  assert.match(src, /fontFamily:\s*"var\(--serif\)"/);
  assert.match(src, />\s*Schools\s*</);
});
