import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PAGE = "apps/web/src/app/(authenticated)/rtt/online/synchronous/page.tsx";

test("spec 064: /rtt/online/synchronous page exists", () => {
  assert.ok(existsSync(resolve(root, PAGE)), `${PAGE} must exist`);
});

test("spec 064: page is a server component with force-dynamic", () => {
  const src = read(PAGE);
  assert.match(src, /export const dynamic\s*=\s*["']force-dynamic["']/);
  // Server-component contract: no "use client" pragma on this page.
  assert.ok(!/^\s*["']use client["']/m.test(src), "page must remain a server component");
});

test("spec 064: page is auth-gated via @/auth and redirects to /login", () => {
  const src = read(PAGE);
  assert.match(src, /from\s*["']@\/auth["']/);
  assert.match(src, /auth\(\)/);
  assert.match(src, /redirect\(["']\/login["']\)/);
});

test("spec 064: page renders the Crimson Pro h1 'Online · Synchronous' with the RTT eyebrow", () => {
  const src = read(PAGE);
  assert.match(src, /RTT online hub/);
  assert.match(src, /Online\s*·\s*Synchronous/);
  // Crimson Pro is sourced from var(--serif) per globals.css; h1 should use it.
  assert.match(src, /fontFamily:\s*["']var\(--serif\)["']/);
});

test("spec 064: query filters rtt_sessions.type to synchronous|webinar|quiz via inArray", () => {
  const src = read(PAGE);
  assert.match(src, /from\s*["']@gml\/db\/schema["']/);
  assert.match(src, /rttSessions/);
  assert.match(src, /inArray\s*\(\s*rttSessions\.type/);
  // The three synchronous flavours must all be present in the type allowlist.
  assert.match(src, /"synchronous"/);
  assert.match(src, /"webinar"/);
  assert.match(src, /"quiz"/);
});

test("spec 064: query joins rtt_subjects → terms → phases for the subject/phase trail", () => {
  const src = read(PAGE);
  assert.match(src, /leftJoin\(rttSubjects/);
  assert.match(src, /leftJoin\(terms/);
  assert.match(src, /leftJoin\(phases/);
});

test("spec 064: schedule filter drops null scheduledAt and bounds to week-start onwards", () => {
  const src = read(PAGE);
  assert.match(src, /isNotNull\s*\(\s*rttSessions\.scheduledAt/);
  assert.match(src, /gte\s*\(\s*rttSessions\.scheduledAt/);
});

test("spec 064: renders a Mon-Fri grid across 3 weeks", () => {
  const src = read(PAGE);
  assert.match(src, /WEEKDAYS\s*=\s*\[\s*"Mon"\s*,\s*"Tue"\s*,\s*"Wed"\s*,\s*"Thu"\s*,\s*"Fri"\s*\]/);
  // Exactly 3 weeks rendered.
  assert.match(src, /length:\s*3\s*\}/);
});

test("spec 064: upcoming-5 side panel header + slice", () => {
  const src = read(PAGE);
  assert.match(src, /Upcoming webinars/);
  assert.match(src, /\.slice\(0,\s*5\)/);
});

test("spec 064: type pills map webinar→indigo, quiz→saffron, synchronous→lichen", () => {
  const src = read(PAGE);
  // The TYPE_PILL lookup carries the three required mappings.
  assert.match(src, /webinar:\s*\{\s*bg:\s*"var\(--indigo-soft\)"/);
  assert.match(src, /quiz:\s*\{\s*bg:\s*"var\(--saffron-soft\)"/);
  assert.match(src, /synchronous:\s*\{\s*bg:\s*"var\(--lichen-soft\)"/);
});

test("spec 064: empty state directs operator to /admin/data/sessions with muted ink-3 styling", () => {
  const src = read(PAGE);
  assert.match(src, /No webinars scheduled/);
  assert.match(src, /\/admin\/data\/sessions/);
  assert.match(src, /var\(--ink-3\)/);
});

test("spec 064: cards use GML design tokens (var(--card-hi), var(--line), var(--r-3))", () => {
  const src = read(PAGE);
  assert.match(src, /var\(--card-hi\)/);
  assert.match(src, /var\(--line\)/);
  assert.match(src, /var\(--r-3\)/);
});

test("spec 064: every db symbol comes from the @gml/db barrel (no raw drizzle handle)", () => {
  const src = read(PAGE);
  assert.match(src, /from\s*["']@gml\/db["']/);
  // Locked import surface — no direct pg / postgres-js leakage.
  assert.ok(!/from\s*["']pg["']/.test(src));
  assert.ok(!/from\s*["']postgres["']/.test(src));
});
