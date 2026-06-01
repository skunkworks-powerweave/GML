import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("schema/prefs.ts exports userPrefs", () => {
  const src = read("packages/db/src/schema/prefs.ts");
  assert.match(src, /export const userPrefs\b/);
  assert.match(src, /pgTable\(\s*"user_prefs"/);
  for (const col of ["density", "navStyle", "fontScale", "highContrast", "reducedMotion", "showWatermark", "uiLanguage", "ftuxSeenAt"]) {
    assert.match(src, new RegExp(col), `user_prefs must have ${col}`);
  }
  // CHECK constraints lock enum-like fields
  for (const ck of ["user_prefs_density_check", "user_prefs_nav_style_check", "user_prefs_font_scale_check", "user_prefs_ui_language_check"]) {
    assert.match(src, new RegExp(ck));
  }
});

test("API route exists with GET + PUT + audit-on-change", () => {
  const src = read("apps/web/src/app/api/user-prefs/route.ts");
  assert.match(src, /export async function GET\b/);
  assert.match(src, /export async function PUT\b/);
  assert.match(src, /recordAudit/);
  assert.match(src, /user_prefs\.update/);
});

test("schema/index.ts barrels prefs", () => {
  assert.match(read("packages/db/src/schema/index.ts"), /from\s+"\.\/prefs"/);
});
