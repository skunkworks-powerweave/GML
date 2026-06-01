import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("schema/rtt.ts exports v2-named Drizzle tables", () => {
  const src = read("packages/db/src/schema/rtt.ts");
  for (const name of ["rttSubjects", "rttModules", "rttLessons", "rttSessions", "rttReadings", "rttAttendance"]) {
    assert.match(src, new RegExp(`export const ${name}\\b`), `rtt.ts must export ${name}`);
  }
  // The v1 bare exports must NOT be defined alongside the v2 ones (they'd collide with curriculum-side tables).
  for (const old of ["export const subjects ", "export const lessons ", "export const attendance "]) {
    assert.ok(!src.includes(old), `rtt.ts must not redeclare ${old.trim()}`);
  }
});

test("schema/rtt.ts uses rtt_-prefixed pgTable names", () => {
  const src = read("packages/db/src/schema/rtt.ts");
  for (const tname of ["rtt_subjects", "rtt_modules", "rtt_lessons", "rtt_sessions", "rtt_readings", "rtt_attendance"]) {
    assert.match(src, new RegExp(`pgTable\\(\\s*"${tname}"`), `rtt.ts must declare table "${tname}"`);
  }
});

test("0001 migration exists with descriptive name", () => {
  const dir = resolve(root, "packages/db/src/migrations");
  const files = readdirSync(dir);
  const m = files.find((f) => f.startsWith("0001_") && f.endsWith(".sql"));
  assert.ok(m, "0001_*.sql migration must exist");
  assert.ok(!m.includes("spicy_doorman"), "the auto-generated whimsy name was replaced with a descriptive one");
  const sql = readFileSync(resolve(dir, m), "utf8");
  // Migration must contain CREATE statements for the renamed tables.
  for (const tname of ["rtt_subjects", "rtt_modules", "rtt_lessons", "rtt_sessions", "rtt_readings", "rtt_attendance"]) {
    assert.match(sql, new RegExp(`CREATE TABLE "${tname}"`), `0001 must CREATE TABLE "${tname}"`);
  }
});

test("_journal references the renamed migration tag", () => {
  const j = JSON.parse(read("packages/db/src/migrations/meta/_journal.json"));
  const e1 = j.entries?.find?.((e) => e.idx === 1);
  assert.ok(e1, "journal must have an idx=1 entry");
  assert.ok(e1.tag?.startsWith("0001_") && !e1.tag.includes("spicy_doorman"), `journal tag must be descriptive (got: ${e1.tag})`);
});

test("admin registry has rtt-prefixed slugs for the renamed RTT entities", () => {
  const src = read("apps/web/src/admin/registry.ts");
  assert.match(src, /"rtt-attendance"\s*:\s*rttAttendanceEntity/);
  assert.match(src, /"rtt-subjects"\s*:\s*rttSubjectsEntity/);
  // The bare slugs `attendance` and `subjects` are FREED for curriculum entities
  // (spec 014 ships `subjects: subjectsEntity` for the curriculum spine). What we
  // forbid is the OLD RTT entity being aliased back under the bare slug:
  assert.ok(!/^\s*attendance:\s*rttAttendanceEntity/m.test(src), "RTT attendance must not be aliased as bare `attendance`");
  assert.ok(!/^\s*subjects:\s*rttSubjectsEntity/m.test(src), "RTT subjects must not be aliased as bare `subjects`");
});

test("admin entity files renamed: rtt-attendance and rtt-subjects exist; any reused bare name is curriculum-bound", () => {
  const dir = resolve(root, "apps/web/src/admin/entities");
  const files = readdirSync(dir);
  assert.ok(files.includes("rtt-attendance.ts"), "rtt-attendance.ts must exist");
  assert.ok(files.includes("rtt-subjects.ts"), "rtt-subjects.ts must exist");
  // If `subjects.ts` reappears (spec 014 ships curriculum subjects under the freed
  // bare name), it must import the curriculum `subjects` table, not the renamed rttSubjects.
  if (files.includes("subjects.ts")) {
    const src = read("apps/web/src/admin/entities/subjects.ts");
    assert.ok(/import\s*\{\s*subjects\b/.test(src), "subjects.ts must import the curriculum `subjects` Drizzle table");
    assert.ok(!/rttSubjects/.test(src), "subjects.ts must not reference rttSubjects (those live in rtt-subjects.ts)");
  }
  // Same rule for `attendance.ts` should it ever come back (e.g. classroom-session attendance).
  if (files.includes("attendance.ts")) {
    const src = read("apps/web/src/admin/entities/attendance.ts");
    assert.ok(!/rttAttendance/.test(src), "attendance.ts must not reference rttAttendance");
  }
});
