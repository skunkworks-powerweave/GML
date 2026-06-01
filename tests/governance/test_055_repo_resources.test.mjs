// Governance test for spec 055 — /repo/resources index + /repo/resource/[id] detail.
// Asserts route files exist, use Drizzle against (resources, resource_subjects, subjects),
// adhere to the CSS-variable token convention, and mirror the JSX prototype contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const INDEX_PATH = "apps/web/src/app/(authenticated)/repo/resources/page.tsx";
const DETAIL_PATH = "apps/web/src/app/(authenticated)/repo/resource/[id]/page.tsx";

test("spec 055 — both route files exist", () => {
  assert.ok(existsSync(resolve(root, INDEX_PATH)), `${INDEX_PATH} must exist`);
  assert.ok(existsSync(resolve(root, DETAIL_PATH)), `${DETAIL_PATH} must exist`);
});

test("spec 055 — index page is a force-dynamic server component", () => {
  const src = read(INDEX_PATH);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  // server-only signal: imports `db` from @gml/db, no "use client"
  assert.doesNotMatch(src, /^\s*"use client"/m);
  assert.match(src, /import\s+\{\s*db\s*\}\s+from\s+"@gml\/db"/);
});

test("spec 055 — index queries the three required tables", () => {
  const src = read(INDEX_PATH);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  assert.match(src, /\bresources\b/);
  assert.match(src, /\bresourceSubjects\b/);
  assert.match(src, /\bsubjects\b/);
  // Active-only filter (matches schema's soft-delete flag)
  assert.match(src, /resources\.active/);
});

test("spec 055 — index renders the JSX prototype's table headers (Title/Kind/Subjects/Owner/Pages/Updated)", () => {
  const src = read(INDEX_PATH);
  for (const h of ["Title", "Kind", "Subjects", "Owner", "Pages", "Updated"]) {
    assert.match(src, new RegExp(`"${h}"`), `index must include "${h}" table header`);
  }
});

test("spec 055 — index filter strip lists every prototype kind pill", () => {
  const src = read(INDEX_PATH);
  for (const k of [
    "Policy",
    "Guide",
    "Handbook",
    "Worksheet",
    "Template",
    "Routine",
    "Calendar",
    "Checklist",
    "Lab-guide",
  ]) {
    assert.match(src, new RegExp(`"${k}"`), `kind filter must include "${k}"`);
  }
});

test("spec 055 — index uses CSS-variable tokens inline (no hardcoded hex)", () => {
  const src = read(INDEX_PATH);
  assert.match(src, /var\(--ink-3\)/);
  assert.match(src, /var\(--serif\)/);
  assert.match(src, /var\(--paper-2\)/);
  assert.match(src, /var\(--line\)/);
  // No raw hex colours leaked
  assert.doesNotMatch(src, /#[0-9a-fA-F]{6}/);
});

test("spec 055 — index auths via @/auth and redirects unauthenticated users", () => {
  const src = read(INDEX_PATH);
  assert.match(src, /from\s+"@\/auth"/);
  assert.match(src, /auth\(\)/);
  assert.match(src, /redirect\("\/login"\)/);
});

test("spec 055 — detail page is a force-dynamic server component", () => {
  const src = read(DETAIL_PATH);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.doesNotMatch(src, /^\s*"use client"/m);
});

test("spec 055 — detail page imports Drizzle helpers + resources tables", () => {
  const src = read(DETAIL_PATH);
  assert.match(src, /import\s+\{\s*db\s*\}\s+from\s+"@gml\/db"/);
  assert.match(src, /from\s+"@gml\/db\/schema"/);
  assert.match(src, /\bresources\b/);
  assert.match(src, /\bresourceSubjects\b/);
  assert.match(src, /\bsubjects\b/);
  assert.match(src, /\beq\(/);
});

test("spec 055 — detail page 404s when the resource id is unknown or inactive", () => {
  const src = read(DETAIL_PATH);
  assert.match(src, /notFound\(\)/);
  assert.match(src, /resources\.active/);
});

test("spec 055 — detail KV sidebar renders every prototype label", () => {
  const src = read(DETAIL_PATH);
  for (const label of ["Kind", "Owner", "Pages", "Updated", "Subjects", "Tags"]) {
    assert.match(src, new RegExp(`label="${label}"`), `KV row for "${label}" must be present`);
  }
});

test("spec 055 — detail page differentiates fileKey viewer vs externalUrl link", () => {
  const src = read(DETAIL_PATH);
  // fileKey → "View PDF" button routing to /view (spec 087 relabel — viewer is in-browser only);
  // externalUrl → "Open external link".
  assert.match(src, /res\.fileKey/);
  assert.match(src, /View PDF/);
  assert.match(src, /res\.externalUrl/);
  assert.match(src, /Open external link/);
});

test("spec 055 — detail page uses CSS-variable tokens inline (no hardcoded hex)", () => {
  const src = read(DETAIL_PATH);
  assert.match(src, /var\(--ink-3\)/);
  assert.match(src, /var\(--serif\)/);
  assert.match(src, /var\(--mono\)/);
  assert.doesNotMatch(src, /#[0-9a-fA-F]{6}/);
});

test("spec 055 — detail subjects link to /repo/subject/[id] (matches prototype RelLink)", () => {
  const src = read(DETAIL_PATH);
  assert.match(src, /\/repo\/subject\//);
});
