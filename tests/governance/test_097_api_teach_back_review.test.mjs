// Governance test for spec 097 — POST /api/teach-back/[id]/review.
// Asserts the route file exists, exports POST (200/404/403/401 paths) plus
// a GET 405 stub, gates by the four read-roles, decides through the approvals
// queue (whose teach-back handler scopes the UPDATE to
// context_type='teach_back'), uses the locked workspace imports, and writes
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

// The route decides through the approvals queue (teaching-records design,
// 2026-09-28): Approve or Request changes with feedback. The write that marks
// the video reviewed moved into the teach-back approval handler, which the
// queue calls inside the decision's transaction; these hold the same rules
// there.
const HANDLER_PATH = "apps/web/src/lib/approvals/handlers/teach-back.ts";

test("spec 097 — the route decides through the approvals queue (reviewTeachBack -> decideApproval)", () => {
  const src = read(ROUTE_PATH);
  assert.match(src, /reviewTeachBack\(/);
  assert.match(src, /from\s+"@\/lib\/rtt\/teach-back"/);
  const lib = read("apps/web/src/lib/rtt/teach-back.ts");
  assert.match(lib, /decideApproval\(/);
});

test("spec 097 — the handler's UPDATE is scoped to context_type='teach_back' and records review without clobbering status", () => {
  const src = read(HANDLER_PATH);
  // drizzle update on videoSubmissions
  assert.match(src, /\.update\(videoSubmissions\)/);

  // Inverted deliberately. This used to REQUIRE `.set({ status: "reviewed" })`,
  // pinning a real bug in place: `video_status` is one mutually-exclusive enum
  // doing double duty as pipeline state and review state, and the player only
  // renders when status === "ready". So marking a teach-back reviewed
  // permanently destroyed playback, and the review page's own "View video" link
  // landed on a dead player. Review is now its own timestamp (migration 0022).
  assert.doesNotMatch(
    src,
    /\.set\(\{[^}]*status:\s*"reviewed"/,
    "review must not overwrite `status` — that makes the video unplayable",
  );
  assert.match(src, /reviewedAt/, "review must record a reviewedAt timestamp");
  assert.match(src, /reviewedByUserId/, "review must record who reviewed it");
  // WHERE clauses: id match AND context_type='teach_back'
  assert.match(src, /videoSubmissions\.id/);
  assert.match(src, /videoSubmissions\.contextType/);
  assert.match(src, /"teach_back"/);
  // and() conjunction with eq()
  assert.match(src, /\band\s*\(/);
  assert.match(src, /\beq\(/);
});

test("spec 097 — 404 path: an unknown teach-back returns not_found", () => {
  const src = read(ROUTE_PATH);
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
  assert.match(src, /from\s+"@gml\/shared\/auth\/roles"/);
  assert.match(src, /from\s+"next\/server"/);
  // The table and the drizzle helpers are the handler's now (see above).
  const handler = read(HANDLER_PATH);
  assert.match(handler, /from\s+"@gml\/db\/schema"/);
  assert.match(handler, /from\s+"drizzle-orm"/);
  // dynamic="force-dynamic" — never cache a mutation endpoint.
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
});
