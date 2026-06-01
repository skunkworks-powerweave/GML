import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const WIKI_PATH = "apps/web/src/lib/wiki.ts";
const RELLINK_PATH = "apps/web/src/components/repo/RelLink.tsx";

test("spec 056: wiki.ts library exists at apps/web/src/lib/wiki.ts", () => {
  assert.ok(existsSync(resolve(root, WIKI_PATH)), `${WIKI_PATH} must exist`);
});

test("spec 056: RelLink.tsx component exists at apps/web/src/components/repo/RelLink.tsx", () => {
  assert.ok(existsSync(resolve(root, RELLINK_PATH)), `${RELLINK_PATH} must exist`);
});

test("spec 056: wiki.ts exports wikiLookup with all 8 entity methods", () => {
  const src = read(WIKI_PATH);
  assert.match(src, /export const wikiLookup\s*=/);
  for (const method of [
    "school:",
    "subject:",
    "teacher:",
    "class:",
    "session:",
    "outline:",
    "mentor:",
    "resource:",
  ]) {
    assert.match(src, new RegExp(method), `wikiLookup must have ${method} key`);
  }
});

test("spec 056: wiki.ts uses React.cache() to dedupe per render", () => {
  const src = read(WIKI_PATH);
  assert.match(src, /import\s*\{\s*cache\s*\}\s*from\s*["']react["']/);
  // every lookup is wrapped in cache(...)
  assert.match(src, /lookupSchool\s*=\s*cache\(/);
  assert.match(src, /lookupSubject\s*=\s*cache\(/);
  assert.match(src, /lookupTeacher\s*=\s*cache\(/);
  assert.match(src, /lookupClass\s*=\s*cache\(/);
  assert.match(src, /lookupSession\s*=\s*cache\(/);
  assert.match(src, /lookupOutline\s*=\s*cache\(/);
  assert.match(src, /lookupMentor\s*=\s*cache\(/);
  assert.match(src, /lookupResource\s*=\s*cache\(/);
});

test("spec 056: wiki.ts runs real Drizzle queries via @gml/db", () => {
  const src = read(WIKI_PATH);
  assert.match(src, /from\s*["']@gml\/db["']/);
  assert.match(src, /from\s*["']@gml\/db\/schema["']/);
  assert.match(src, /import\s*\{\s*eq\s*\}\s*from\s*["']drizzle-orm["']/);
  // All eight tables referenced
  for (const table of [
    "schools",
    "subjects",
    "teachers",
    "classes",
    "sessions",
    "courseOutlines",
    "mentors",
    "resources",
  ]) {
    assert.match(src, new RegExp(`\\b${table}\\b`), `must reference ${table} table`);
  }
});

test("spec 056: wiki.ts session lookup joins subjects + schools + teachers", () => {
  const src = read(WIKI_PATH);
  // The session lookup is the one cross-join helper (FR-007).
  const sessionBlock = src.match(/lookupSession[\s\S]+?\}\);/);
  assert.ok(sessionBlock, "lookupSession block must be present");
  assert.match(sessionBlock[0], /leftJoin\(subjects/);
  assert.match(sessionBlock[0], /leftJoin\(schools/);
  assert.match(sessionBlock[0], /leftJoin\(teachers/);
});

test("spec 056: wiki.ts exports hrefForEntity helper", () => {
  const src = read(WIKI_PATH);
  assert.match(src, /export function hrefForEntity\s*\(/);
  assert.match(src, /\/repo\/\$\{kind\}\/\$\{id\}/);
});

test("spec 056: wiki.ts exports chipColorFor mapping subject colors", () => {
  const src = read(WIKI_PATH);
  assert.match(src, /export function chipColorFor\s*\(/);
  // Ports the JSX subjectColor() switch (repository.jsx 11-16)
  for (const c of ["blue", "green", "orange", "yellow", "red", "pink"]) {
    assert.match(src, new RegExp(`case\\s+["']${c}["']`));
  }
  // Maps to the four accent token families
  assert.match(src, /var\(--indigo-soft\)/);
  assert.match(src, /var\(--lichen-soft\)/);
  assert.match(src, /var\(--saffron-soft\)/);
  assert.match(src, /var\(--rust-soft\)/);
});

test("spec 056: wiki.ts is server-only (no client leakage of db handle)", () => {
  const src = read(WIKI_PATH);
  assert.match(src, /import\s+["']server-only["']/);
});

test("spec 056: wiki.ts selects SM-7 hindiName on teacher + mentor lookups (nullable)", () => {
  const src = read(WIKI_PATH);
  // The teacher and mentor select objects must include hindiName.
  assert.match(src, /hindiName:\s*teachers\.hindiName/);
  assert.match(src, /hindiName:\s*mentors\.hindiName/);
});

test("spec 056: wiki.ts returns null on missing id (no throw)", () => {
  const src = read(WIKI_PATH);
  // Each cache(async (id) => { if (!id) return null; ... }) early-return.
  const earlyReturns = src.match(/if \(!id\) return null;/g) ?? [];
  assert.ok(
    earlyReturns.length >= 8,
    `expected one early-return per lookup, found ${earlyReturns.length}`,
  );
});

test("spec 056: wiki.ts does NOT select PII columns (phone, guardian, age, etc.)", () => {
  const src = read(WIKI_PATH);
  // Display-safe fields only. Phones live on teachers/mentors but must not be
  // selected by these lookups; guardian/age/rollNumber live on learners which
  // we deliberately do not include in the wiki layer (see designDeviations).
  assert.ok(
    !/teachers\.phone/.test(src),
    "wiki.ts must NOT select teacher.phone (SM-9 — keep PII off the wiki layer)",
  );
  assert.ok(!/\bguardian\b/.test(src), "wiki.ts must NOT reference guardian");
  assert.ok(!/learners\./.test(src), "wiki.ts must NOT reference learners (PII)");
});

test("spec 056: RelLink renders a Next.js <Link> with /repo/<kind>/<id> href", () => {
  const src = read(RELLINK_PATH);
  assert.match(src, /from\s*["']next\/link["']/);
  assert.match(src, /hrefForEntity\(kind,\s*id\)/);
});

test("spec 056: RelLink chip uses inline style with CSS var tokens (mirrors mentorship/page.tsx)", () => {
  const src = read(RELLINK_PATH);
  assert.match(src, /style=\{\{[\s\S]*background[\s\S]*color[\s\S]*\}\}/);
  assert.match(src, /borderRadius:\s*999/);
});

test("spec 056: RelLink renders optional Hindi gloss in var(--deva) (SM-7)", () => {
  const src = read(RELLINK_PATH);
  assert.match(src, /hindiLabel/);
  assert.match(src, /var\(--deva\)/);
});

test("spec 056: RelLink kind prop is the WikiKind union (server-rendered, no client handlers)", () => {
  const src = read(RELLINK_PATH);
  assert.match(src, /kind:\s*WikiKind/);
  // No onClick handlers — Server Component safe.
  assert.ok(!/onClick/.test(src), "RelLink must not use onClick (must be RSC-safe)");
});
