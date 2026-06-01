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

test("admin registry has rtt-prefixed slugs (no bare attendance/subjects)", () => {
  const src = read("apps/web/src/admin/registry.ts");
  assert.match(src, /"rtt-attendance"/);
  assert.match(src, /"rtt-subjects"/);
  // Bare slugs must not appear as registry keys (curriculum-side entities own those in spec 014+).
  assert.ok(!/^\s*attendance:\s/m.test(src), "no bare 'attendance' slug in registry");
  assert.ok(!/^\s*subjects:\s/m.test(src), "no bare 'subjects' slug in registry");
});

test("admin entity files renamed to rtt-attendance / rtt-subjects", () => {
  const dir = resolve(root, "apps/web/src/admin/entities");
  const files = readdirSync(dir);
  assert.ok(files.includes("rtt-attendance.ts"), "rtt-attendance.ts must exist");
  assert.ok(files.includes("rtt-subjects.ts"), "rtt-subjects.ts must exist");
  assert.ok(!files.includes("attendance.ts"), "v1 attendance.ts must be removed (mv to rtt-attendance.ts)");
  assert.ok(!files.includes("subjects.ts"), "v1 subjects.ts must be removed (mv to rtt-subjects.ts)");
});
