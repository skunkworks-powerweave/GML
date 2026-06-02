// Governance test for spec 155 — Topbar language picker + forms-runner
// audience gate (Workflow Run 14 audit-closure, MEDIUM severity).
//
// Three files under audit:
//
//   1. apps/web/src/components/nav/LanguagePicker.tsx (CREATED)
//      — new `"use client"` island. Receives the current locale as a
//        prop, PUTs `{ uiLanguage }` to /api/user-prefs on selection,
//        reloads the document so the NextIntlClientProvider in
//        (authenticated)/layout.tsx re-mounts with the new messages
//        bundle.
//
//   2. apps/web/src/components/nav/Topbar.tsx (EDITED)
//      — adds an optional `locale?: Locale` prop and replaces the
//        hardcoded `<details><summary>EN</summary>...</details>` block
//        with `<LanguagePicker current={locale} ... />`. The literal
//        `"EN"` chip label is gone — the chip is derived from the
//        prop inside the island.
//
//   3. apps/web/src/app/(authenticated)/forms/[slug]/page.tsx (EDITED)
//      — adds `AUDIENCE_ALLOWED_ROLES` map + `isAudienceAccessAllowed`
//        helper. After the `feedbackForms` SELECT the runner calls
//        the helper with `form.audience` and `session.user.role`; on
//        mismatch it fires `recordAudit({ action:
//        "form.access.denied", ... })` then `redirect("/forbidden")`.
//
// Plus the five spec-kit files under
// `specs/155-chrome-i18n-finish-and-forms-access/`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PICKER_PATH = "apps/web/src/components/nav/LanguagePicker.tsx";
const TOPBAR_PATH = "apps/web/src/components/nav/Topbar.tsx";
const SHELL_PATH = "apps/web/src/components/shells/DesktopShell.tsx";
const LAYOUT_PATH = "apps/web/src/app/(authenticated)/layout.tsx";
const RUNNER_PATH = "apps/web/src/app/(authenticated)/forms/[slug]/page.tsx";
const SPEC_DIR = "specs/155-chrome-i18n-finish-and-forms-access";

// ---------- Spec-kit + plan.md contract ----------

test("spec 155 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the chrome-i18n-finish-and-forms-access spec`,
    );
  }
});

test("spec 155 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /LanguagePicker\.tsx/,
    "plan.md must call out the LanguagePicker CREATED entry",
  );
  assert.match(
    src,
    /forms\/\[slug\]\/page\.tsx/,
    "plan.md must call out the forms runner EDITED entry",
  );
});

// ---------- LanguagePicker — client island shape ----------

test("spec 155 — LanguagePicker.tsx exists and is a 'use client' island", () => {
  assert.ok(
    existsSync(resolve(root, PICKER_PATH)),
    `${PICKER_PATH} must exist as a new client-island component`,
  );
  const src = read(PICKER_PATH);
  // The 'use client' directive MUST be the first non-blank line of the
  // file. Without it the island would be treated as a server component
  // and the useState / useEffect calls would not compile.
  assert.match(
    src,
    /^"use client";/m,
    "LanguagePicker.tsx must start with the \"use client\" directive — the island uses useState/useEffect and fetch",
  );
});

test("spec 155 — LanguagePicker PUTs to /api/user-prefs with a uiLanguage JSON body", () => {
  const src = read(PICKER_PATH);
  // The endpoint and the method together pin the contract — a sloppy
  // refactor that POSTs to a different route or PUTs the wrong field
  // shape would be caught here.
  assert.match(
    src,
    /fetch\(\s*"\/api\/user-prefs"\s*,\s*\{[\s\S]{0,400}method:\s*"PUT"/,
    "LanguagePicker must call `fetch(\"/api/user-prefs\", { method: \"PUT\", ... })` so the existing user-prefs endpoint accepts the change",
  );
  // The body must JSON-encode an object that includes `uiLanguage` — the
  // PrefsSchema in /api/user-prefs/route.ts is the source of truth for
  // the field name.
  assert.match(
    src,
    /JSON\.stringify\(\s*\{[^}]*uiLanguage[^}]*\}\s*\)/,
    "LanguagePicker must JSON.stringify a body that contains the `uiLanguage` key",
  );
});

test("spec 155 — LanguagePicker reloads the document after a successful save", () => {
  const src = read(PICKER_PATH);
  // The reload is the contract that closes the i18n race: without it
  // the NextIntlClientProvider in the authenticated layout would still
  // be holding the old messages bundle.
  assert.match(
    src,
    /window\.location\.reload\(\s*\)/,
    "LanguagePicker must call window.location.reload() after a successful PUT so the NextIntlClientProvider re-mounts with the new messages bundle",
  );
});

test("spec 155 — LanguagePicker accepts `current` as a Locale prop", () => {
  const src = read(PICKER_PATH);
  // The current-locale prop must be named `current` so the Topbar
  // integration is uniform; a renamed prop (`locale`, `value`, etc.)
  // would still compile but would break the spec.md contract.
  assert.match(
    src,
    /current:\s*LocaleCode|current:\s*Locale/,
    "LanguagePicker must declare a `current` prop typed against the locale enum",
  );
});

// ---------- Topbar — picker integration ----------

test("spec 155 — Topbar imports LanguagePicker and mounts it with the locale prop", () => {
  const src = read(TOPBAR_PATH);
  // The import + the mount together pin the integration. A sloppy
  // refactor that renames either side would be caught here.
  assert.match(
    src,
    /import\s+LanguagePicker\s+from\s+"\.\/LanguagePicker"/,
    "Topbar.tsx must import the default export of ./LanguagePicker",
  );
  assert.match(
    src,
    /<LanguagePicker\s+current=\{locale\}/,
    "Topbar.tsx must mount `<LanguagePicker current={locale} ... />` so the chip reflects the user's real uiLanguage",
  );
});

test("spec 155 — Topbar accepts an optional `locale?: Locale` prop", () => {
  const src = read(TOPBAR_PATH);
  // The new prop must be optional (default "en") so existing callers
  // that don't pass it keep compiling. The Locale type must be
  // imported from @/i18n/config to stay in lock-step with the
  // NextIntlClientProvider's locale enum.
  assert.match(
    src,
    /locale\?:\s*Locale/,
    "Topbar.tsx props must declare `locale?: Locale` (the LanguagePicker reads this for the active chip)",
  );
  assert.match(
    src,
    /from\s+"@\/i18n\/config"/,
    "Topbar.tsx must import the Locale type from @/i18n/config so the picker prop type matches the provider",
  );
});

test("spec 155 — Topbar no longer renders the hardcoded \"EN\" chip", () => {
  const src = read(TOPBAR_PATH);
  // The pre-fix shape rendered `<summary>EN</summary>` as a JSX text
  // node. We pin the ABSENCE of that exact shape so a future
  // contributor can't silently revert the picker to a static label.
  // The literal "EN" CAN appear inside comments or inside a string
  // literal for an aria-label / data attribute — we only forbid it as
  // JSX text content.
  assert.doesNotMatch(
    src,
    />\s*EN\s*<\/summary>/,
    "Topbar.tsx must not render `<summary>EN</summary>` — the chip is now derived from the locale prop inside the LanguagePicker island",
  );
});

// ---------- DesktopShell + layout — prop wire-through ----------

test("spec 155 — DesktopShell threads the locale prop through to Topbar", () => {
  const src = read(SHELL_PATH);
  assert.match(
    src,
    /locale\?:\s*Locale/,
    "DesktopShell.tsx props must declare `locale?: Locale` so the layout can pass it through",
  );
  assert.match(
    src,
    /<Topbar[\s\S]{0,400}locale=\{locale\}/,
    "DesktopShell must forward the locale prop to its Topbar child",
  );
});

test("spec 155 — authenticated layout passes its locale to DesktopShell", () => {
  const src = read(LAYOUT_PATH);
  // The layout already computes `locale = normalizeLocale(...)`; we
  // just confirm it now reaches the shell.
  assert.match(
    src,
    /<DesktopShell[\s\S]{0,600}locale=\{locale\}/,
    "(authenticated)/layout.tsx must pass `locale={locale}` to DesktopShell so the topbar picker reflects the user's real uiLanguage",
  );
});

// ---------- Forms runner — audience-vs-role gate ----------

test("spec 155 — forms runner imports RoleName and declares the AUDIENCE_ALLOWED_ROLES map", () => {
  const src = read(RUNNER_PATH);
  // The RoleName type pin keeps the map values from drifting into a
  // typo-friendly bare-string set ("mentor", "Mentor", "MENTOR" all
  // would compile against `string[]` but only one is correct).
  assert.match(
    src,
    /import\s+type\s+\{\s*RoleName\s*\}\s+from\s+"@gml\/shared\/auth\/roles"/,
    "forms/[slug]/page.tsx must `import type { RoleName } from \"@gml/shared/auth/roles\"`",
  );
  // The map itself is the source of truth for the audience gate; we
  // pin its shape so a future refactor that flattens it would have to
  // come back through this test.
  assert.match(
    src,
    /AUDIENCE_ALLOWED_ROLES/,
    "forms/[slug]/page.tsx must declare an AUDIENCE_ALLOWED_ROLES table",
  );
  assert.match(
    src,
    /mentor:\s*\[\s*"mentor"\s*\]/,
    "AUDIENCE_ALLOWED_ROLES must map `mentor` audience to the `mentor` role",
  );
  assert.match(
    src,
    /mentee:\s*\[\s*"teacher"\s*\]/,
    "AUDIENCE_ALLOWED_ROLES must map `mentee` audience to the `teacher` role (in this codebase a mentee IS a teacher)",
  );
});

test("spec 155 — forms runner audits form.access.denied and redirects to /forbidden", () => {
  const src = read(RUNNER_PATH);
  // The audit and the redirect together close the gate — pinning both
  // protects against a sloppy refactor that drops one or the other.
  assert.match(
    src,
    /isAudienceAccessAllowed\(\s*form\.audience\s*,/,
    "forms/[slug]/page.tsx must call isAudienceAccessAllowed(form.audience, ...) to gate the runner",
  );
  assert.match(
    src,
    /action:\s*"form\.access\.denied"/,
    "forms/[slug]/page.tsx must fire an audit row with action: \"form.access.denied\" on a denial",
  );
  // The audit metadata MUST carry the slug, the required audience, and
  // the user's role so the audit log surfaces a useful diagnostic
  // pattern over time.
  assert.match(
    src,
    /metadata:\s*\{[\s\S]{0,300}slug[\s\S]{0,200}requiredAudience[\s\S]{0,200}role/,
    "forms/[slug]/page.tsx audit metadata must include slug, requiredAudience, and role",
  );
  // The redirect must point at /forbidden (the existing forbidden page
  // is the agreed landing for cross-role access attempts).
  assert.match(
    src,
    /redirect\(\s*"\/forbidden"\s*\)/,
    "forms/[slug]/page.tsx must redirect to /forbidden on audience mismatch",
  );
});

test("spec 155 — forms runner audit fires BEFORE the redirect (redirect throws)", () => {
  const src = read(RUNNER_PATH);
  // `redirect()` in the Next.js App Router throws a RedirectError that
  // the framework catches. Anything written AFTER the redirect call is
  // unreachable. We pin the order: void recordAudit(...) must appear
  // BEFORE the `redirect("/forbidden")` call inside the same if-branch.
  // The regex allows arbitrary whitespace / comments between the two
  // statements but rejects any source where the redirect lands first.
  assert.match(
    src,
    /void\s+recordAudit\([\s\S]{0,800}redirect\(\s*"\/forbidden"\s*\)/,
    "forms/[slug]/page.tsx must call `void recordAudit(...)` BEFORE `redirect(\"/forbidden\")` — otherwise the redirect throws and the audit row never lands",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 155 — no TODO / FIXME markers leaked into shipped source", () => {
  for (const path of [PICKER_PATH, TOPBAR_PATH, RUNNER_PATH, SHELL_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 155 — no new dependencies were introduced", () => {
  // The fix uses native fetch + window.location.reload() in the
  // picker, and the existing RoleName / recordAudit helpers in the
  // forms runner. Nothing from the i18n / fetch / state-management
  // ecosystems should have crept into apps/web/package.json as a
  // side-effect.
  const pkg = read("apps/web/package.json");
  assert.ok(
    !/i18next/.test(pkg),
    "apps/web must not depend on i18next — the fix uses next-intl which was already in place",
  );
  assert.ok(
    !/swr|tanstack\/react-query/.test(pkg),
    "apps/web must not depend on swr or react-query — the picker uses raw fetch",
  );
});

test("spec 155 — touched files carry a Spec 155 inline reference so the fix is self-documenting", () => {
  // The inline comments make the connection between the file and the
  // spec explicit so a future contributor reading the picker, the
  // topbar or the runner knows to consult the spec before refactoring.
  // This is the LMS pattern across all the audit-closure specs.
  const pickerSrc = read(PICKER_PATH);
  assert.match(
    pickerSrc,
    /Spec 155/,
    "LanguagePicker.tsx must carry an inline `Spec 155` reference",
  );
  const topbarSrc = read(TOPBAR_PATH);
  assert.match(
    topbarSrc,
    /Spec 155/,
    "Topbar.tsx must carry an inline `Spec 155` reference for the LanguagePicker integration",
  );
  const runnerSrc = read(RUNNER_PATH);
  assert.match(
    runnerSrc,
    /Spec 155/,
    "forms/[slug]/page.tsx must carry an inline `Spec 155` reference for the audience gate",
  );
});
