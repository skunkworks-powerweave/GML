// Governance test for spec 116 — GET /api/admin/audit/export.
// Asserts the route file exists, exports GET + POST 405, gates by
// super_admin/programme_admin, uses papaparse for CSV stringify, fires the
// `audit.bulk_export` audit row, enforces a 10k row cap with 413, ships a
// text/csv attachment response with a dated filename, and that the
// /admin/audit page wires an Export CSV Link to the endpoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ROUTE_PATH = "apps/web/src/app/api/admin/audit/export/route.ts";
const PAGE_PATH = "apps/web/src/app/(authenticated)/admin/audit/page.tsx";

test("spec 116 — route file exists at /api/admin/audit/export", () => {
  assert.ok(existsSync(resolve(root, ROUTE_PATH)), `${ROUTE_PATH} must exist`);
});

test("spec 116 — exports GET handler and POST 405 stub", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /export async function GET/);
  assert.match(src, /export async function POST/);
  assert.match(src, /method_not_allowed/);
  assert.match(src, /status:\s*405/);
});

test("spec 116 — auth gate returns 401 unauthenticated when no session", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+"@\/auth"/);
  assert.match(src, /await\s+auth\(\)/);
  assert.match(src, /unauthenticated/);
  assert.match(src, /status:\s*401/);
});

test("spec 116 — role gate allows super_admin and programme_admin (and only those)", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /"super_admin"/);
  assert.match(src, /"programme_admin"/);
  assert.match(src, /hasAnyRole/);
  assert.match(src, /forbidden/);
  assert.match(src, /status:\s*403/);
});

test("spec 116 — filter query params: action, user/userId, entityType, from, to", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /searchParams\.get\(\s*"action"\s*\)/);
  // either ?user or ?userId must be read (route supports both for page parity)
  assert.match(src, /searchParams\.get\(\s*"user(Id)?"\s*\)/);
  assert.match(src, /searchParams\.get\(\s*"entityType"\s*\)/);
  assert.match(src, /searchParams\.get\(\s*"from"\s*\)/);
  assert.match(src, /searchParams\.get\(\s*"to"\s*\)/);
  // drizzle helpers used to combine filters
  assert.match(src, /from\s+"drizzle-orm"/);
});

test("spec 116 — papaparse drives CSV stringify (no new dependency)", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+"papaparse"/);
  assert.match(src, /Papa\.unparse\(/);
});

test("spec 116 — 10k row cap returns 413 too_many_rows with hint", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /10000|ROW_CAP/);
  assert.match(src, /status:\s*413/);
  assert.match(src, /too_many_rows/);
  assert.match(src, /hint/);
});

test("spec 116 — audit.bulk_export hook fires with rowCount + filters metadata", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+"@\/lib\/audit"/);
  assert.match(src, /recordAudit\(/);
  assert.match(src, /action:\s*"audit\.bulk_export"/);
  assert.match(src, /entityType:\s*"audit_log"/);
  assert.match(src, /rowCount/);
  assert.match(src, /filters/);
  // Spec 167 — the prior `void recordAudit(...)` shape is now a captured-
  // boolean `const auditOk = await recordAudit(...)` so a degraded audit
  // channel can be detected via noteAuditDegraded. Accept either shape so
  // this regression test pins the audit-fire intent without forbidding the
  // spec-167 upgrade. Both shapes are best-effort with respect to the user-
  // facing 200 (failure does not block the response).
  assert.match(src, /(?:void\s+recordAudit|const\s+auditOk\s*=\s*await\s+recordAudit)/);
});

test("spec 116 — response is text/csv with audit-log-YYYYMMDD.csv attachment header", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /"Content-Type":\s*"text\/csv;\s*charset=utf-8"/);
  assert.match(src, /"Content-Disposition":/);
  assert.match(src, /attachment;\s*filename=/);
  assert.match(src, /audit-log-/);
  assert.match(src, /toISOString\(\)/);
});

test("spec 116 — CSV columns include timestamp/action/actor_user_id/entity_type/entity_id/ip/user_agent/metadata", () => {
  const src = read(ROUTE_PATH);
  for (const col of [
    "timestamp",
    "action",
    "actor_user_id",
    "entity_type",
    "entity_id",
    "ip",
    "user_agent",
    "metadata",
  ]) {
    assert.match(src, new RegExp(`"${col}"`), `CSV column ${col} must be present`);
  }
});

test("spec 116 — dynamic=force-dynamic and locked workspace imports", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.match(src, /from\s+"@gml\/db"/);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  assert.match(src, /from\s+"next\/server"/);
});

test("spec 116 — /admin/audit page wires an Export CSV Link to the API route", () => {
  assert.ok(existsSync(resolve(root, PAGE_PATH)), `${PAGE_PATH} must exist`);
  const src = read(PAGE_PATH);
  assert.match(src, /from\s+"next\/link"/);
  // computed href targets the export endpoint
  assert.match(src, /\/api\/admin\/audit\/export/);
  // rendered as a Link with download attribute
  assert.match(src, /<Link[\s\S]*?download[\s\S]*?>/);
  // the rendered button label keeps the JSX prototype's "Export" verb
  assert.match(src, /Export\s+CSV/);
});
