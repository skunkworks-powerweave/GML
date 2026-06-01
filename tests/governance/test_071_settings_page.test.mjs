import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PAGE = "apps/web/src/app/(authenticated)/settings/page.tsx";
const FORM = "apps/web/src/app/(authenticated)/settings/settings-form.tsx";

test("Spec 071: settings route + form files exist", () => {
  assert.ok(existsSync(resolve(root, PAGE)), `${PAGE} must exist`);
  assert.ok(existsSync(resolve(root, FORM)), `${FORM} must exist`);
});

test("Spec 071: page is a server component with force-dynamic + auth gate", () => {
  const src = read(PAGE);
  assert.match(src, /export const dynamic\s*=\s*"force-dynamic"/);
  assert.match(src, /export default async function SettingsPage/);
  assert.match(src, /from\s+"@\/auth"/);
  assert.match(src, /await auth\(\)/);
  assert.match(src, /redirect\("\/login"\)/);
  // Server pages must not be marked "use client".
  assert.ok(!/^"use client";/m.test(src), "page.tsx must be a server component");
});

test("Spec 071: page reads user_prefs via Drizzle from @gml/db", () => {
  const src = read(PAGE);
  assert.match(src, /import\s*\{\s*db\s*\}\s*from\s*"@gml\/db"/);
  assert.match(src, /import\s*\{\s*userPrefs\s*\}\s*from\s*"@gml\/db\/schema"/);
  assert.match(src, /\.from\(userPrefs\)/);
  assert.match(src, /eq\(userPrefs\.userId/);
});

test("Spec 071: page header matches GML design tokens (serif h1 26px)", () => {
  const src = read(PAGE);
  assert.match(src, /Your preferences/);
  assert.match(src, /fontFamily:\s*"var\(--serif\)"/);
  assert.match(src, /fontSize:\s*26/);
  assert.match(src, /var\(--ink-3\)/);
});

test("Spec 071: 4 section cards exist (Display / Privacy / Language / Account)", () => {
  const src = read(FORM);
  for (const t of ["Display", "Privacy", "Language", "Account"]) {
    assert.match(src, new RegExp(`title="${t}"`), `must render SectionCard with title="${t}"`);
  }
});

test("Spec 071: density / fontScale / contrast / motion controls all wired", () => {
  const src = read(FORM);
  // Density options
  for (const v of ["dense", "regular", "loose"]) {
    assert.match(src, new RegExp(`v:\\s*"${v}"`), `density option ${v} must be present`);
  }
  // Font scale options
  for (const v of ["large", "xlarge"]) {
    assert.match(src, new RegExp(`v:\\s*"${v}"`), `font scale option ${v} must be present`);
  }
  assert.match(src, /highContrast/);
  assert.match(src, /reducedMotion/);
});

test("Spec 071: watermark toggle present and on by default in DEFAULT_PREFS", () => {
  const formSrc = read(FORM);
  const pageSrc = read(PAGE);
  assert.match(formSrc, /Watermark videos with my name/);
  assert.match(formSrc, /showWatermark/);
  assert.match(pageSrc, /showWatermark:\s*true/);
});

test("Spec 071: UI language picker renders English + हिन्दी + བོད་ཡིག", () => {
  const src = read(FORM);
  assert.match(src, /\bEnglish\b/);
  assert.match(src, /हिन्दी/);
  assert.match(src, /བོད་ཡིག/);
  // SM-7: Hindi label scoped to Devanagari font-family
  assert.match(src, /fontFamily:\s*"var\(--deva\)"/);
});

test("Spec 071: client form posts to /api/user-prefs via PUT", () => {
  const src = read(FORM);
  assert.match(src, /^"use client";/m);
  assert.match(src, /"\/api\/user-prefs"/);
  assert.match(src, /method:\s*"PUT"/);
  assert.match(src, /Content-Type":\s*"application\/json"/);
});

test("Spec 071: form computes delta so audit log only logs changed keys", () => {
  const src = read(FORM);
  assert.match(src, /computeDelta/);
  // Must JSON.stringify the delta (not the full payload) so the API's
  // `keys: Object.keys(patch)` audit metadata reflects actual edits.
  assert.match(src, /JSON\.stringify\(delta\)/);
});

test("Spec 071: Account section shows read-only email + role chip", () => {
  const pageSrc = read(PAGE);
  const formSrc = read(FORM);
  // Page builds ROLE_COLORS mapping with topbar tokens
  assert.match(pageSrc, /ROLE_COLORS/);
  assert.match(pageSrc, /super_admin/);
  assert.match(pageSrc, /programme_admin/);
  assert.match(pageSrc, /teacher/);
  assert.match(pageSrc, /var\(--indigo-soft\)|var\(--indigo\)/);
  // Form renders email + role-pill KV rows
  assert.match(formSrc, /label="Email"/);
  assert.match(formSrc, /label="Role"/);
});

test("Spec 071: no hex colors — only CSS-variable tokens", () => {
  for (const path of [PAGE, FORM]) {
    const src = read(path);
    // 3- or 6-digit hex like #fff or #123abc; ignore #__next selector etc.
    assert.ok(!/#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/.test(src), `${path} must not contain hex colors (use var(--…))`);
  }
});

test("Spec 071: spec-kit files all present", () => {
  for (const f of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, `specs/071-settings-page/${f}`)),
      `specs/071-settings-page/${f} must exist`,
    );
  }
});
