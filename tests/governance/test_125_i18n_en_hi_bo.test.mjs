// Governance test for spec 125 — Real i18n (English / Hindi / Bhoti).
//
// Verifies that:
//   1. The next-intl runtime dependency is declared.
//   2. The i18n config module exports the three-locale registry plus the
//      fallback / font helpers, and the three locale JSON bundles exist
//      and share the same namespaces.
//   3. The authenticated layout reads user_prefs.uiLanguage and wraps
//      children in NextIntlClientProvider.
//   4. Topbar, Sidebar, and BottomTabs are async server components that
//      call getTranslations() (next-intl/server) for their copy.
//   5. The section-gate page resolves translated copy.
//   6. The /login route segment has a server-rendered NextIntlClientProvider
//      layout + the page uses useTranslations() for its labels.
//   7. The dashboard uses getTranslations() for its proof-of-life headings.
//   8. The five spec-kit files exist and plan.md follows the
//      CREATED/EDITED/MIGRATED contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

const SPEC_DIR = "specs/125-i18n-en-hi-bo";
const I18N_CONFIG = "apps/web/src/i18n/config.ts";
const EN = "apps/web/src/i18n/locales/en.json";
const HI = "apps/web/src/i18n/locales/hi.json";
const BO = "apps/web/src/i18n/locales/bo.json";
const AUTH_LAYOUT = "apps/web/src/app/(authenticated)/layout.tsx";
const TOPBAR = "apps/web/src/components/nav/Topbar.tsx";
const SIDEBAR = "apps/web/src/components/nav/Sidebar.tsx";
const BOTTOMTABS = "apps/web/src/components/nav/BottomTabs.tsx";
const GATE_PAGE = "apps/web/src/app/gate/[slug]/page.tsx";
const LOGIN_PAGE = "apps/web/src/app/login/page.tsx";
const LOGIN_LAYOUT = "apps/web/src/app/login/layout.tsx";
const DASHBOARD = "apps/web/src/app/(authenticated)/dashboard/page.tsx";

test("spec 125 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 125 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /next-intl/,
    "plan.md must call out the next-intl dependency add",
  );
});

test("spec 125 — apps/web/package.json declares next-intl ^4", () => {
  const pkg = readJson("apps/web/package.json");
  const dep = pkg.dependencies?.["next-intl"];
  assert.ok(dep, "apps/web/package.json must list next-intl as a dependency");
  assert.match(
    String(dep),
    /^\^?4/,
    "next-intl must be at major version 4 (Next 16 compatible)",
  );
});

test("spec 125 — i18n/config.ts exports the three-locale registry + helpers", () => {
  const src = read(I18N_CONFIG);
  assert.match(src, /SUPPORTED_LOCALES/, "config must export SUPPORTED_LOCALES");
  assert.match(src, /DEFAULT_LOCALE/, "config must export DEFAULT_LOCALE");
  assert.match(src, /normalizeLocale/, "config must export normalizeLocale narrowing");
  assert.match(src, /loadMessages/, "config must export loadMessages — does the per-key Bhoti→English fallback");
  assert.match(src, /LOCALE_FONT_FAMILY/, "config must expose the per-locale font-family map");
  // Bhoti fallback is the key contract — make sure the dev-only console.warn path is in place.
  assert.match(src, /console\.warn/, "loadMessages must warn on missing-key fallback in development");
  // The three locale codes must be enumerated.
  assert.match(src, /["']en["']/);
  assert.match(src, /["']hi["']/);
  assert.match(src, /["']bo["']/);
});

test("spec 125 — all three locale JSON bundles exist and seed ≥40 keys in en.json", () => {
  const en = readJson(EN);
  const hi = readJson(HI);
  const bo = readJson(BO);
  // Count leaf keys in the canonical English bundle.
  let enKeys = 0;
  for (const ns of Object.keys(en)) {
    enKeys += Object.keys(en[ns]).length;
  }
  assert.ok(enKeys >= 40, `en.json must seed at least 40 keys (got ${enKeys})`);
  // Hindi + Bhoti must declare the same set of namespaces so the deep-merge
  // fallback only needs per-key compensation, not whole-namespace.
  assert.deepEqual(
    Object.keys(hi).sort(),
    Object.keys(en).sort(),
    "hi.json must declare the same namespaces as en.json",
  );
  assert.deepEqual(
    Object.keys(bo).sort(),
    Object.keys(en).sort(),
    "bo.json must declare the same namespaces as en.json",
  );
  // Spot-check a few critical translations made it into the bundles.
  assert.ok(en.action?.signIn, "en.action.signIn must exist");
  assert.ok(hi.action?.signIn, "hi.action.signIn must be translated");
  assert.ok(bo.action?.signIn, "bo.action.signIn must be translated");
  assert.ok(en.nav?.dashboard, "en.nav.dashboard must exist");
});

test("spec 125 — authenticated layout reads user_prefs.uiLanguage and provides NextIntlClientProvider", () => {
  const src = read(AUTH_LAYOUT);
  assert.match(src, /NextIntlClientProvider/, "authenticated layout must mount NextIntlClientProvider");
  assert.match(src, /userPrefs/, "authenticated layout must query user_prefs (the locale source of truth)");
  assert.match(src, /uiLanguage/, "authenticated layout must select user_prefs.uiLanguage");
  assert.match(src, /normalizeLocale/, "authenticated layout must call normalizeLocale on the column value");
  assert.match(src, /loadMessages/, "authenticated layout must call loadMessages for the resolved locale");
});

test("spec 125 — Topbar is an async server component with next-intl/server translations", () => {
  const src = read(TOPBAR);
  assert.match(
    src,
    /from\s+["']next-intl\/server["']/,
    "Topbar must import from next-intl/server (server-component translations)",
  );
  assert.match(src, /getTranslations/, "Topbar must call getTranslations()");
  assert.match(src, /export async function Topbar/, "Topbar must be an async function");
  assert.ok(
    !/^\s*["']use client["']/m.test(src),
    "Topbar must remain a server component — no 'use client' boundary",
  );
});

test("spec 125 — Sidebar is an async server component with translated section + nav labels", () => {
  const src = read(SIDEBAR);
  assert.match(src, /from\s+["']next-intl\/server["']/);
  assert.match(src, /getTranslations/);
  assert.match(src, /export async function Sidebar/);
  // Section and item key maps must be present so adding a new nav row is a
  // pure-data change (no JSX-level edits to the sidebar).
  assert.match(src, /SECTION_KEY/, "Sidebar must keep a SECTION_KEY map");
  assert.match(src, /ITEM_KEY/, "Sidebar must keep an ITEM_KEY map");
});

test("spec 125 — BottomTabs is an async server component with translated mobile tab labels", () => {
  const src = read(BOTTOMTABS);
  assert.match(src, /from\s+["']next-intl\/server["']/);
  assert.match(src, /getTranslations/);
  assert.match(src, /export async function BottomTabs/);
  assert.match(src, /TAB_KEY/, "BottomTabs must map mobile tab ids to nav.* keys");
});

test("spec 125 — gate/[slug] page is a server component that reads user_prefs + emits a NextIntlClientProvider", () => {
  const src = read(GATE_PAGE);
  assert.match(src, /NextIntlClientProvider/, "gate page must provide NextIntlClientProvider (it's outside (authenticated))");
  assert.match(src, /getTranslations/, "gate page must resolve translated copy via getTranslations");
  assert.match(src, /userPrefs/, "gate page must read user_prefs to find the locale");
  // The page must still reference verifyGate (spec 035 contract).
  assert.match(src, /verifyGate/, "gate page still references the verifyGate server action (spec 035 contract)");
  // GATE_BY_SLUG meta must cover every spec-035 slug.
  for (const slug of ["mentorship", "observation", "admin", "tkt", "ttt"]) {
    assert.match(
      src,
      new RegExp(`${slug}:`),
      `GATE_BY_SLUG must include ${slug}`,
    );
  }
});

test("spec 125 — /login has a server-rendered NextIntlClientProvider layout and useTranslations() in page", () => {
  const layoutSrc = read(LOGIN_LAYOUT);
  assert.match(layoutSrc, /NextIntlClientProvider/, "login/layout.tsx must wrap with NextIntlClientProvider");
  assert.match(layoutSrc, /gml-locale/, "login layout must read the pre-auth gml-locale cookie");
  const pageSrc = read(LOGIN_PAGE);
  assert.match(pageSrc, /from\s+["']next-intl["']/, "login page must import useTranslations from next-intl");
  assert.match(pageSrc, /useTranslations/, "login page must call useTranslations() for label copy");
  // Spec 034 contract — the page must stay a client component.
  assert.match(pageSrc, /^"use client";/, "login page must remain a client component (spec 034 contract)");
});

test("spec 125 — dashboard uses getTranslations() for the greeting + headings (proof-of-life)", () => {
  const src = read(DASHBOARD);
  assert.match(src, /from\s+["']next-intl\/server["']/);
  assert.match(src, /tDash/, "dashboard must hold a tDash translator handle");
  assert.match(
    src,
    /tDash\("morning"\)/,
    "dashboard greeting must translate the morning string via tDash",
  );
  assert.match(
    src,
    /tDash\("confidentiality"\)/,
    "dashboard right-column heading must translate Confidentiality",
  );
});

test("spec 125 — Bhoti bundle uses Tibetan script for nav.dashboard, not a romanisation", () => {
  const bo = readJson(BO);
  // A naive smoke-check that the Bhoti translation actually used Tibetan
  // script — any U+0F00–U+0FFF codepoint counts. This guards against a
  // future drive-by edit that silently overwrites the bundle with English.
  const value = bo.nav?.dashboard ?? "";
  assert.ok(
    /[ༀ-࿿]/.test(value),
    `bo.nav.dashboard must contain at least one Tibetan-script codepoint (got "${value}")`,
  );
});

test("spec 125 — Hindi bundle uses Devanagari for nav.dashboard, not a romanisation", () => {
  const hi = readJson(HI);
  const value = hi.nav?.dashboard ?? "";
  assert.ok(
    /[ऀ-ॿ]/.test(value),
    `hi.nav.dashboard must contain at least one Devanagari codepoint (got "${value}")`,
  );
});

test("spec 125 — no TODO / FIXME markers leaked into shipped i18n source", () => {
  for (const path of [I18N_CONFIG, AUTH_LAYOUT, TOPBAR, SIDEBAR, BOTTOMTABS, GATE_PAGE, LOGIN_PAGE, LOGIN_LAYOUT]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
