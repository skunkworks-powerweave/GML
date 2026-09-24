// Spec 052 — Repository: Teachers index + drill-in.
// Asserts route files exist, hit the right tables, gate on role, and respect SM-7.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const INDEX_PATH = "apps/web/src/app/(authenticated)/repo/teachers/page.tsx";
const DETAIL_PATH = "apps/web/src/app/(authenticated)/repo/teacher/[id]/page.tsx";

test("052: both repo/teachers routes exist", () => {
  assert.ok(existsSync(resolve(root, INDEX_PATH)), `${INDEX_PATH} must exist`);
  assert.ok(existsSync(resolve(root, DETAIL_PATH)), `${DETAIL_PATH} must exist`);
});

test("052: index route is a force-dynamic server component", () => {
  const src = read(INDEX_PATH);
  assert.match(src, /export const dynamic = "force-dynamic"/);
  assert.match(src, /export default async function/);
});

test("052: detail route is a force-dynamic server component with awaited params", () => {
  const src = read(DETAIL_PATH);
  assert.match(src, /export const dynamic = "force-dynamic"/);
  assert.match(src, /export default async function/);
  assert.match(src, /params: Promise<\{ id: string \}>/);
  assert.match(src, /await params/);
});

test("052: both routes auth-gate via auth() with role check + /forbidden redirect", () => {
  for (const p of [INDEX_PATH, DETAIL_PATH]) {
    const src = read(p);
    assert.match(src, /from "@\/auth"/, `${p} must import auth from @/auth`);
    assert.match(src, /await auth\(\)/, `${p} must call auth()`);
    assert.match(src, /redirect\("\/forbidden"\)/, `${p} must redirect on forbidden role`);
  }
});

test("052: index pulls teachers joined to schools + phases + session/cycle counts", () => {
  const src = read(INDEX_PATH);
  assert.match(src, /from "@gml\/db"/);
  assert.match(src, /from "@gml\/db\/schema"/);
  // Tables referenced
  assert.match(src, /\bteachers\b/);
  assert.match(src, /\bschools\b/);
  assert.match(src, /\bphases\b/);
  assert.match(src, /sessions as classroomSessions/);
  // The cycle count is observation data. It used to be a subquery over
  // observationCycles written here, unscoped, so the directory showed every
  // colleague's observation count to every signed-in user. It must be the
  // scoped subquery from lib/gated-reads, joined like the session count.
  assert.match(src, /cycleCountsByTeacher\(\s*db\s*,\s*observation\s*\)/);
  assert.match(src, /leftJoin\(\s*cycleCounts\s*,/);
  // Joins + aggregation
  assert.match(src, /leftJoin\(schools/);
  assert.match(src, /leftJoin\(phases/);
  assert.match(src, /\.groupBy\(/);
});

test("052: detail route fetches teacher + school/zone + phase + sessions + cycles + pairing", () => {
  const src = read(DETAIL_PATH);
  // Imports -- the directory tables, read directly.
  for (const t of [
    "teachers",
    "schools",
    "zones",
    "phases",
    "sessions as classroomSessions",
    "subjects",
    "classes",
  ]) {
    assert.match(src, new RegExp(t.replace("[", "\\[")), `detail must import ${t}`);
  }
  // The cycles and the pairing are GATED rows. This test used to require the
  // page to import observationCycles / mentorPairings / mentors and select them
  // itself -- which is exactly how it served every teacher's observation
  // history and mentor to every signed-in user, with no section gate and no
  // visibility predicate. They must come through lib/gated-reads under the
  // viewer's section access instead; tests/behaviour/access-control.test.ts
  // executes those reads, tests/governance/test_security_access_wiring pins
  // that nothing here selects the tables directly.
  assert.match(src, /teacherCycleHistory\(\s*db\s*,\s*observation\s*,/);
  assert.match(src, /teacherPairingHistory\(\s*db\s*,\s*mentorship\s*,/);
  assert.match(src, /observationAccess\(\s*db\s*,\s*actor\s*\)/);
  assert.match(src, /mentorshipAccess\(\s*db\s*,\s*actor\s*\)/);
  // notFound on missing teacher
  assert.match(src, /notFound\(\)/);
  // Section headings
  assert.match(src, /Sessions taught/);
  assert.match(src, /Mentor pairing/);
  assert.match(src, /Recent observation cycles/);
  // Cross-links to existing routes
  assert.match(src, /\/mentorship\/\$\{/);
  assert.match(src, /\/observation\/\$\{/);
});

test("052: SM-7 — Hindi name rendered with var(--deva) ONLY when present", () => {
  for (const p of [INDEX_PATH, DETAIL_PATH]) {
    const src = read(p);
    assert.match(src, /var\(--deva\)/, `${p} must use Devanagari font for Hindi name`);
    assert.match(
      src,
      /hindiName\s*\?/,
      `${p} must guard Hindi-name render on a truthy check (SM-7 NULLABLE)`,
    );
  }
});

test("052: uses CSS-variable design tokens (no hardcoded hex)", () => {
  for (const p of [INDEX_PATH, DETAIL_PATH]) {
    const src = read(p);
    // Hex color literals would suggest the prototype's `style={{ color: "#..." }}`
    // pattern slipped through instead of using `var(--ink-3)` etc.
    assert.doesNotMatch(src, /:\s*"#[0-9a-fA-F]{3,8}"/, `${p} must not use hex colors`);
    assert.match(src, /var\(--serif\)/, `${p} must use serif H1`);
    assert.match(src, /var\(--mono\)/, `${p} must use mono for codes/numbers`);
  }
});
