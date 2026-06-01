// Governance test for spec 098 — GET /api/admin/learners/export.
// Asserts the route file exists, exports GET (200 csv path) + POST 405 stub,
// gates by super_admin ONLY (not programme_admin), uses papaparse for CSV
// stringify, joins learners + classes + schools, fires the SM-9
// learners.bulk_export audit row with rowCount + piiAudited=true, and ships
// a text/csv response with attachment Content-Disposition + dated filename.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ROUTE_PATH = "apps/web/src/app/api/admin/learners/export/route.ts";

test("spec 098 — route file exists at /api/admin/learners/export", () => {
  assert.ok(existsSync(resolve(root, ROUTE_PATH)), `${ROUTE_PATH} must exist`);
});

test("spec 098 — exports GET handler and POST 405 stub", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /export async function GET/);
  assert.match(src, /export async function POST/);
  // POST returns 405 with method_not_allowed body
  assert.match(src, /method_not_allowed/);
  assert.match(src, /status:\s*405/);
});

test("spec 098 — auth gate: session check returns 401 unauthenticated", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+"@\/auth"/);
  assert.match(src, /await\s+auth\(\)/);
  assert.match(src, /unauthenticated/);
  assert.match(src, /status:\s*401/);
});

test("spec 098 — role gate is super_admin ONLY (SM-9 export policy)", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /"super_admin"/);
  // SM-9 policy: programme_admin can VIEW but cannot bulk-export. The
  // role check must NOT name programme_admin as an allowed exporter.
  // (programme_admin may appear in *comments* explaining the policy split,
  // but never as a string in the ALLOWED_ROLES const or in a hasAnyRole
  // call site.) Assert it doesn't appear in any quoted-string context.
  assert.doesNotMatch(src, /"programme_admin"/);
  // 403 path
  assert.match(src, /forbidden/);
  assert.match(src, /status:\s*403/);
});

test("spec 098 — SELECT joins learners + classes + schools with deleted_at filter", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  // drizzle helpers
  assert.match(src, /\beq\(/);
  assert.match(src, /\bisNull\(/);
  assert.match(src, /\band\(/);
  // tables
  assert.match(src, /\blearners\b/);
  assert.match(src, /\bclasses\b/);
  assert.match(src, /\bschools\b/);
  // joins
  assert.match(src, /leftJoin\(\s*classes/);
  assert.match(src, /leftJoin\(\s*schools/);
  // deleted_at IS NULL guard
  assert.match(src, /isNull\(\s*learners\.deletedAt\s*\)/);
});

test("spec 098 — optional ?school query filter", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /searchParams\.get\(\s*"school"\s*\)/);
  // applied to learners.schoolId
  assert.match(src, /learners\.schoolId/);
});

test("spec 098 — papaparse drives CSV stringify (no new dependency)", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+"papaparse"/);
  assert.match(src, /Papa\.unparse\(/);
});

test("spec 098 — SM-9 audit hook fires learners.bulk_export with rowCount + piiAudited", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+"@\/lib\/audit"/);
  assert.match(src, /recordAudit\(/);
  assert.match(src, /action:\s*"learners\.bulk_export"/);
  assert.match(src, /entityType:\s*"all"/);
  assert.match(src, /piiAudited:\s*true/);
  assert.match(src, /rowCount/);
  assert.match(src, /schoolFilter/);
  // Best-effort `void` so audit failure never blocks the 200.
  assert.match(src, /void\s+recordAudit/);
});

test("spec 098 — response is text/csv with attachment Content-Disposition", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /"Content-Type":\s*"text\/csv;\s*charset=utf-8"/);
  assert.match(src, /"Content-Disposition":/);
  assert.match(src, /attachment;\s*filename=/);
  assert.match(src, /learners-/);
  // dated filename from today's ISO date (UTC)
  assert.match(src, /toISOString\(\)/);
});

test("spec 098 — dynamic=force-dynamic and locked workspace imports, no new deps", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.match(src, /from\s+"@gml\/db"/);
  assert.match(src, /from\s+"next\/server"/);
  assert.match(src, /from\s+"drizzle-orm"/);
});
