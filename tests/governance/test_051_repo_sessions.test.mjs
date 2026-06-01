import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const INDEX = "apps/web/src/app/(authenticated)/repo/sessions/page.tsx";
const DETAIL = "apps/web/src/app/(authenticated)/repo/session/[id]/page.tsx";

test("spec 051 — repo sessions index route exists", () => {
  assert.ok(existsSync(resolve(root, INDEX)), `${INDEX} must exist`);
});

test("spec 051 — repo session detail route exists", () => {
  assert.ok(existsSync(resolve(root, DETAIL)), `${DETAIL} must exist`);
});

test("spec 051 — index queries sessions + joins schools, classes, subjects, teachers", () => {
  const src = read(INDEX);
  assert.match(src, /from\s*\(\s*sessions\s*\)/, "must query sessions table");
  assert.match(src, /leftJoin\s*\(\s*schools\b/, "must left-join schools");
  assert.match(src, /leftJoin\s*\(\s*classes\b/, "must left-join classes");
  assert.match(src, /leftJoin\s*\(\s*subjects\b/, "must left-join subjects");
  assert.match(src, /leftJoin\s*\(\s*teachers\b/, "must left-join teachers");
});

test("spec 051 — index uses force-dynamic + auth gate + role redirect", () => {
  const src = read(INDEX);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.match(src, /import\s*\{\s*auth\s*\}\s*from\s*"@\/auth"/);
  assert.match(src, /redirect\("\/forbidden"\)/);
});

test("spec 051 — index renders the 4 filter tabs (All / Planned / Today / Complete)", () => {
  const src = read(INDEX);
  for (const label of ["All", "Planned", "Today", "Complete"]) {
    assert.ok(src.includes(`l: "${label}"`), `filter tab "${label}" must be present`);
  }
});

test("spec 051 — index renders Hindi name with var(--deva) font (SM-7)", () => {
  const src = read(INDEX);
  assert.match(src, /var\(--deva\)/, "Hindi name must use Devanagari font");
  assert.match(src, /teacherHindi/, "Hindi name field must be wired");
});

test("spec 051 — detail page joins sessions → schools, classes, subjects, teachers, outline_lessons, observation_cycles", () => {
  const src = read(DETAIL);
  for (const ref of [
    /from\s*\(\s*sessions\s*\)/,
    /from\s*\(\s*schools\s*\)/,
    /from\s*\(\s*classes\s*\)/,
    /from\s*\(\s*subjects\s*\)/,
    /from\s*\(\s*teachers\s*\)/,
    /from\s*\(\s*outlineLessons\s*\)/,
    /from\s*\(\s*courseOutlines\s*\)/,
    /from\s*\(\s*observationCycles\s*\)/,
  ]) {
    assert.match(src, ref, `detail must query ${ref}`);
  }
});

test("spec 051 — detail uses force-dynamic + auth gate + role redirect + notFound on missing", () => {
  const src = read(DETAIL);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.match(src, /import\s*\{\s*auth\s*\}\s*from\s*"@\/auth"/);
  assert.match(src, /redirect\("\/forbidden"\)/);
  assert.match(src, /notFound\(\)/);
});

test("spec 051 — detail renders KV rows in spec'd order", () => {
  const src = read(DETAIL);
  for (const label of [
    "Session ID",
    "School",
    "Subject",
    "Teacher",
    "Date",
    "Duration",
    "Status",
    "Attendance",
    "Observed",
  ]) {
    assert.ok(src.includes(`label="${label}"`), `KV row "${label}" must be present`);
  }
});

test("spec 051 — detail links to observation cycle when observed=true", () => {
  const src = read(DETAIL);
  assert.match(src, /\/observation\/\$\{cycle\.id\}/, "must deep-link to /observation/[id] when observed");
  assert.match(src, /observationCycleId/);
});

test("spec 051 — detail renders Hindi teacher name with var(--deva) font (SM-7)", () => {
  const src = read(DETAIL);
  assert.match(src, /var\(--deva\)/);
  assert.match(src, /hindiName/);
});

test("spec 051 — no stubs / TODOs / placeholder strings in routes", () => {
  for (const f of [INDEX, DETAIL]) {
    const src = read(f);
    assert.doesNotMatch(src, /TODO|FIXME|XXX|placeholder/i, `${f} must not contain stubs`);
  }
});

test("spec 051 — spec-kit files exist", () => {
  for (const f of [
    "specs/051-repo-sessions/spec.md",
    "specs/051-repo-sessions/plan.md",
    "specs/051-repo-sessions/research.md",
    "specs/051-repo-sessions/quickstart.md",
    "specs/051-repo-sessions/tasks.md",
  ]) {
    assert.ok(existsSync(resolve(root, f)), `${f} must exist`);
  }
});
