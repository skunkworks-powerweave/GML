import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

test("device.ts exports getDeviceType (server) using cookies + UA fallback", () => {
  const src = read("apps/web/src/lib/device.ts");
  assert.match(src, /export async function getDeviceType/);
  assert.match(src, /cookies\(\)/);
  assert.match(src, /user-agent/i);
  assert.match(src, /gml-device/);
});

test("use-device.ts exports useDeviceType (client) with matchMedia", () => {
  const src = read("apps/web/src/lib/use-device.ts");
  assert.match(src, /^"use client";/);
  assert.match(src, /export function useDeviceType/);
  assert.match(src, /matchMedia/);
  assert.match(src, /max-width:\s*768px/);
});

test("NAV_BY_ROLE has all 5 roles with role-aware sections", () => {
  const src = read("apps/web/src/config/nav.ts");
  assert.match(src, /export const NAV_BY_ROLE/);
  for (const role of ["super_admin", "programme_admin", "mentor", "observer", "teacher"]) {
    assert.match(src, new RegExp(`${role}:\\s*\\[`), `NAV_BY_ROLE must have ${role}`);
  }
  // Section gates appear on the right nav items
  assert.match(src, /gate:\s*"mentorship"/);
  assert.match(src, /gate:\s*"observation"/);
  assert.match(src, /gate:\s*"admin"/);
});

// Title corrected: it said "≤5 tabs each" but only ever asserted the export,
// and the teacher bar now has six (uploads). The tab contents are executed in
// tests/behaviour/ui-navigation.test.ts.
test("TABS_BY_ROLE is exported for the mobile tab bar", () => {
  const src = read("apps/web/src/config/nav.ts");
  assert.match(src, /export const TABS_BY_ROLE/);
});

test("Sidebar + BottomTabs + Topbar exist", () => {
  for (const f of ["Sidebar", "BottomTabs", "Topbar", "Icon"]) {
    assert.ok(existsSync(resolve(root, `apps/web/src/components/nav/${f}.tsx`)), `${f}.tsx must exist`);
  }
});

test("DesktopShell + MobileShell exist and accept children", () => {
  for (const shell of ["DesktopShell", "MobileShell"]) {
    const src = read(`apps/web/src/components/shells/${shell}.tsx`);
    assert.match(src, new RegExp(`export function ${shell}`));
    assert.match(src, /children/);
  }
});

test("(authenticated) layout selects shell via getDeviceType", () => {
  const src = read("apps/web/src/app/(authenticated)/layout.tsx");
  assert.match(src, /getDeviceType/);
  assert.match(src, /DesktopShell/);
  assert.match(src, /MobileShell/);
  assert.match(src, /auth\(\)/);
});

test("ConfidentialityFooter (SM-6) is rendered inside both shells", () => {
  for (const shell of ["DesktopShell", "MobileShell"]) {
    const src = read(`apps/web/src/components/shells/${shell}.tsx`);
    assert.match(src, /ConfidentialityFooter/);
  }
});

test("globals.css declares GML design tokens", () => {
  const src = read("apps/web/src/app/globals.css");
  for (const token of ["--paper", "--ink", "--saffron", "--lichen", "--rust", "--serif"]) {
    assert.match(src, new RegExp(token.replace(/-/g, "\\-")), `globals.css missing token ${token}`);
  }
});
