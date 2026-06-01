import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const INDEX = "apps/web/src/app/(authenticated)/repo/outlines/page.tsx";
const DETAIL = "apps/web/src/app/(authenticated)/repo/outline/[id]/page.tsx";

test("050 — repo outlines index route exists", () => {
  assert.ok(existsSync(resolve(root, INDEX)), `${INDEX} must exist`);
});

test("050 — repo outline detail route exists", () => {
  assert.ok(existsSync(resolve(root, DETAIL)), `${DETAIL} must exist`);
});

test("050 — index queries courseOutlines joined to subjects + teachers", () => {
  const src = read(INDEX);
  assert.match(src, /from\s+["']@gml\/db["']/);
  assert.match(src, /courseOutlines/);
  assert.match(src, /subjects/);
  assert.match(src, /teachers/);
  assert.match(src, /leftJoin\(\s*subjects/);
  assert.match(src, /leftJoin\(\s*teachers/);
  assert.match(src, /export\s+const\s+dynamic\s*=\s*"force-dynamic"/);
});

test("050 — index renders the JSX prototype's table columns + serif h1", () => {
  const src = read(INDEX);
  assert.match(src, /font-family:\s*"var\(--serif\)"|fontFamily:\s*"var\(--serif\)"/);
  assert.match(src, /Course outlines/);
  assert.match(src, /Outline/);
  assert.match(src, /Subject/);
  assert.match(src, /Grade/);
  assert.match(src, /Term/);
  assert.match(src, /Sessions/);
  assert.match(src, /Weeks/);
  assert.match(src, /Status/);
});

test("050 — status pill lookup covers all four schema-allowed states", () => {
  const src = read(INDEX);
  for (const state of ["planned", "in_progress", "complete", "archived"]) {
    assert.match(src, new RegExp(`(["']?)${state}\\1\\s*:\\s*\\{`), `index must map status "${state}"`);
  }
});

test("050 — detail page loads outline + lessons + sessions + readings", () => {
  const src = read(DETAIL);
  assert.match(src, /from\s+["']@gml\/db["']/);
  assert.match(src, /courseOutlines/);
  assert.match(src, /outlineLessons/);
  assert.match(src, /resources/);
  assert.match(src, /resourceSubjects/);
  assert.match(src, /sessions\s+as\s+classroomSessions|classroomSessions|\bsessions\b/);
  assert.match(src, /notFound\(\)/);
  assert.match(src, /asc\(outlineLessons\.sequence\)/);
  assert.match(src, /export\s+const\s+dynamic\s*=\s*"force-dynamic"/);
});

test("050 — detail renders learning outcomes, lessons table, sessions, details + readings sidebar", () => {
  const src = read(DETAIL);
  assert.match(src, /Learning outcomes/);
  assert.match(src, /Lessons \(/);
  assert.match(src, /Sessions delivered/);
  assert.match(src, /Details/);
  assert.match(src, /Reading material/);
  // Two-column grid 1.6fr / 1fr (matches JSX prototype)
  assert.match(src, /gridTemplateColumns:\s*"1\.6fr 1fr"/);
});

test("050 — Hindi name (SM-7) rendered with --deva font when present", () => {
  const idx = read(INDEX);
  const det = read(DETAIL);
  assert.match(idx, /var\(--deva\)/, "index must use Devanagari font for Hindi names");
  assert.match(det, /var\(--deva\)/, "detail must use Devanagari font for Hindi names");
  // Always conditional — never rendered when null
  assert.match(idx, /ownerHindi\s*\?/);
});

test("050 — no TODO/FIXME/placeholder strings in routes", () => {
  for (const path of [INDEX, DETAIL]) {
    const src = read(path);
    assert.doesNotMatch(src, /TODO|FIXME|XXX|placeholder/i, `${path} must be production-ready`);
  }
});
