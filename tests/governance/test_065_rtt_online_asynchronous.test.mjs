// Governance test — spec 065 (rtt-online-asynchronous).
// Asserts the page exists and contains the contract markers from spec.md AC-1..AC-8.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { message, readsKey } from "./_i18n.mjs";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const PAGE = "apps/web/src/app/(authenticated)/rtt/online/asynchronous/page.tsx";
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("spec 065 — page file exists at the canonical route", () => {
  assert.ok(existsSync(resolve(root, PAGE)), `${PAGE} must exist`);
});

test("spec 065 — auth + redirect contract (AC-2)", () => {
  const src = read(PAGE);
  assert.match(src, /from\s+["']@\/auth["']/, "must import from @/auth");
  assert.match(src, /await\s+auth\(\)/, "must invoke auth()");
  assert.match(src, /redirect\(["']\/login["']\)/, "must redirect to /login when no session");
});

test("spec 065 — force-dynamic export (AC-3)", () => {
  const src = read(PAGE);
  assert.match(src, /export\s+const\s+dynamic\s*=\s*"force-dynamic"/);
});

test("spec 065 — schema imports for the three data tables (AC-4)", () => {
  const src = read(PAGE);
  assert.match(src, /from\s+["']@gml\/db["']/);
  assert.match(src, /from\s+["']@gml\/db\/schema["']/);
  assert.match(src, /\brttSubjects\b/);
  assert.match(src, /\bresources\b/);
  assert.match(src, /\bvideoSubmissions\b/);
});

test("spec 065 — subject tab strip with All pill + searchParams.subject (AC-5)", () => {
  const src = read(PAGE);
  assert.match(src, /searchParams/);
  assert.match(src, /\bsubject\b/);
  // The pill's label is the rtt namespace's (read by key).
  assert.ok(readsKey(src, "common.all"), "must render an All pill (rtt.common.all)");
  assert.equal(message("rtt.common.all"), "All");
});

test("spec 065 — 3-column responsive card grid (AC-6)", () => {
  const src = read(PAGE);
  // The minimum is min(100%, 280px), not a bare 280px (F11): a fixed 280 px
  // track overflows any column narrower than that and widens the page on a
  // small phone. This assertion used to pin the bare 280px -- the defect.
  // tests/behaviour/ui-rtt-quiz-phone.test.ts checks the rendered layout.
  assert.match(
    src,
    /repeat\(auto-fill,\s*minmax\(min\(100%,\s*280px\),\s*1fr\)\)/,
    "must use the GML card-grid template, capped at the column's width",
  );
});

test("spec 065 — GML design tokens used inline (AC-7)", () => {
  const src = read(PAGE);
  for (const tok of ["var(--card-hi)", "var(--line)", "var(--serif)", "var(--paper-2)", "var(--ink-3)"]) {
    assert.ok(src.includes(tok), `must use design token ${tok}`);
  }
});

test("spec 065 — empty-state copy (AC-8)", () => {
  const src = read(PAGE);
  assert.ok(readsKey(src, "async.empty"), "the empty state reads rtt.async.empty");
  assert.match(src, /t\.rich\(\s*"async\.emptyFor"/, "and rtt.async.emptyFor when a subject is chosen");
  assert.match(message("rtt.async.empty"), /No async content yet/);
  assert.match(message("rtt.async.emptyFor"), /No async content yet/);
});

test("spec 065 — pulls external-link + google_drive videos and external-URL resources (FR-005)", () => {
  const src = read(PAGE);
  assert.match(src, /external_link/);
  assert.match(src, /google_drive/);
  assert.match(src, /externalUrl/);
});
