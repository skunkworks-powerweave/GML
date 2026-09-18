// Governance test for spec 069 — /uploads (teacher's "My Uploads" page).
// Asserts the page exists, guards auth, queries video_submissions filtered by
// the viewer, joins to files + observation_cycles, renders the three-card
// explainer, hosts the <UploadProgress /> tray, ports the table from
// forms.jsx::UploadsPage, and uses the inline-style + CSS-var idiom shared
// with the rest of Phase 7.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const PAGE = "apps/web/src/app/(authenticated)/uploads/page.tsx";
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("069 — /uploads page file exists", () => {
  assert.ok(existsSync(resolve(root, PAGE)), `${PAGE} must exist`);
});

test("069 — page is a force-dynamic server component guarded by auth()", () => {
  const src = read(PAGE);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.match(src, /import\s+\{\s*auth\s*\}\s+from\s+"@\/auth"/);
  assert.match(src, /const session = await auth\(\)/);
  assert.match(src, /redirect\("\/forbidden"\)/);
  // No 'use client' — server component.
  assert.doesNotMatch(src, /^\s*"use client"/m);
});

test("069 — queries video_submissions filtered by submittedByUserId + joins files + observation_cycles", () => {
  const src = read(PAGE);
  assert.match(src, /from\s*\(\s*videoSubmissions\s*\)/);
  assert.match(src, /leftJoin\(\s*files\s*,/);
  assert.match(src, /leftJoin\(\s*\n?\s*observationCycles\s*,/);
  assert.match(src, /eq\(\s*videoSubmissions\.submittedByUserId\s*,\s*viewerId\s*\)/);
  assert.match(src, /orderBy\(\s*desc\(\s*videoSubmissions\.createdAt\s*\)\s*\)/);
  assert.match(src, /\.limit\(\s*50\s*\)/);
  // Uses the canonical @gml/db imports.
  assert.match(src, /import\s+\{\s*db\s*\}\s+from\s+"@gml\/db"/);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
});

test("069 — ports the three-card explainer (WhatsApp PRIMARY + browser + record)", () => {
  const src = read(PAGE);
  assert.match(src, /Forward via WhatsApp/);
  assert.match(src, /Upload here/);
  assert.match(src, /Record in-app/);
  // WhatsApp number + caption hint (matches the JSX prototype copy).
  assert.match(src, /\+91 90600 22013/);
  assert.match(src, /wa\.me\/919060022013/);
  // The primary card has a 2px ink border (JSX `border: m.primary ? "2px solid var(--ink)" : undefined`).
  assert.match(src, /2px solid var\(--ink\)/);
});

test("069 — hosts the <UploadProgress /> tray with contextType=generic", () => {
  const src = read(PAGE);
  assert.match(src, /import\s+\{\s*UploadProgress\s*\}\s+from\s+"@\/components\/video\/UploadProgress"/);
  assert.match(src, /<UploadProgress\s+contextType="generic"\s*\/>/);
});

test("069 — table shows the six prototype columns + reuses the STATE_LABEL idiom", () => {
  const src = read(PAGE);
  for (const header of ["File", "Source", "Linked to", "Size", "State", "Date"]) {
    assert.ok(src.includes(`"${header}"`), `column header ${header} must appear`);
  }
  // Status pill maps mirror /videos (spec 067).
  assert.match(src, /STATE_LABEL/);
  // NOTE: a /STATE_BG/ assertion used to live here. The constant it matched was
  // dead code -- its own comment said it was "kept for the governance test
  // idiom" while claiming a use it did not have. The regex passed for months
  // against an unused symbol. Asserting the rendered state labels below is the
  // part that actually describes the page.
  // Source pill map.
  assert.match(src, /SOURCE_LABEL/);
  // Empty state copy.
  assert.match(src, /haven&apos;t uploaded anything yet|haven't uploaded anything yet/);
  // Ready-only rows link to /videos/[id].
  assert.match(src, /href=\{`\/videos\/\$\{r\.id\}`\}/);
});

test("069 — uses inline-style + CSS-var idiom and renders Hindi label with var(--deva)", () => {
  const src = read(PAGE);
  // Inline-style tokens (no Tailwind colour utilities for the body).
  assert.match(src, /var\(--ink\)/);
  assert.match(src, /var\(--paper\)/);
  assert.match(src, /var\(--line\)/);
  assert.match(src, /var\(--serif\)/);
  assert.match(src, /var\(--mono\)/);
  // SM-7: Hindi span uses the deva font token.
  assert.match(src, /var\(--deva\)/);
  assert.match(src, /मेरे अपलोड/);
});
