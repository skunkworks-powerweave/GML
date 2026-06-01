// Spec 049 — Repository · Subjects (index + detail).
// Asserts both route files exist, are server components, use force-dynamic,
// pull from the production Drizzle schema, and render the JSX-equivalent UI
// strings ported from `repository.jsx` (RepoSubjectsIndex + RepoSubjectPage).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const INDEX = "apps/web/src/app/(authenticated)/repo/subjects/page.tsx";
const DETAIL = "apps/web/src/app/(authenticated)/repo/subject/[id]/page.tsx";

test("spec 049 — both route files exist", () => {
  assert.ok(existsSync(resolve(root, INDEX)), `${INDEX} must exist`);
  assert.ok(existsSync(resolve(root, DETAIL)), `${DETAIL} must exist`);
});

test("spec 049 — both routes are force-dynamic server components", () => {
  for (const p of [INDEX, DETAIL]) {
    const src = read(p);
    assert.match(src, /export const dynamic\s*=\s*["']force-dynamic["']/, `${p} must force-dynamic`);
    assert.ok(!/"use client"/.test(src), `${p} must NOT be a client component`);
    assert.match(src, /from\s+["']@\/auth["']/, `${p} must call auth() from @/auth`);
    assert.match(src, /redirect\(["']\/login["']\)/, `${p} must redirect unauth users to /login`);
  }
});

test("spec 049 — index queries subjects + roll-up counts via Drizzle", () => {
  const src = read(INDEX);
  // Schema imports.
  assert.match(src, /from\s+["']@gml\/db["']/);
  assert.match(src, /from\s+["']@gml\/db\/schema["']/);
  for (const tbl of ["subjects", "courseOutlines", "sessions", "resourceSubjects"]) {
    assert.match(src, new RegExp(`\\b${tbl}\\b`), `must reference ${tbl} table`);
  }
  // Aggregates per JSX line 461-464.
  assert.match(src, /COUNT\(\*\)/i, "must compute roll-up counts");
  // Reflects the JSX hero copy.
  assert.match(src, /Subjects/);
  assert.match(src, /Grades 1[–-]10/);
});

test("spec 049 — index renders Subject/Grades/Outlines/Sessions/Readings columns", () => {
  const src = read(INDEX);
  for (const col of ["Subject", "Grades", "Outlines", "Sessions", "Readings"]) {
    assert.match(src, new RegExp(`["']${col}["']`), `index must render the "${col}" column header`);
  }
  // Mono dates / grades cell per JSX:470.
  assert.match(src, /var\(--mono\)/);
  // Links from each row → /repo/subject/${id}.
  assert.match(src, /\/repo\/subject\//);
});

test("spec 049 — detail queries outlines + sessions + readings + teachers", () => {
  const src = read(DETAIL);
  for (const tbl of [
    "subjects",
    "courseOutlines",
    "sessions",
    "resources",
    "resourceSubjects",
    "teachers",
    "schools",
    "classes",
  ]) {
    assert.match(src, new RegExp(`\\b${tbl}\\b`), `detail must reference ${tbl}`);
  }
  assert.match(src, /notFound\(\)/, "detail must call notFound() when subject missing");
  assert.match(src, /params:\s*Promise<\{\s*id:\s*string\s*\}>/, "detail must accept async params");
});

test("spec 049 — detail renders the 4-stat strip + 3 section cards (JSX:508-557)", () => {
  const src = read(DETAIL);
  // Stat tiles.
  for (const stat of ["Grades covered", "Course outlines", "Sessions", "Readings"]) {
    assert.match(src, new RegExp(stat), `detail must render Stat "${stat}"`);
  }
  // Section cards.
  assert.match(src, /Course outlines/);
  assert.match(src, /Recent sessions/);
  assert.match(src, /Reading material/);
  // Outline status chip mapping per JSX:527.
  assert.match(src, /In progress/);
  assert.match(src, /Complete/);
  // Back link.
  assert.match(src, /← Subjects/);
});

test("spec 049 — detail respects SM-7 (Hindi name optional, deva font only when present)", () => {
  const src = read(DETAIL);
  assert.match(src, /var\(--deva\)/, "detail must use Devanagari font for Hindi names");
  // Conditional rendering — `hindiName ? ... : null` pattern (Hindi NEVER unconditionally rendered).
  assert.match(src, /hindiName\s*\?/);
});

test("spec 049 — detail uses serif heading + mono date/code cells (visual fidelity)", () => {
  const src = read(DETAIL);
  assert.match(src, /font-family:\s*var\(--serif\)|fontFamily:\s*["']var\(--serif\)["']/);
  assert.match(src, /var\(--mono\)/);
});

test("spec 049 — no PII audit hook needed (curriculum side, not roster/learner)", () => {
  // Negative assertion: spec 049 is curriculum, NOT spec 048 (class roster) or
  // spec 054 (learner detail) — must not import recordAudit unnecessarily.
  // (We're not asserting absence; just confirming that if recordAudit is referenced
  // it's intentional. For now: zero references is the expected state.)
  const src = read(DETAIL);
  if (/recordAudit/.test(src)) {
    assert.fail("spec 049 should not call recordAudit — non-PII curriculum surface");
  }
});
