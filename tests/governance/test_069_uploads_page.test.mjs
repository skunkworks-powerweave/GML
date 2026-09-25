// Governance test for spec 069 — /uploads (teacher's "My Uploads" page).
// Asserts the page exists, guards auth, queries video_submissions filtered by
// the viewer, joins to files + observation_cycles, renders the explainer
// cards, hosts the <UploadProgress /> tray, ports the table from
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

// Was "the three-card explainer (... + record)", pinning a "Record in-app" card
// that promised "Saves to your phone first; uploads when you have wifi" and
// linked to the same file picker as "Upload here": nothing records, saves
// offline or waits for wifi on a desktop (F13). Recording is the phone flow's
// "Record now" (MobileUploadRunner). tests/behaviour/upload-copy.test.ts renders
// the page and checks the promise is gone.
test("069 — ports the explainer cards (WhatsApp PRIMARY + browser)", () => {
  const src = read(PAGE);
  assert.match(src, /Forward via WhatsApp/);
  assert.match(src, /Upload here/);
  assert.doesNotMatch(src, /title: "Record in-app"/);
  // The number comes from the ENVIRONMENT, not from this file.
  //
  // The old assertions pinned the literal `+91 90600 22013` and
  // `wa.me/919060022013` "to match the JSX prototype copy". That hardcoded
  // number sat three lines above this same file's own env-driven
  // `whatsappPhone`, so every deployment whose programme number is not the one
  // typed during prototyping sent teachers to a stranger -- on the PRIMARY
  // video path. The test was the thing keeping it there.
  //
  // What is pinned now is that the card is built from the env value and that
  // no literal phone number survives in the source.
  // (It also takes the caption WhatsApp should carry for the page's target, so
  // only the leading parameter is pinned.)
  assert.match(src, /function explainerCards\(whatsappPhone: string \| null[,)]/);
  assert.match(src, /https:\/\/wa\.me\/\$\{dialable\}/);
  assert.doesNotMatch(
    src,
    /\+?91[\s-]?9060[\s-]?0?22013/,
    "no hardcoded programme phone number in the source",
  );
  // The primary card has a 2px ink border (JSX `border: m.primary ? "2px solid var(--ink)" : undefined`).
  assert.match(src, /2px solid var\(--ink\)/);
});

// Was "with contextType=generic", pinning `<UploadProgress contextType="generic" />`
// -- the defect itself (F18): every upload from /uploads was linked to nothing,
// so the lesson video the teacher's dashboard to-do sends her here to upload
// was invisible to her observer and mentor. The tray now takes the context the
// page resolved; tests/behaviour/uploads-context-page.test.ts renders the page
// and reads what it is bound to.
test("069 — hosts the <UploadProgress /> tray, bound to what the page says the video is for", () => {
  const src = read(PAGE);
  assert.match(src, /import\s+\{\s*UploadProgress\s*\}\s+from\s+"@\/components\/video\/UploadProgress"/);
  assert.match(src, /<UploadProgress[\s\S]*?contextType=\{target\.contextType\}/);
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /<UploadProgress\s+contextType="generic"/);
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
