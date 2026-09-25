import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ROUTE = "apps/web/src/app/(authenticated)/inbox/page.tsx";

test("Spec 070: /inbox route file exists", () => {
  assert.ok(existsSync(resolve(root, ROUTE)), `${ROUTE} must exist`);
});

test("Spec 070: route is a server component with force-dynamic + async default export", () => {
  const src = read(ROUTE);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.match(src, /export default async function/);
  // Must NOT be a client component (filter tabs work via query string, not state).
  assert.ok(!/^["']use client["']/m.test(src), "inbox page must remain a server component");
});

test("Spec 070: auth() is awaited and redirects to /login when missing", () => {
  const src = read(ROUTE);
  assert.match(src, /import\s*\{\s*auth\s*\}\s*from\s*"@\/auth"/);
  assert.match(src, /await auth\(\)/);
  assert.match(src, /redirect\(\s*"\/login"\s*\)/);
});

test("Spec 070: query uses notifications table scoped to current user", () => {
  const src = read(ROUTE);
  assert.match(src, /import\s*\{\s*db\s*\}\s*from\s*"@gml\/db"/);
  assert.match(src, /import\s*\{\s*notifications\s*\}\s*from\s*"@gml\/db\/schema"/);
  assert.match(src, /\.from\(\s*notifications\s*\)/);
  assert.match(src, /eq\(\s*notifications\.userId\s*,/);
  assert.match(src, /\.limit\(\s*50\s*\)/);
});

test("Spec 070: unread-first ordering via NULLS FIRST + DESC createdAt", () => {
  const src = read(ROUTE);
  assert.match(src, /NULLS FIRST/);
  assert.match(src, /notifications\.createdAt/);
  assert.match(src, /DESC/);
});

test("Spec 070: filter=unread narrows to isNull(readAt)", () => {
  const src = read(ROUTE);
  assert.match(src, /isNull\(\s*notifications\.readAt\s*\)/);
  assert.match(src, /searchParams/);
  assert.match(src, /["']unread["']/);
});

test("Spec 070: kind icon map covers all four documented kinds + bell fallback", () => {
  const src = read(ROUTE);
  for (const kind of ["cycle.assigned", "video.transcoded", "meeting.scheduled", "quiz.due"]) {
    assert.match(src, new RegExp(`"${kind.replace(".", "\\.")}"`), `KIND_ICON must include "${kind}"`);
  }
  // Emoji glyphs from the spec brief.
  for (const glyph of ["📋", "🎥", "📅", "❓"]) {
    assert.ok(src.includes(glyph), `must render glyph ${glyph}`);
  }
  assert.ok(src.includes("🔔"), "bell fallback glyph must exist");
});

// The map moved to inbox/links.ts, shared with /api/notifications/[id]/open,
// which marks an item read before redirecting to it (the page links every item
// through that route; tests/behaviour/inbox-open.test.ts executes both).
test("Spec 070: entity href map covers cycle / video / meeting / quiz", () => {
  assert.match(read(ROUTE), /from "\.\/links"/);
  const src = read("apps/web/src/app/(authenticated)/inbox/links.ts");
  assert.match(src, /\/observation\//);
  assert.match(src, /\/videos\//);
  assert.match(src, /\/mentorship\//);
  assert.match(src, /\/quizzes\//);
});

test("Spec 070: date grouping labels (Today / Yesterday / This week / Older) present", () => {
  const src = read(ROUTE);
  for (const label of ["Today", "Yesterday", "This week", "Older"]) {
    assert.match(src, new RegExp(label), `bucket label "${label}" must appear in source`);
  }
});

test("Spec 070: filter tabs render All + Unread chips", () => {
  const src = read(ROUTE);
  assert.match(src, />\s*All\s*</);
  assert.match(src, />\s*Unread/);
  assert.match(src, /href="\/inbox"/);
  assert.match(src, /href="\/inbox\?filter=unread"/);
});

test("Spec 070: Mark all read button POSTs to /api/notifications/mark-read", () => {
  const src = read(ROUTE);
  assert.match(src, /action="\/api\/notifications\/mark-read"/);
  assert.match(src, /method="post"/);
  assert.match(src, /Mark all read/);
});

test("Spec 070: unread vs read visual treatment uses var(--card-hi) / var(--paper-2)", () => {
  const src = read(ROUTE);
  assert.match(src, /var\(--card-hi\)/);
  assert.match(src, /var\(--paper-2\)/);
  assert.match(src, /var\(--indigo\)/);
  assert.match(src, /var\(--indigo-soft\)/);
});

test("Spec 070: typography + color tokens used (no hard-coded hex)", () => {
  const src = read(ROUTE);
  assert.match(src, /var\(--serif\)/);
  assert.match(src, /var\(--ink-3\)/);
  assert.match(src, /var\(--line\)/);
  assert.match(src, /var\(--r-3\)/);
  // No raw hex colours allowed.
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(src), "route file must not contain hex colors (use CSS variables)");
});

test("Spec 070: spec-kit files exist", () => {
  for (const f of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, `specs/070-inbox-notifications/${f}`)),
      `specs/070-inbox-notifications/${f} must exist`,
    );
  }
});
