// Governance test for spec 066 — /rtt/teach-back expert-review queue.
// Asserts the route file exists, is a force-dynamic server component,
// queries video_submissions filtered to context_type='teach_back',
// joins teachers via users, renders the SM-7 Hindi-name conditional,
// renders the two terminal statuses with the GML colour mapping,
// and points the "Mark reviewed" form at /api/teach-back/[id]/review.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PAGE_PATH = "apps/web/src/app/(authenticated)/rtt/teach-back/page.tsx";

test("spec 066 — teach-back queue route file exists", () => {
  assert.ok(existsSync(resolve(root, PAGE_PATH)), `${PAGE_PATH} must exist`);
});

test("spec 066 — page is a force-dynamic server component (no 'use client')", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.doesNotMatch(src, /^\s*"use client"/m);
});

test("spec 066 — imports db + drizzle helpers from the locked workspace packages", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /import\s+\{\s*db\s*\}\s+from\s+"@gml\/db"/);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  // drizzle helpers used for the join + ordering
  assert.match(src, /\beq\b/);
  assert.match(src, /\bdesc\(/);
});

test("spec 066 — queries video_submissions filtered to teach_back, joined to teachers + users", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /\bvideoSubmissions\b/);
  assert.match(src, /\bteachers\b/);
  assert.match(src, /\busers\b/);
  assert.match(src, /"teach_back"/);
  assert.match(src, /videoSubmissions\.contextType/);
  assert.match(src, /desc\(videoSubmissions\.createdAt\)/);
});

test("spec 066 — auth gate + role-based redirect to /login and /forbidden", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /from\s+"@\/auth"/);
  assert.match(src, /await\s+auth\(\)/);
  assert.match(src, /redirect\("\/login"\)/);
  assert.match(src, /redirect\("\/forbidden"\)/);
});

test("spec 066 — three filter pills (All / Pending review / Reviewed)", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /"All"/);
  assert.match(src, /"Pending review"/);
  assert.match(src, /"Reviewed"/);
});

test("spec 066 — status chip colour mapping uses CSS variables (saffron + lichen)", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /var\(--saffron-soft\)/);
  assert.match(src, /var\(--saffron\)/);
  assert.match(src, /var\(--lichen-soft\)/);
  assert.match(src, /var\(--lichen\)/);
  // and the two pill keys
  assert.match(src, /review_pending/);
  assert.match(src, /reviewed/);
});

test("spec 066 — Hindi name is rendered conditionally with the Devanagari font (SM-7)", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /var\(--deva\)/);
  // conditional render — never a phantom span when hindiName is null
  assert.match(src, /teacherHindi\s*\?/);
});

test("spec 066 — 'Mark reviewed' form posts to /api/teach-back/[id]/review", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /\/api\/teach-back\/\$\{[^}]+\}\/review/);
  assert.match(src, /Mark reviewed/);
  assert.match(src, /method="POST"/);
});

test("spec 066 — right pane links to /videos/[id] (Tier-0 video player route)", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /\/videos\/\$\{selected\.id\}/);
  assert.match(src, /View video/);
});

test("spec 066 — inline style with CSS-variable tokens, no hardcoded hex", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /var\(--ink-3\)/);
  assert.match(src, /var\(--serif\)/);
  assert.match(src, /var\(--paper-2\)/);
  assert.match(src, /var\(--line\)/);
  assert.doesNotMatch(src, /#[0-9a-fA-F]{6}/);
});

test("spec 066 — selection-via-searchParam pattern (no 'use client' state)", () => {
  const src = read(PAGE_PATH);
  // The brief asks for click-to-select; we implement it via ?id=
  assert.match(src, /searchParams/);
  assert.match(src, /sp\.id|searchParams\.id/);
  assert.match(src, /selectedId/);
});
