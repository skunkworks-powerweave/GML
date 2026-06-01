import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("schema/sessions.ts exports `sessions`", () => {
  const src = read("packages/db/src/schema/sessions.ts");
  assert.match(src, /export const sessions\b/);
  assert.match(src, /pgTable\(\s*"sessions"/);
  for (const ref of [/=>\s*schools\.id/, /=>\s*classes\.id/, /=>\s*subjects\.id/, /=>\s*teachers\.id/, /=>\s*outlineLessons\.id/, /=>\s*observationCycles\.id/]) {
    assert.match(src, ref, `must FK to ${ref}`);
  }
  assert.match(src, /sessions_status_check/);
  assert.match(src, /sessions_attended_le_total_check/);
});

test("schema/index.ts barrels sessions", () => {
  assert.match(read("packages/db/src/schema/index.ts"), /from\s+"\.\/sessions"/);
});

test("admin registry has sessions slug", () => {
  assert.match(read("apps/web/src/admin/registry.ts"), /sessions:\s*sessionsEntity/);
});

test("Auth.js sessions rename migration exists (0005)", () => {
  const dir = resolve(root, "packages/db/src/migrations");
  const m = readdirSync(dir).find((f) => f.startsWith("0005_") && f.endsWith(".sql"));
  assert.ok(m, "0005_*.sql (auth-sessions rename) must exist");
  const sql = readFileSync(resolve(dir, m), "utf8");
  assert.match(sql, /ALTER TABLE "sessions"\s+RENAME TO "auth_sessions"/);
});

test("classroom sessions migration exists (0006) with CREATE TABLE sessions", () => {
  const dir = resolve(root, "packages/db/src/migrations");
  const m = readdirSync(dir).find((f) => f.startsWith("0006_") && f.endsWith(".sql"));
  assert.ok(m, "0006_*.sql (classroom sessions) must exist");
  const sql = readFileSync(resolve(dir, m), "utf8");
  assert.match(sql, /CREATE TABLE "sessions"/);
  // FKs must reference the right targets.
  assert.match(sql, /REFERENCES "public"\."schools"/);
  assert.match(sql, /REFERENCES "public"\."classes"/);
  assert.match(sql, /REFERENCES "public"\."subjects"/);
  assert.match(sql, /REFERENCES "public"\."teachers"/);
});

test("identity schema renamed sessions export to authSessions", () => {
  const src = readFileSync(resolve(root, "packages/db/src/schema/identity.ts"), "utf8");
  assert.match(src, /export const authSessions\b/);
  assert.match(src, /pgTable\("auth_sessions"/);
  assert.ok(!/export const sessions\b/.test(src), "old `sessions` export must be removed from identity.ts");
});

test("auth.ts adapter points at authSessions", () => {
  const src = readFileSync(resolve(root, "apps/web/src/auth.ts"), "utf8");
  assert.match(src, /authSessions\b/);
  assert.match(src, /sessionsTable:\s*authSessions/);
});
