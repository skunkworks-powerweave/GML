// Governance test for spec 136 — mobile-login-layout
// (Workflow Run 12 frontend parity — final).
//
// Closes the LMS GML Frontend/mobile-login.jsx port. Three files are under
// audit:
//
//   1. apps/web/src/app/login/page.tsx
//      — converted from a flat "use client" page to a server component that
//        reads getDeviceType() and dispatches to either DesktopLogin or
//        MobileLogin. The Auth.js server actions + magic-link contracts are
//        unchanged; only the rendering tree changed.
//   2. apps/web/src/app/login/DesktopLogin.tsx
//      — the original two-pane brand+form layout, lifted into its own client
//        component verbatim so the desktop UX stays pixel-identical.
//   3. apps/web/src/app/login/MobileLogin.tsx
//      — the new mobile layout: full-bleed mountain SVG hero (saffron→indigo
//        gradient), large 44px+ touch-target email/password inputs, a "Sign
//        in" primary button, a "Sign in with magic link" toggle, the language
//        picker as a horizontal pill row anchored to the bottom with
//        safe-area-inset-bottom env() padding for notch devices, and a
//        programme footer disclosure.
//
// Plus the five spec-kit files under specs/136-mobile-login-layout/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PAGE_PATH = "apps/web/src/app/login/page.tsx";
const MOBILE_PATH = "apps/web/src/app/login/MobileLogin.tsx";
const DESKTOP_PATH = "apps/web/src/app/login/DesktopLogin.tsx";
const SPEC_DIR = "specs/136-mobile-login-layout";

test("spec 136 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the mobile login layout spec`,
    );
  }
});

test("spec 136 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /MobileLogin\.tsx/,
    "plan.md must call out the new MobileLogin component in CREATED",
  );
  assert.match(
    src,
    /page\.tsx/,
    "plan.md must call out the login page.tsx edit",
  );
});

test("spec 136 — page.tsx is now a server component that branches on device", () => {
  const src = read(PAGE_PATH);
  // The original page.tsx was a flat "use client" page. To call the server-
  // only getDeviceType(), the new shell must be a server component. The
  // "use client" pragma must be GONE from page.tsx.
  assert.ok(
    !/^\s*["']use client["']/m.test(src),
    "page.tsx must NOT declare 'use client' — it's now a server component that branches on device",
  );
  // The server-side device read.
  assert.match(
    src,
    /import\s*\{\s*getDeviceType\s*\}\s*from\s*"@\/lib\/device"/,
    "page.tsx must import getDeviceType from the server-only device helper",
  );
  assert.match(
    src,
    /await\s+getDeviceType\(\)/,
    "page.tsx must await getDeviceType() to pick the layout",
  );
  // Both subcomponents must be imported.
  assert.match(
    src,
    /import\s*\{\s*MobileLogin\s*\}\s*from\s*"\.\/MobileLogin"/,
    "page.tsx must import MobileLogin from the co-located client file",
  );
  assert.match(
    src,
    /import\s*\{\s*DesktopLogin\s*\}\s*from\s*"\.\/DesktopLogin"/,
    "page.tsx must import DesktopLogin from the co-located client file",
  );
  // The branch must be explicit.
  assert.match(
    src,
    /device === "mobile"/,
    "page.tsx must branch on device === 'mobile' to pick MobileLogin",
  );
});

test("spec 136 — MobileLogin.tsx exists and is a client component", () => {
  assert.ok(existsSync(resolve(root, MOBILE_PATH)), `${MOBILE_PATH} must exist`);
  const src = read(MOBILE_PATH);
  assert.match(
    src,
    /^\s*["']use client["']/m,
    "MobileLogin must declare 'use client' — it owns useState (mode toggle) + useActionState",
  );
  assert.match(
    src,
    /export function MobileLogin/,
    "MobileLogin must export a named MobileLogin function so page.tsx can import it",
  );
});

test("spec 136 — MobileLogin uses the same Auth.js server action contract", () => {
  const src = read(MOBILE_PATH);
  // Same loginAction import — auth logic must NOT change across desktop /
  // mobile shells. The mobile layout is presentation only.
  assert.match(
    src,
    /import\s*\{\s*loginAction[\s\S]*?\}\s*from\s*"\.\/actions"/,
    "MobileLogin must import loginAction from the shared actions.ts",
  );
  assert.match(
    src,
    /useActionState/,
    "MobileLogin must wire the form via useActionState (matches the desktop contract)",
  );
  // Magic-link path must still be available.
  assert.match(
    src,
    /import\s*\{\s*EmailLinkForm\s*\}\s*from\s*"\.\/email-link-form"/,
    "MobileLogin must reuse the shared EmailLinkForm component for the magic-link path",
  );
});

test("spec 136 — MobileLogin renders the brand hero with the mountain SVG", () => {
  const src = read(MOBILE_PATH);
  // Full-bleed hero with the saffron→indigo gradient that the prototype uses.
  assert.match(
    src,
    /data-testid="mobile-login-hero"/,
    "MobileLogin must mark the hero panel with the mobile-login-hero testid",
  );
  // Mountain silhouette path (matches the mobile-login.jsx silhouette geometry).
  assert.match(
    src,
    /<svg\b[\s\S]*viewBox="0 0 412 220"/,
    "MobileLogin must embed the mountain SVG with the 412x220 viewBox from the prototype",
  );
  // Saffron→indigo gradient (the brand colour stack from the JSX hero).
  assert.match(
    src,
    /oklch\(0\.32 0\.08 268\)/,
    "MobileLogin hero must use the indigo top oklch from the prototype",
  );
});

test("spec 136 — MobileLogin renders 44px+ touch-target inputs and primary CTA", () => {
  const src = read(MOBILE_PATH);
  // Email + password inputs with the data-testids the test asserts.
  assert.match(
    src,
    /data-testid="mobile-email"/,
    "MobileLogin must render the email input with the mobile-email testid",
  );
  assert.match(
    src,
    /data-testid="mobile-password"/,
    "MobileLogin must render the password input with the mobile-password testid",
  );
  // Apple HIG / Material Design — 44px minimum touch target.
  assert.match(
    src,
    /minHeight:\s*44/,
    "MobileLogin inputs / buttons must set minHeight: 44 (Apple HIG touch target)",
  );
  // Primary CTA — the "Sign in" button.
  assert.match(
    src,
    /data-testid="mobile-signin-button"/,
    "MobileLogin must render the primary Sign in button with the mobile-signin-button testid",
  );
  // The mode toggle between password and magic link.
  assert.match(
    src,
    /data-testid="mobile-mode-toggle"/,
    "MobileLogin must render a mode toggle between password and magic-link sign-in",
  );
});

test("spec 136 — MobileLogin renders the language picker pill row", () => {
  const src = read(MOBILE_PATH);
  // The language picker is a horizontal pill row anchored to the bottom of
  // the screen with the three locale buttons.
  assert.match(
    src,
    /data-testid="mobile-language-row"/,
    "MobileLogin must render a language pill row with the mobile-language-row testid",
  );
  // EN button.
  assert.match(
    src,
    />\s*EN\s*</,
    "MobileLogin language row must include the EN locale button",
  );
  // Hindi label (Devanagari).
  assert.match(
    src,
    /हिं|हिन्दी/,
    "MobileLogin language row must include the Hindi locale label (Devanagari)",
  );
  // Bhoti/Ladakhi label — TIBETAN script. This assertion used to require an
  // ARABIC letter here (it matched U+0644), which is how the pill shipped two
  // Arabic letters for months: the test enforced the defect, and after the
  // button was fixed it still passed on a stale source comment. The pill now
  // renders the shared constant, so assert that, assert the constant is
  // Tibetan, and assert no Arabic-script character survives anywhere in the
  // file. The rendered output is checked in tests/behaviour/ui-i18n.test.ts.
  assert.match(
    src,
    /\{LOCALE_LABELS\.bo\.script\}/,
    "MobileLogin's Bhoti pill must render LOCALE_LABELS.bo.script, not a hand-copied glyph",
  );
  assert.match(
    read("apps/web/src/i18n/config.ts"),
    /bo:\s*\{[^}]*script:\s*"བོད/,
    "LOCALE_LABELS.bo.script must be the Tibetan-script abbreviation for Bhoti",
  );
  assert.doesNotMatch(
    src,
    /[؀-ۿ]/,
    "MobileLogin must not contain Arabic-script characters (U+0600-U+06FF): Bhoti is written in Tibetan",
  );
});

test("spec 136 — MobileLogin honors safe-area-inset for notch devices", () => {
  const src = read(MOBILE_PATH);
  // Bottom safe-area padding for iOS notch / Android gesture bar — the
  // language pill row sits at the bottom and must respect the home indicator.
  assert.match(
    src,
    /safe-area-inset-bottom|env\(safe-area-inset/,
    "MobileLogin must reference env(safe-area-inset-*) for notch / home-indicator clearance",
  );
});

test("spec 136 — MobileLogin renders a programme footer disclosure", () => {
  const src = read(MOBILE_PATH);
  // The footer must announce that this is the Goldenmile programme and carry
  // a build/version marker (matches the desktop right-pane footer).
  assert.match(
    src,
    /data-testid="mobile-login-footer"/,
    "MobileLogin must render a footer with the mobile-login-footer testid",
  );
  assert.match(
    src,
    /Goldenmile|programme|audited/i,
    "MobileLogin footer must mention the Goldenmile programme / audit disclosure",
  );
});

test("spec 136 — DesktopLogin.tsx exists and preserves the original two-pane layout", () => {
  assert.ok(existsSync(resolve(root, DESKTOP_PATH)), `${DESKTOP_PATH} must exist`);
  const src = read(DESKTOP_PATH);
  assert.match(
    src,
    /^\s*["']use client["']/m,
    "DesktopLogin must remain a 'use client' component",
  );
  assert.match(
    src,
    /export function DesktopLogin/,
    "DesktopLogin must export a named DesktopLogin function",
  );
  // Spec 034 contract — the Hindi + Ladakhi literal labels must still appear
  // in the file the original spec gated on.
  assert.match(
    src,
    /हिन्दी/,
    "DesktopLogin must still contain the हिन्दी literal (spec 034 governance contract)",
  );
  assert.match(
    src,
    /Ladakhi/,
    "DesktopLogin must still contain the Ladakhi literal (spec 034 governance contract)",
  );
});

test("spec 136 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [PAGE_PATH, MOBILE_PATH, DESKTOP_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});
