import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("schema/audit.ts declares audit_log with required columns", () => {
  const src = read("packages/db/src/schema/audit.ts");
  assert.match(src, /export const auditLog/);
  for (const col of ["userId", "action", "entityType", "entityId", "ip", "userAgent", "metadata"]) {
    assert.match(src, new RegExp(col), `audit_log must have ${col}`);
  }
  assert.match(src, /jsonb/i);
});

test("lib/audit.ts has recordAudit + withAudit", () => {
  const src = read("apps/web/src/lib/audit.ts");
  assert.match(src, /recordAudit/);
  assert.match(src, /withAudit/);
});

test("/admin/audit viewer exists", () => {
  assert.ok(existsSync(resolve(root, "apps/web/src/app/admin/audit/page.tsx")));
});

test("schema/index exports audit", () => {
  const src = read("packages/db/src/schema/index.ts");
  assert.match(src, /audit/);
});
