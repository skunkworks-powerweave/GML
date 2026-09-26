// Governance test for spec 169 — Mobile and privacy polish
// (Workflow Run 16 post-audit hardening).
//
// Four polish items under audit:
//
//   A. MobileQuizRunner imports + wires useSwipe.
//   B. QuickFind exports clearAllQuickFindRecents(); Topbar calls it
//      via the new SignOutButton client island before the form submit.
//   C. lib/env.ts exports assertEnv(); the authenticated layout calls
//      it; UploadModal + HelpPanel hide the WhatsApp affordance when
//      the validated phone is missing or invalid.
//   D. (SUPERSEDED 2026-09) i18n bundles shipped login.forgot.* /
//      login.reset.* / forbidden.* keys that no page read. They were
//      deleted; see the §D test below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

const SPEC_DIR = "specs/169-mobile-and-privacy-polish";
const MOBILE_QUIZ = "apps/web/src/components/quiz/MobileQuizRunner.tsx";
const QUICKFIND = "apps/web/src/components/quickfind/QuickFind.tsx";
const SIGNOUT_BUTTON = "apps/web/src/components/nav/SignOutButton.tsx";
const TOPBAR = "apps/web/src/components/nav/Topbar.tsx";
const ENV_LIB = "apps/web/src/lib/env.ts";
const AUTH_LAYOUT = "apps/web/src/app/(authenticated)/layout.tsx";
const HELP_PANEL = "apps/web/src/components/help/HelpPanel.tsx";
const UPLOAD_MODAL = "apps/web/src/components/video/UploadModal.tsx";
const I18N_CONFIG = "apps/web/src/i18n/config.ts";
const EN_JSON = "apps/web/src/i18n/locales/en.json";
const HI_JSON = "apps/web/src/i18n/locales/hi.json";
const BO_JSON = "apps/web/src/i18n/locales/bo.json";

// ---------- Spec-kit + plan.md contract ----------

test("spec 169 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the mobile-and-privacy-polish spec`,
    );
  }
});

test("spec 169 — plan.md follows the CREATED/EDITED/MIGRATED contract and names the touched files", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  for (const file of [
    "MobileQuizRunner.tsx",
    "QuickFind.tsx",
    "SignOutButton.tsx",
    "Topbar.tsx",
    "env.ts",
    "layout.tsx",
    "HelpPanel.tsx",
    "UploadModal.tsx",
    "en.json",
    "hi.json",
    "bo.json",
  ]) {
    assert.match(
      src,
      new RegExp(file),
      `plan.md must call out the ${file} touchpoint so the surface is discoverable`,
    );
  }
});

// ---------- A. MobileQuizRunner useSwipe ----------

test("spec 169 — MobileQuizRunner.tsx imports useSwipe from @/lib/use-swipe", () => {
  const src = read(MOBILE_QUIZ);
  assert.match(
    src,
    /import\s*\{\s*useSwipe\s*\}\s*from\s*["']@\/lib\/use-swipe["']/,
    "MobileQuizRunner must `import { useSwipe } from \"@/lib/use-swipe\"` so the gesture hook is wired (same pattern MobileFormRunner uses since spec 139)",
  );
});

test("spec 169 — MobileQuizRunner.tsx wires useSwipe(goNext, goPrev) on the root container", () => {
  const src = read(MOBILE_QUIZ);
  // The named goNext / goPrev helpers MUST exist so swipe + button
  // share one code path — pinning the named declarations so a future
  // contributor can't silently re-inline them.
  assert.match(
    src,
    /const\s+goNext\s*=/,
    "MobileQuizRunner must declare a `goNext` helper that swipe-left + the Next button share",
  );
  assert.match(
    src,
    /const\s+goPrev\s*=/,
    "MobileQuizRunner must declare a `goPrev` helper that swipe-right + the Previous button share",
  );
  assert.match(
    src,
    /useSwipe\s*<\s*HTMLDivElement\s*>\s*\(/,
    "MobileQuizRunner must call `useSwipe<HTMLDivElement>(...)` typed on the container element",
  );
  // The ref + touchAction: pan-y wire is what lets the gesture work
  // without hijacking native vertical scroll. Pinning both.
  assert.match(
    src,
    /ref\s*=\s*\{\s*swipeRef\s*\}/,
    "MobileQuizRunner must attach the swipeRef returned from useSwipe to its root container",
  );
  assert.match(
    src,
    /touchAction:\s*["']pan-y["']/,
    "MobileQuizRunner root container must set `touchAction: \"pan-y\"` so vertical scroll stays native and the horizontal travel is the swipe",
  );
});

test("spec 169 — MobileQuizRunner carries a Spec 169 reference", () => {
  const src = read(MOBILE_QUIZ);
  assert.match(
    src,
    /Spec 169/,
    "MobileQuizRunner must carry an inline `Spec 169` comment so the swipe wiring is self-documenting",
  );
});

// ---------- B. QuickFind localStorage clear on sign-out ----------

test("spec 169 — QuickFind.tsx exports clearAllQuickFindRecents()", () => {
  const src = read(QUICKFIND);
  assert.match(
    src,
    /export\s+function\s+clearAllQuickFindRecents\s*\(\s*\)\s*:\s*void/,
    "QuickFind.tsx must export `clearAllQuickFindRecents(): void` so the sign-out path can wipe device-local recents on a shared device",
  );
  // The helper MUST walk the gml.quickfind.recent. prefix — pinning so
  // a future contributor can't silently swap to a different key shape
  // without the test catching the change.
  assert.match(
    src,
    /gml\.quickfind\.recent\./,
    "clearAllQuickFindRecents must match the canonical `gml.quickfind.recent.` localStorage key prefix",
  );
  // The implementation MUST iterate localStorage keys (a forEach /
  // for-loop over .key(i)) and removeItem — anything else would not
  // catch orphaned keys from previous accounts.
  assert.match(
    src,
    /localStorage\.removeItem/,
    "clearAllQuickFindRecents must call localStorage.removeItem to actually clear the recents",
  );
});

test("spec 169 — SignOutButton.tsx exists as a 'use client' island and calls the QuickFind clear", () => {
  assert.ok(
    existsSync(resolve(root, SIGNOUT_BUTTON)),
    `${SIGNOUT_BUTTON} must exist as the new sign-out client wrapper`,
  );
  const src = read(SIGNOUT_BUTTON);
  assert.match(
    src,
    /^["']use client["']/m,
    "SignOutButton must begin with the 'use client' directive — it owns an onClick handler that touches localStorage",
  );
  assert.match(
    src,
    /clearAllQuickFindRecents/,
    "SignOutButton must call clearAllQuickFindRecents in its onClick so device-local QuickFind recents are wiped before the form submits",
  );
  assert.match(
    src,
    /from\s*["']@\/components\/quickfind\/QuickFind["']/,
    "SignOutButton must import clearAllQuickFindRecents from the QuickFind module so the prefix-key is owned by one source of truth",
  );
});

test("spec 169 — Topbar.tsx imports and renders the SignOutButton inside the sign-out form", () => {
  const src = read(TOPBAR);
  assert.match(
    src,
    /import\s*\{\s*SignOutButton\s*\}\s*from\s*["']\.\/SignOutButton["']/,
    "Topbar must `import { SignOutButton } from \"./SignOutButton\"` so the user-pill form uses the client wrapper",
  );
  assert.match(
    src,
    /<SignOutButton\b/,
    "Topbar must render a <SignOutButton /> element inside the sign-out form (replacing the inline <button type=\"submit\">)",
  );
});

// ---------- C. assertEnv() + UploadModal/HelpPanel WhatsApp gating ----------

test("spec 169 — lib/env.ts exists and exports assertEnv()", () => {
  assert.ok(
    existsSync(resolve(root, ENV_LIB)),
    `${ENV_LIB} must exist as the env-validation helper`,
  );
  const src = read(ENV_LIB);
  assert.match(
    src,
    /export\s+function\s+assertEnv\s*\(\s*\)\s*:\s*EnvSummary/,
    "env.ts must export `assertEnv(): EnvSummary` so the authenticated layout can call it",
  );
  // The three env vars MUST be checked by name. Pinning each so a
  // future contributor can't silently drop one without the test
  // catching the gap.
  assert.match(
    src,
    /GML_WHATSAPP_NUMBER/,
    "env.ts must check GML_WHATSAPP_NUMBER",
  );
  assert.match(
    src,
    /GML_HELPDESK_PHONE/,
    "env.ts must check GML_HELPDESK_PHONE",
  );
  assert.match(
    src,
    /GML_HELPDESK_EMAIL/,
    "env.ts must check GML_HELPDESK_EMAIL",
  );
  // The phone regex MUST match /^\+\d{8,15}$/ per the spec.
  assert.match(
    src,
    /\^\\\+\\d\{8,15\}\$/,
    "env.ts must use the literal /^\\+\\d{8,15}$/ phone pattern (E.164 with mandatory + and 8-15 digits)",
  );
  // SEVERE log line in production — pinning the literal marker so a
  // future contributor can't silently downgrade the log severity.
  assert.match(
    src,
    /\[SEVERE\]/,
    "env.ts production log line must contain the literal `[SEVERE]` prefix for log-shipper filtering",
  );
  // The function MUST NOT throw on invalid env. The contract is
  // soft-fail by design. Pin the absence of a `throw new Error` /
  // `throw new` call inside assertEnv.
  assert.ok(
    !/throw\s+new\s+/.test(src),
    "env.ts assertEnv must NEVER throw on invalid env — soft-fail contract: log SEVERE in production, return null in the summary",
  );
});

test("spec 169 — authenticated layout calls assertEnv()", () => {
  const src = read(AUTH_LAYOUT);
  assert.match(
    src,
    /import\s*\{[^}]*\bassertEnv\b[^}]*\}\s*from\s*["']@\/lib\/env["']/,
    "(authenticated)/layout.tsx must `import { assertEnv } from \"@/lib/env\"` so the validation runs once per render",
  );
  assert.match(
    src,
    /assertEnv\s*\(\s*\)/,
    "(authenticated)/layout.tsx must call assertEnv() so the production SEVERE-log path engages on a misconfigured deployment",
  );
});

test("spec 169 — UploadModal hides the WhatsApp section when the phone is invalid/unset", () => {
  const src = read(UPLOAD_MODAL);
  // The predicate function — pinning the name so a future contributor
  // doesn't silently rename it and break the gate.
  assert.match(
    src,
    /function\s+isUsableWhatsappPhone\s*\(/,
    "UploadModal.tsx must declare `function isUsableWhatsappPhone(...)` as the WhatsApp-section gate",
  );
  // The gate MUST wrap the WhatsApp section, not just toggle a
  // disabled stub. We pin the conditional render pattern.
  assert.match(
    src,
    /\{\s*isUsableWhatsappPhone\s*\(\s*whatsappPhone\s*\)\s*\?/,
    "UploadModal.tsx must wrap the WhatsApp Path 1 section in `{isUsableWhatsappPhone(whatsappPhone) ? ... : null}` so the section is removed from the DOM on a bad/missing env value",
  );
});

test("spec 169 — HelpPanel hides the WhatsApp action row when contact phone is invalid/unset", () => {
  const src = read(HELP_PANEL);
  assert.match(
    src,
    /function\s+isUsableWhatsappContact\s*\(/,
    "HelpPanel.tsx must declare `function isUsableWhatsappContact(...)` as the wa.me href gate",
  );
  // The disabled-stub branch for the WhatsApp row MUST be REMOVED;
  // pin its absence. The stub used the literal phrase
  // "WhatsApp programme team (number not configured)".
  assert.ok(
    !/WhatsApp programme team \(number not configured\)/.test(src),
    "HelpPanel.tsx must not contain the disabled-stub `WhatsApp programme team (number not configured)` branch — the row is hidden entirely when the phone is invalid",
  );
});

// ---------- D. i18n coverage ----------

// §D SUPERSEDED (2026-09 freeze, fix brief D_ui #8). These three tests
// asserted only that the bundles DECLARED login.forgot.* / login.reset.* /
// forbidden.* -- keys no page ever read. forgot/page.tsx, reset/page.tsx and
// forbidden/page.tsx hardcode their copy, and the keys described a product
// that no longer exists: a 15-minute account lock that was deliberately
// removed, an "SMTP not configured" framing forgot/page.tsx rejects, a single
// "Access denied" title where the page has four distinct reasons. Rendering
// them would have told users false things; declaring them told the IT team
// three pages were translated when none was. The namespaces were deleted, and
// the test below pins that, so they cannot quietly come back unread. If those
// pages are ever localised: wire getTranslations/useTranslations in the page
// first, then add keys whose copy matches what the page actually says.
// tests/behaviour/ui-i18n.test.ts checks the general rule for every namespace.
//
// UPDATED (F90). The login page's sign-in errors are now localised the way this
// comment prescribes: app/login/login-error.tsx reads useTranslations("login")
// and renders login.error.* (tests/behaviour/ui-login-errors.test.ts renders it
// in Hindi and Bhoti). So a `login` namespace exists again, READ. What stays
// pinned is the part that was dead: login.forgot.* / login.reset.* and
// forbidden.*, whose pages still hardcode their copy.
test("spec 169 §D (superseded) — the dead login / forbidden namespaces stay deleted from every bundle", () => {
  for (const [name, path] of [["en", EN_JSON], ["hi", HI_JSON], ["bo", BO_JSON]]) {
    const bundle = readJson(path);
    assert.equal(bundle.login?.forgot, undefined, `${name}.json must not re-declare the unread login.forgot.* namespace`);
    assert.equal(bundle.login?.reset, undefined, `${name}.json must not re-declare the unread login.reset.* namespace`);
    assert.equal(bundle.forbidden, undefined, `${name}.json must not re-declare the unread forbidden.* namespace`);
  }
  if (readJson(EN_JSON).login !== undefined) {
    assert.match(
      read("apps/web/src/app/login/login-error.tsx"),
      /useTranslations\("login"\)/,
      "a login namespace is only allowed while the login page reads it",
    );
  }
});

test("spec 169 — i18n config.ts loadMessages handles nested objects with per-leaf fallback + dev warn", () => {
  const src = read(I18N_CONFIG);
  // The recursive walker must exist — pinning the name so a future
  // contributor can't silently rewrite the merge in a way that drops
  // the nested-object path.
  assert.match(
    src,
    /mergeRecursive/,
    "config.ts must declare a `mergeRecursive` helper that walks nested message values per-leaf",
  );
  // The empty-string-as-missing rule — pin the literal predicate so
  // an editor can't silently change it to `.length >= 0`.
  assert.match(
    src,
    /\.length\s*>\s*0/,
    "loadMessages must treat empty strings as MISSING (`targetGroup.length > 0`) so the bo placeholders fall back to English",
  );
  assert.match(
    src,
    /console\.warn/,
    "loadMessages must warn on the dev-only console when a translation key falls back to English",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 169 — no new dependencies were introduced (no new logger / swipe library / env-validator)", () => {
  // The fix is pure logic — no new logger / gesture / env-validator
  // package should have crept into apps/web/package.json. zod is a
  // pre-existing dep, not new — excluded from the prohibited list.
  const webPkg = read("apps/web/package.json");
  for (const dep of ["envalid", "react-swipeable", "hammer", "react-use-gesture", "@use-gesture"]) {
    assert.ok(
      !new RegExp(`"${dep}"`).test(webPkg),
      `apps/web must not depend on ${dep} — spec 169 uses only the existing useSwipe hook + hand-rolled assertEnv`,
    );
  }
});

test("spec 169 — no TODO / FIXME / placeholder markers leaked into shipped source for the polish files", () => {
  for (const path of [
    MOBILE_QUIZ,
    QUICKFIND,
    SIGNOUT_BUTTON,
    TOPBAR,
    ENV_LIB,
    AUTH_LAYOUT,
    HELP_PANEL,
    UPLOAD_MODAL,
    I18N_CONFIG,
  ]) {
    const src = read(path);
    assert.ok(
      !/\bTODO\b/i.test(src),
      `${path} must not contain TODO markers — the polish round explicitly cleaned them up`,
    );
    assert.ok(
      !/\bFIXME\b/i.test(src),
      `${path} must not contain FIXME markers`,
    );
  }
});
