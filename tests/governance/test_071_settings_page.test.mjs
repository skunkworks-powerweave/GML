import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { message, readsKey } from "./_i18n.mjs";

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
  assert.ok(readsKey(src, "title"), "the heading reads home.settings.title");
  assert.equal(message("home.settings.title"), "Your preferences");
  assert.match(src, /fontFamily:\s*"var\(--serif\)"/);
  assert.match(src, /fontSize:\s*26/);
  assert.match(src, /var\(--ink-3\)/);
});

test("Spec 071: 4 section cards exist (Display / Privacy / Language / Account)", () => {
  // Titled from home.client.settingsForm, in the user's language.
  const src = read(FORM);
  for (const [key, t] of [["display", "Display"], ["privacy", "Privacy"], ["language", "Language"], ["account", "Account"]]) {
    assert.match(src, new RegExp(`<SectionCard title=\\{t\\("${key}"\\)`), `must render SectionCard titled home.client.settingsForm.${key}`);
    assert.equal(message(`home.client.settingsForm.${key}`), t);
  }
});

// F127: this pinned that the Density and Text size options EXIST in the source
// -- which they did, while saving them changed nothing anywhere (no density
// CSS; text sizes are inline px a body font-size cannot reach). Both controls
// were removed; the invariant is now that the two that do take effect are
// there. Their effect is executed in tests/behaviour/ui-display-prefs.test.ts.
test("Spec 071: contrast / motion controls wired; no Density or Text size control", () => {
  const src = read(FORM);
  assert.match(src, /set\("highContrast", v\)/);
  assert.match(src, /set\("reducedMotion", v\)/);
  assert.doesNotMatch(src, /label="Density"/, "Density has no effect; it must not be offered");
  assert.doesNotMatch(src, /label="Text size"/, "Text size has no effect; it must not be offered");
});

// F127: the "Watermark videos with my name" switch saved show_watermark and the
// player ignored it (the overlay is always drawn, SM-4). It is now a statement,
// not a control: honouring it would let a viewer drop the overlay before
// recording the screen. The column and its default stay.
test("Spec 071: watermark stated as always on (no switch); DEFAULT_PREFS keeps it true", () => {
  const formSrc = read(FORM);
  const pageSrc = read(PAGE);
  assert.doesNotMatch(formSrc, /label="Watermark videos with my name"/);
  assert.match(formSrc, /data-testid="watermark-always-on"/);
  assert.match(pageSrc, /showWatermark:\s*true/);
});

test("Spec 071: UI language picker renders English + हिन्दी + བོད་ཡིག", () => {
  // Each pill names its language in that language's own script, from the
  // chrome's language namespace (the same self-names the login picker shows).
  const src = read(FORM);
  for (const key of ["english", "hindi", "bhoti"]) assert.ok(readsKey(src, key), `the pill reads language.${key}`);
  assert.equal(message("language.english"), "English");
  assert.equal(message("language.hindi"), "हिन्दी");
  assert.equal(message("language.bhoti"), "བོད་ཡིག");
  for (const locale of ["hi", "bo"]) {
    assert.equal(message("language.hindi", locale), "हिन्दी", `${locale}: Hindi is named in Devanagari`);
    assert.equal(message("language.bhoti", locale), "བོད་ཡིག", `${locale}: Bhoti is named in Tibetan`);
  }
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
  // Form renders email + role-pill KV rows (labels from home.client.settingsForm)
  assert.match(formSrc, /<KvRow label=\{t\("email"\)\}/);
  assert.match(formSrc, /<KvRow label=\{t\("role"\)\}/);
  assert.equal(message("home.client.settingsForm.email"), "Email");
  assert.equal(message("home.client.settingsForm.role"), "Role");
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
