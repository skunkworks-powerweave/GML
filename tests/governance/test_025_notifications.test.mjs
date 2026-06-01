import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("schema/notifications.ts exports notifications with required cols + indexes", () => {
  const src = read("packages/db/src/schema/notifications.ts");
  assert.match(src, /export const notifications\b/);
  assert.match(src, /pgTable\(\s*"notifications"/);
  for (const col of ["userId", "kind", "subject", "body", "entityType", "entityId", "readAt"]) {
    assert.match(src, new RegExp(col), `notifications must have ${col}`);
  }
  assert.match(src, /notifications_user_unread_idx/);
  assert.match(src, /notifications_created_idx/);
});

test("schema/index.ts barrels notifications", () => {
  assert.match(read("packages/db/src/schema/index.ts"), /from\s+"\.\/notifications"/);
});

test("SM-8: retention script exists with 90-day cutoff", () => {
  assert.ok(existsSync(resolve(root, "packages/db/src/scripts/retention.ts")));
  const src = read("packages/db/src/scripts/retention.ts");
  assert.match(src, /RETAIN_DAYS\s*=\s*90/);
  assert.match(src, /db\.delete\(notifications\)/);
  assert.match(src, /lt\(notifications\.createdAt/);
});

test("packages/db/package.json has retention script", () => {
  const pkg = JSON.parse(read("packages/db/package.json"));
  assert.ok(pkg.scripts.retention, "retention script must exist");
  assert.match(pkg.scripts.retention, /retention\.ts/);
});

test("migration 0011 exists with both tables", () => {
  const dir = resolve(root, "packages/db/src/migrations");
  const m = readdirSync(dir).find((f) => f.startsWith("0011_") && f.endsWith(".sql"));
  assert.ok(m, "0011_*.sql must exist");
  const sql = readFileSync(resolve(dir, m), "utf8");
  assert.match(sql, /CREATE TABLE "user_prefs"/);
  assert.match(sql, /CREATE TABLE "notifications"/);
});
