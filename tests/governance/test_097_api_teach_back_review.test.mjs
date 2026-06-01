// Governance test for spec 097 — POST /api/teach-back/[id]/review.
// Asserts the route file exists, exports POST (200/404/403/401 paths) plus
// a GET 405 stub, gates by the four read-roles, scopes the UPDATE to
// context_type='teach_back', uses the locked workspace imports, and writes
// the teach_back.reviewed audit row.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ROUTE_PATH = "apps/web/src/app/api/teach-back/[id]/review/route.ts";

test("spec 097 — route file exists at /api/teach-back/[id]/review", () => {
  assert.ok(existsSync(resolve(root, ROUTE_PATH)), `${ROUTE_PATH} must exist`);
});

test("spec 097 — exports POST handler and GET 405 stub", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /export async function POST/);
  assert.match(src, /export async function GET/);
  // GET returns 405 with method_not_allowed body
  assert.match(src, /method_not_allowed/);
  assert.match(src, /status:\s*405/);
});

test("spec 097 — auth gate: session check returns 401 unauthenticated", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+"@\/auth"/);
  assert.match(src, /await\s+auth\(\)/);
  assert.match(src, /unauthenticated/);
  assert.match(src, /status:\s*401/);
});

test("spec 097 — role gate covers exactly the four reader roles, returns 403 on failure", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /hasAnyRole\(/);
  // All four allowed roles must appear as string literals in the source.
  assert.match(src, /"super_admin"/);
  assert.match(src, /"programme_admin"/);
  assert.match(src, /"mentor"/);
  assert.match(src, /"observer"/);
  assert.match(src, /forbidden/);
  assert.match(src, /status:\s*403/);
});

test("spec 097 — UPDATE is scoped to context_type='teach_back' and sets status='reviewed'", () => {
  const src = read(ROUTE_PATH);
  // drizzle update on videoSubmissions
  assert.match(src, /db\s*\.\s*update\(videoSubmissions\)/);
  assert.match(src, /\.set\(\{\s*status:\s*"reviewed"\s*\}\)/);
  // WHERE clauses: id match AND context_type='teach_back'
  assert.match(src, /videoSubmissions\.id/);
  assert.match(src, /videoSubmissions\.contextType/);
  assert.match(src, /"teach_back"/);
  // and() conjunction with eq()
  assert.match(src, /\band\s*\(/);
  assert.match(src, /\beq\(/);
  // .returning to detect zero-row update
  assert.match(src, /\.returning\(/);
});

test("spec 097 — 404 path: zero rows updated returns not_found", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /updated\.length\s*===\s*0/);
  assert.match(src, /not_found/);
  assert.match(src, /status:\s*404/);
});

test("spec 097 — audit hook fires teach_back.reviewed with entity metadata", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+"@\/lib\/audit"/);
  assert.match(src, /recordAudit\(/);
  assert.match(src, /action:\s*"teach_back\.reviewed"/);
  assert.match(src, /entityType:\s*"video_submission"/);
  assert.match(src, /entityId:\s*id/);
  // Best-effort `void` so audit failure never blocks the 200.
  assert.match(src, /void\s+recordAudit/);
});

test("spec 097 — success response is {ok:true} with 200", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /\{\s*ok:\s*true\s*\}/);
  assert.match(src, /status:\s*200/);
});

test("spec 097 — imports use locked workspace packages, no new deps", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /from\s+"@gml\/db"/);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  assert.match(src, /from\s+"@gml\/shared\/auth\/roles"/);
  assert.match(src, /from\s+"next\/server"/);
  assert.match(src, /from\s+"drizzle-orm"/);
  // dynamic="force-dynamic" — never cache a mutation endpoint.
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
});
