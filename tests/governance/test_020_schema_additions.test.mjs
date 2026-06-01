import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("schools.code NOT NULL UNIQUE", () => {
  const src = read("packages/db/src/schema/geography.ts");
  assert.match(src, /code:\s*varchar\("code".+\.notNull\(\)\.unique\(\)/);
});

test("teachers.hindi_name + current_phase_id present", () => {
  const src = read("packages/db/src/schema/geography.ts");
  assert.match(src, /hindiName:\s*varchar\("hindi_name"/);
  assert.match(src, /currentPhaseId:.*references\(\(\)\s*=>\s*phases\.id/);
});

test("mentors.hindi_name + base_location present", () => {
  const src = read("packages/db/src/schema/mentorship.ts");
  assert.match(src, /hindiName:\s*varchar\("hindi_name"/);
  assert.match(src, /baseLocation:\s*varchar\("base_location"/);
});

test("mentor_pairings.current_quarter + meetings_count + last_meeting_at present", () => {
  const src = read("packages/db/src/schema/mentorship.ts");
  assert.match(src, /currentQuarter:\s*smallint\("current_quarter"\)/);
  assert.match(src, /meetingsCount:\s*integer\("meetings_count"\)/);
  assert.match(src, /lastMeetingAt:\s*timestamp\("last_meeting_at"/);
  assert.match(src, /mentor_pairings_quarter_check/);
});

test("observation_cycles.subject_id + topic + video_min present", () => {
  const src = read("packages/db/src/schema/observation.ts");
  assert.match(src, /subjectId:.*references\(\(\)\s*=>\s*subjects\.id/);
  assert.match(src, /topic:\s*varchar\("topic"/);
  assert.match(src, /videoMin:\s*integer\("video_min"\)/);
});

test("users.hindi_name present", () => {
  const src = read("packages/db/src/schema/identity.ts");
  assert.match(src, /hindiName:\s*varchar\("hindi_name"/);
});

test("SM-7: hindi_name columns are NULLABLE everywhere", () => {
  for (const file of ["geography.ts", "mentorship.ts", "identity.ts"]) {
    const src = read(`packages/db/src/schema/${file}`);
    // Find the hindiName line and ensure no .notNull() chained on it.
    const lines = src.split("\n");
    for (const line of lines) {
      if (/hindiName:\s*varchar\(/.test(line)) {
        assert.ok(!/\.notNull\(\)/.test(line), `SM-7 violation: hindi_name must be NULLABLE in ${file}: ${line.trim()}`);
      }
    }
  }
});

test("migration 0009 exists with ALTER TABLE additions", () => {
  const dir = resolve(root, "packages/db/src/migrations");
  const m = readdirSync(dir).find((f) => f.startsWith("0009_") && f.endsWith(".sql"));
  assert.ok(m, "0009_*.sql must exist");
  const sql = readFileSync(resolve(dir, m), "utf8");
  // Most of the additions are ALTER TABLE ADD COLUMN.
  assert.match(sql, /ALTER TABLE "schools"\s+ADD COLUMN "code"/);
  assert.match(sql, /ALTER TABLE "teachers"\s+ADD COLUMN "hindi_name"/);
  assert.match(sql, /ALTER TABLE "mentors"\s+ADD COLUMN "hindi_name"/);
  assert.match(sql, /ALTER TABLE "mentor_pairings"\s+ADD COLUMN "current_quarter"/);
  assert.match(sql, /ALTER TABLE "observation_cycles"\s+ADD COLUMN "subject_id"/);
  assert.match(sql, /ALTER TABLE "users"\s+ADD COLUMN "hindi_name"/);
});
