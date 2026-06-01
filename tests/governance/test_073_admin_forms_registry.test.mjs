import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const INDEX_PAGE = "apps/web/src/app/(authenticated)/admin/forms/page.tsx";
const DETAIL_PAGE = "apps/web/src/app/(authenticated)/admin/forms/[id]/page.tsx";
const PARTS_FILE = "apps/web/src/app/(authenticated)/admin/forms/[id]/parts.tsx";
const API_ROUTE = "apps/web/src/app/api/admin/forms/[id]/route.ts";

test("spec 073 — all target files exist", () => {
  for (const f of [INDEX_PAGE, DETAIL_PAGE, PARTS_FILE, API_ROUTE]) {
    assert.ok(existsSync(resolve(root, f)), `${f} must exist`);
  }
});

test("spec 073 — index page is server component gated to admin roles", () => {
  const src = read(INDEX_PAGE);
  assert.match(src, /export const dynamic = "force-dynamic"/);
  assert.match(src, /requireRole\(\["programme_admin", "super_admin"\]\)/);
  assert.match(src, /from "@gml\/db"/);
  assert.match(src, /feedbackForms/);
  // Page header copy ported 1:1 from forms.jsx
  assert.match(src, /Programme forms/);
  assert.match(
    src,
    /Forms are defined as JSON schemas — admins compose them; teachers and mentors fill/,
  );
});

test("spec 073 — index page is NOT a client component (server-only)", () => {
  const src = read(INDEX_PAGE);
  assert.doesNotMatch(src, /^"use client"/m);
});

test("spec 073 — detail page renders editor + preview side-by-side", () => {
  const src = read(DETAIL_PAGE);
  assert.match(src, /export const dynamic = "force-dynamic"/);
  assert.match(src, /requireRole\(\["programme_admin", "super_admin"\]\)/);
  // Two-column grid for editor + preview
  assert.match(src, /gridTemplateColumns:\s*"1fr 1fr"/);
  // Imports the client parts
  assert.match(src, /FormSchemaEditor/);
  assert.match(src, /FormSchemaPreview/);
  // Calls notFound() when the row is missing
  assert.match(src, /notFound\(\)/);
});

test("spec 073 — parts file is a client component with textarea + Save button", () => {
  const src = read(PARTS_FILE);
  assert.match(src, /^"use client"/);
  // Editor exports
  assert.match(src, /export function FormSchemaEditor/);
  assert.match(src, /export function FormSchemaPreview/);
  // PUT to the API endpoint
  assert.match(src, /\/api\/admin\/forms\/\$\{formId\}/);
  assert.match(src, /method:\s*"PUT"/);
  // Schema parse check + invalid-JSON path
  assert.match(src, /JSON\.parse\(text\)/);
  assert.match(src, /Schema does not parse/);
});

test("spec 073 — API route is role-gated, validates JSON, bumps version, audits", () => {
  const src = read(API_ROUTE);
  // Method
  assert.match(src, /export async function PUT/);
  // Role gate
  assert.match(src, /hasAnyRole\(session\.user\.role,\s*\[\.\.\.ALLOWED_ROLES\]\)/);
  assert.match(src, /"programme_admin",\s*"super_admin"/);
  // JSON parse path
  assert.match(src, /JSON\.parse\(raw\)/);
  assert.match(src, /invalid_json/);
  // Bumps version + writes audit
  assert.match(src, /bumpVersion\(existing\.version\)/);
  assert.match(src, /recordAudit\(/);
  assert.match(src, /form\.schema\.update/);
  // Status codes: 400 for invalid JSON, 404 missing row, 200 on success
  assert.match(src, /status:\s*400/);
  assert.match(src, /status:\s*404/);
  assert.match(src, /status:\s*200/);
});

test("spec 073 — bumpVersion helper has correct contract (regex + behavior cases)", () => {
  // We can't directly require the .ts file from a .mjs test harness, so we
  // (1) assert the source contains the documented contract, and
  // (2) reimplement the same regex locally and verify its outputs match the
  //     in-source contract on the boundary cases.
  const src = read(API_ROUTE);
  // The function exists and uses the documented regex.
  assert.match(src, /export function bumpVersion/);
  assert.match(src, /\^\(\\d\+\)\(\?:\\\.\(\\d\+\)\)\?\$/);
  // Documented cases must appear in the JSDoc — locks the contract in source.
  assert.match(src, /"1"\s*→\s*"2"/);
  assert.match(src, /"2\.7"\s*→\s*"2\.8"/);
  assert.match(src, /"draft-Q2"\s*→\s*"draft-Q2\+1"/);

  // Reference reimplementation — must match the contract exactly.
  const bump = (prev) => {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(prev);
    if (!m) return `${prev}+1`;
    const major = Number(m[1]);
    if (m[2] === undefined) return String(major + 1);
    return `${major}.${Number(m[2]) + 1}`;
  };
  assert.equal(bump("1"), "2");
  assert.equal(bump("2"), "3");
  assert.equal(bump("1.0"), "1.1");
  assert.equal(bump("2.7"), "2.8");
  assert.equal(bump("draft-Q2"), "draft-Q2+1");
  assert.equal(bump("v2"), "v2+1");
});

test("spec 073 — inline styles use CSS variable tokens (no Tailwind classNames for chrome)", () => {
  // Index page should mirror the Phase-7 inline-style discipline; spot-check for
  // a few load-bearing tokens.
  const src = read(INDEX_PAGE);
  assert.match(src, /var\(--ink\)/);
  assert.match(src, /var\(--paper-2\)/);
  assert.match(src, /var\(--serif\)/);
  assert.match(src, /var\(--mono\)/);
});
