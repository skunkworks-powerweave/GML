import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ROUTE = "apps/web/src/app/api/notifications/mark-read/route.ts";

test("Spec 096: route file exists", () => {
  assert.ok(existsSync(resolve(root, ROUTE)), `${ROUTE} must exist`);
});

test("Spec 096: route is force-dynamic and exports POST handler", () => {
  const src = read(ROUTE);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.match(src, /export async function POST\b/);
});

test("Spec 096: auth() from @/auth is awaited and gates the handler", () => {
  const src = read(ROUTE);
  assert.match(src, /import\s*\{\s*auth\s*\}\s*from\s*"@\/auth"/);
  assert.match(src, /await auth\(\)/);
  // Session-missing path returns 401.
  assert.match(src, /unauthenticated/);
  assert.match(src, /status:\s*401/);
});

test("Spec 096: imports db + notifications schema from @gml/db", () => {
  const src = read(ROUTE);
  assert.match(src, /import\s*\{\s*db\s*\}\s*from\s*"@gml\/db"/);
  assert.match(src, /import\s*\{\s*notifications\s*\}\s*from\s*"@gml\/db\/schema"/);
});

test("Spec 096: UPDATE notifications SET readAt = now() WHERE userId = session.user.id AND readAt IS NULL", () => {
  const src = read(ROUTE);
  assert.match(src, /db\s*\.\s*update\(\s*notifications\s*\)/);
  assert.match(src, /\.set\(\s*\{\s*readAt:/);
  assert.match(src, /eq\(\s*notifications\.userId\s*,/);
  assert.match(src, /isNull\(\s*notifications\.readAt\s*\)/);
  // The UPDATE must return rows so the response's `marked` count is real.
  assert.match(src, /\.returning\(/);
});

test("Spec 096: optional ids array narrows the UPDATE via inArray", () => {
  const src = read(ROUTE);
  assert.match(src, /inArray\(\s*notifications\.id\s*,/);
  // Body validation accepts a string-array of ids.
  assert.match(src, /z\.array\(/);
});

test("Spec 096: audit invocation uses recordAudit with notifications.mark_read action", () => {
  const src = read(ROUTE);
  assert.match(src, /import\s*\{\s*recordAudit\s*\}\s*from\s*"@\/lib\/audit"/);
  assert.match(src, /recordAudit\(/);
  assert.match(src, /action:\s*"notifications\.mark_read"/);
  // Marked-count surfaces in audit metadata.
  assert.match(src, /markedCount/);
});

test("Spec 096: GET (and other non-POST verbs) return 405", () => {
  const src = read(ROUTE);
  assert.match(src, /export async function GET\b/);
  // 405 must be the status code, and the canonical error string is reused.
  assert.match(src, /status:\s*405/);
  assert.match(src, /method_not_allowed/);
});

test("Spec 096: success response shape is { ok:true, marked:number }", () => {
  const src = read(ROUTE);
  assert.match(src, /ok:\s*true/);
  assert.match(src, /marked:/);
});

test("Spec 096: form-post callers get redirected back to /inbox", () => {
  const src = read(ROUTE);
  // Non-JSON content-type should 303-redirect to /inbox so the page refreshes.
  assert.match(src, /NextResponse\.redirect\(/);
  assert.match(src, /\/inbox/);
});

test("Spec 096: spec-kit files exist", () => {
  for (const f of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, `specs/096-api-notifications-mark-read/${f}`)),
      `specs/096-api-notifications-mark-read/${f} must exist`,
    );
  }
});
