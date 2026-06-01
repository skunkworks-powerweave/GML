import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("section_gate_slug enum has `admin`", () => {
  const src = read("packages/db/src/schema/enums.ts");
  assert.match(src, /sectionGateSlugEnum[\s\S]{0,300}"admin"/);
});

test("pairing_status enum has `review` and `complete`", () => {
  const src = read("packages/db/src/schema/enums.ts");
  // Match across multi-line enum array
  assert.match(src, /pairingStatusEnum[\s\S]{0,300}"review"/);
  assert.match(src, /pairingStatusEnum[\s\S]{0,300}"complete"/);
});

test("audit_action pgEnum is removed; AuditAction is now string", () => {
  const enumsSrc = read("packages/db/src/schema/enums.ts");
  // Should NOT have an active `export const auditActionEnum = pgEnum(...)`. A comment is fine.
  assert.ok(!/export const auditActionEnum = pgEnum/.test(enumsSrc), "auditActionEnum must be removed");

  const auditSrc = read("packages/db/src/schema/audit.ts");
  // Column is now varchar
  assert.match(auditSrc, /action:\s*varchar\("action",\s*\{\s*length:\s*64\s*\}\)\.notNull\(\)/);
  // Type alias is `string`
  assert.match(auditSrc, /export type AuditAction\s*=\s*string/);
});

test("docs/audit-actions.md documents the dotted-notation convention", () => {
  assert.ok(existsSync(resolve(root, "docs/audit-actions.md")));
  const src = read("docs/audit-actions.md");
  assert.match(src, /\/\^\[a-z_\]\+\(\\\.\[a-z_\]\+\)\*\$\//);
  assert.match(src, /SM-1/);
  assert.match(src, /SM-9/);
});

test("migration 0010 exists with enum + varchar transformations", () => {
  const dir = resolve(root, "packages/db/src/migrations");
  const m = readdirSync(dir).find((f) => f.startsWith("0010_") && f.endsWith(".sql"));
  assert.ok(m, "0010_*.sql must exist");
  const sql = readFileSync(resolve(dir, m), "utf8");
  // drizzle-kit may emit schema-qualified (`"public"."section_gate_slug"`) or bare table names.
  assert.match(sql, /ALTER TYPE (?:"public"\.)?"section_gate_slug"\s+ADD VALUE\s+'admin'/);
  assert.match(sql, /ALTER TYPE (?:"public"\.)?"pairing_status"\s+ADD VALUE\s+'review'/);
  assert.match(sql, /ALTER TYPE (?:"public"\.)?"pairing_status"\s+ADD VALUE\s+'complete'/);
  // audit_log.action column type change — drizzle-kit may emit this in a few forms
  assert.match(sql, /audit_log["\s]+(ALTER COLUMN "?action"?)/i);
});

test("SM-1 invariant intact (audit log still append-only path)", () => {
  // The grep gate in test_011 enforces "no db.update(auditLog) / db.delete(auditLog)".
  // Here we sanity-check the audit.ts file STILL exports auditLog (so the grep gate has a target).
  const src = read("packages/db/src/schema/audit.ts");
  assert.match(src, /export const auditLog\b/);
});
