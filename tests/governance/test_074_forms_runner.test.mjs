// Governance test for spec 074 — /forms/[slug] runner + /forms/[slug]/thanks confirmation.
// Asserts both route files exist, hold the contracts specified in spec.md (auth gate,
// slug parser, FormRenderer mount, server action insert + audit + redirect), and
// adhere to the GML inline-style + CSS-variable convention.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const RUNNER_PATH = "apps/web/src/app/(authenticated)/forms/[slug]/page.tsx";
const THANKS_PATH = "apps/web/src/app/(authenticated)/forms/[slug]/thanks/page.tsx";

test("spec 074 — runner + thanks route files exist", () => {
  assert.ok(existsSync(resolve(root, RUNNER_PATH)), `${RUNNER_PATH} must exist`);
  assert.ok(existsSync(resolve(root, THANKS_PATH)), `${THANKS_PATH} must exist`);
});

test("spec 074 — runner is a force-dynamic server component (no 'use client')", () => {
  const src = read(RUNNER_PATH);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.doesNotMatch(src, /^\s*"use client"/m);
});

test("spec 074 — runner auths via @/auth and redirects unauthenticated users to /login", () => {
  const src = read(RUNNER_PATH);
  assert.match(src, /from\s+"@\/auth"/);
  assert.match(src, /auth\(\)/);
  assert.match(src, /redirect\("\/login"\)/);
});

test("spec 074 — runner imports db + feedbackForms + feedbackResponses + formDrafts from @gml/db/schema", () => {
  const src = read(RUNNER_PATH);
  assert.match(src, /import\s+\{\s*db\s*\}\s+from\s+"@gml\/db"/);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  assert.match(src, /\bfeedbackForms\b/);
  assert.match(src, /\bfeedbackResponses\b/);
  assert.match(src, /\bformDrafts\b/);
});

test("spec 074 — runner parses slug as kind-audience-version (no slug column in schema)", () => {
  const src = read(RUNNER_PATH);
  // The parser splits on the first two dashes; we assert the function exists and
  // that the (kind, audience, version) triple is what we resolve against.
  assert.match(src, /parseSlug/);
  assert.match(src, /kind/);
  assert.match(src, /audience/);
  assert.match(src, /version/);
  // Triple-eq filter is the natural-key resolve.
  assert.match(src, /eq\(feedbackForms\.kind/);
  assert.match(src, /eq\(feedbackForms\.audience/);
  assert.match(src, /eq\(feedbackForms\.version/);
  assert.match(src, /eq\(feedbackForms\.active/);
});

// Was "(user, template) pair". That key WAS the defect: a mentor fills the
// same form once per mentee, so one (user, template) draft was shared by every
// mentee -- A's answers pre-filled B's form and submitting B deleted A's. The
// key is (user, template, pairing), built in one place (lib/forms/drafts.ts)
// that the read and the post-submit delete both use. What the key selects is
// executed by tests/behaviour/form-drafts-pairing.test.ts.
test("spec 074 — runner reads and clears form_drafts by (user, template, pairing)", () => {
  const src = read(RUNNER_PATH);
  assert.match(src, /\bformDrafts\b/);
  assert.match(src, /templateDraftWhere\(userId, form\.id, pairingId \|\| null\)/);
  assert.match(src, /\.delete\(formDrafts\)\.where\(templateDraftWhere\(userId, form\.id, pairingId\)\)/);
  const helper = read("apps/web/src/lib/forms/drafts.ts");
  assert.match(helper, /formDrafts\.userId/);
  assert.match(helper, /formDrafts\.templateId/);
  assert.match(helper, /formDrafts\.pairingId/);
});

test("spec 074 — runner mounts <FormRenderer> with the required props", () => {
  const src = read(RUNNER_PATH);
  assert.match(src, /<FormRenderer/);
  assert.match(src, /schema=\{schema\}/);
  assert.match(src, /initialResponses=\{/);
  // The autosave key carries the pairing (see the draft-key test above).
  assert.match(src, /draftKey=\{\{\s*templateId:\s*form\.id,\s*pairingId:\s*pairingId \|\| null\s*\}\}/);
  assert.match(src, /action=\{submitFormAction\}/);
  assert.match(src, /from\s+"@\/components\/forms\/FormRenderer"/);
});

test("spec 074 — runner owns a top-level 'use server' submitFormAction", () => {
  const src = read(RUNNER_PATH);
  assert.match(src, /export async function submitFormAction/);
  assert.match(src, /"use server"/);
});

test("spec 074 — submit inserts into feedbackResponses inside a transaction, deletes draft, redirects to thanks", () => {
  const src = read(RUNNER_PATH);
  assert.match(src, /db\.transaction\(/);
  assert.match(src, /tx\s*\.insert\(feedbackResponses\)/);
  assert.match(src, /tx\s*\.delete\(formDrafts\)/);
  assert.match(src, /redirect\(`\/forms\/\$\{slug\}\/thanks`\)/);
});

test("spec 074 — submit fires recordAudit with action 'form.submit'", () => {
  const src = read(RUNNER_PATH);
  assert.match(src, /from\s+"@\/lib\/audit"/);
  assert.match(src, /recordAudit/);
  assert.match(src, /"form\.submit"/);
  assert.match(src, /entityType:\s*"feedback_response"/);
});

test("spec 074 — runner uses CSS-variable tokens inline (no hardcoded hex)", () => {
  const src = read(RUNNER_PATH);
  assert.match(src, /var\(--ink-3\)/);
  assert.match(src, /var\(--serif\)/);
  assert.match(src, /var\(--paper-2\)/);
  assert.match(src, /var\(--line\)/);
  assert.match(src, /var\(--card-hi\)/);
  // Hindi font for the SM-7 gloss render
  assert.match(src, /var\(--deva\)/);
  assert.doesNotMatch(src, /#[0-9a-fA-F]{6}/);
});

test("spec 074 — runner renders Hindi title conditionally (SM-7)", () => {
  const src = read(RUNNER_PATH);
  // Conditional ternary marker — `hindiTitle ?` pattern.
  assert.match(src, /hindiTitle\s*\?/);
});

test("spec 074 — runner handles missing pairingId by redirecting back with ?error=missing_pairing", () => {
  const src = read(RUNNER_PATH);
  assert.match(src, /missing_pairing/);
});

test("spec 074 — thanks page is a force-dynamic server component", () => {
  const src = read(THANKS_PATH);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.doesNotMatch(src, /^\s*"use client"/m);
});

test("spec 074 — thanks page links back to /inbox", () => {
  const src = read(THANKS_PATH);
  assert.match(src, /href="\/inbox"/);
  // Was: also required `/inbox?filter=forms`. /inbox implements exactly one
  // filter value -- `unread` -- and anything else falls through to the "all"
  // branch, so `filter=forms` was decoration in the URL bar. The test pinned a
  // parameter that had never done anything.
  assert.ok(
    !/\/inbox\?filter=forms/.test(src),
    "the thanks page must not advertise an inbox filter the inbox does not implement",
  );
});

test("spec 074 — thanks page uses GML design tokens (serif, lichen-soft, paper, ink)", () => {
  const src = read(THANKS_PATH);
  assert.match(src, /var\(--serif\)/);
  assert.match(src, /var\(--lichen-soft\)/);
  assert.match(src, /var\(--ink\)/);
  assert.match(src, /var\(--paper\)/);
  assert.doesNotMatch(src, /#[0-9a-fA-F]{6}/);
});
