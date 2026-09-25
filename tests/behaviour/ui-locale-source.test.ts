// One UI language per request, and it is the one the user saved.
//
// ── THE DEFECT (F124) ────────────────────────────────────────────────────────
//
// Every translated chrome string came from getTranslations(), which
// i18n/request.ts resolved from the gml-locale COOKIE. The authenticated
// layout's lang attribute, the Devanagari/Tibetan font and the topbar picker's
// "current" came from user_prefs.ui_language in the DATABASE. Nothing copied
// one into the other at sign-in, so the two disagreed whenever the device's
// cookie did not match the saved preference:
//   - a teacher who saved Hindi, signing in on a new or shared phone, got
//     English chrome declared lang="hi" in a Devanagari font, with the picker
//     showing हि -- and picking हिन्दी was a no-op (next === current);
//   - a login-page pick (cookie only) gave Hindi chrome declared lang="en",
//     with the picker on EN.
//
// Executed here: the app's REAL request config (the function next-intl calls
// for every getTranslations()), the real root layout and the real
// authenticated layout, for a signed-in user whose user_prefs row is in
// Postgres. They must all name the same locale.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render, request, withAppRouter, openingTags, elements, attr } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";
import { LOCALE_COOKIE, loadMessages } from "../../apps/web/src/i18n/config.ts";

const skip = needsDatabase();

type Locale = "en" | "hi" | "bo";

/** The locale next-intl would translate this request's strings into. */
async function stringsLocale(): Promise<string> {
  const { default: requestConfig } = await import("../../apps/web/src/i18n/request.ts");
  const config = await (requestConfig as unknown as (p: { locale?: string }) => Promise<{ locale: string }>)({
    locale: undefined,
  });
  return config.locale;
}

/** What the rendered pages declare: <html lang>, the shell wrapper, the picker. */
async function declared(): Promise<{ html: string | null; wrapper: string | null; picker: string | null }> {
  const { default: RootLayout } = await import("../../apps/web/src/app/layout.tsx");
  const root = await render(h(RootLayout, null, h("p", null, "x")));
  const { default: AuthenticatedLayout } = await import("../../apps/web/src/app/(authenticated)/layout.tsx");
  request.cookies["gml-device"] = "desktop";
  const shell = await render(withAppRouter(await AuthenticatedLayout({ children: h("p", null, "page") })));
  const wrapper = openingTags(shell, "div").find((t) => attr(t, "data-locale") !== null) ?? "";
  const picker = openingTags(shell, "details").find((t) => attr(t, "data-testid") === "topbar-language-picker") ?? "";
  return {
    html: attr(openingTags(root, "html")[0] ?? "", "lang"),
    wrapper: attr(wrapper, "lang"),
    picker: attr(picker, "data-current-locale"),
  };
}

async function withUser(
  saved: Locale | null,
  body: (id: string) => Promise<void>,
): Promise<void> {
  await withClient(async (c) => {
    const f = fixture(c, tag("locale-src"));
    try {
      const id = await f.user("teacher");
      // user_prefs cascades from users, so the fixture's cleanup removes it.
      if (saved) await c.query(`INSERT INTO user_prefs (user_id, ui_language) VALUES ($1, $2)`, [id, saved]);
      actAs(id, "teacher");
      await body(id);
    } finally {
      await f.cleanup();
    }
  });
}

test("F124: the saved language follows the user to a device with no locale cookie", { skip }, async () => {
  await withUser("hi", async () => {
    assert.equal(await stringsLocale(), "hi", "the chrome's strings must be Hindi: that is what she saved");
    const d = await declared();
    assert.deepEqual(d, { html: "hi", wrapper: "hi", picker: "hi" }, "the page must declare, and the picker show, the language the strings are in");
  });
});

test("F124: a stale device cookie (a previous user's choice) does not override the saved language", { skip }, async () => {
  await withUser("en", async () => {
    request.cookies[LOCALE_COOKIE] = "hi";
    assert.equal(await stringsLocale(), "en");
    assert.deepEqual(await declared(), { html: "en", wrapper: "en", picker: "en" });
  });
  await withUser("bo", async () => {
    request.cookies[LOCALE_COOKIE] = "hi";
    assert.equal(await stringsLocale(), "bo");
    assert.deepEqual(await declared(), { html: "bo", wrapper: "bo", picker: "bo" });
  });
});

test("F124: with nothing saved, the login-page choice (the cookie) is used everywhere, not only for the strings", { skip }, async () => {
  await withUser(null, async () => {
    request.cookies[LOCALE_COOKIE] = "hi";
    assert.equal(await stringsLocale(), "hi");
    assert.deepEqual(await declared(), { html: "hi", wrapper: "hi", picker: "hi" }, "lang, font and picker must agree with the Hindi chrome");
  });
});

/** The language pill /settings shows as selected. */
async function settingsPill(): Promise<string | undefined> {
  const { default: SettingsPage } = await import("../../apps/web/src/app/(authenticated)/settings/page.tsx");
  const html = await render(withAppRouter(await SettingsPage()));
  const checked = elements(html, "button").filter(
    (b) => attr(b.open, "role") === "radio" && attr(b.open, "aria-checked") === "true",
  );
  const pill = checked.find((b) => /English|हिन्दी|བོད་ཡིག/.test(b.text));
  return pill ? { English: "en", "हिन्दी": "hi", "བོད་ཡིག": "bo" }[pill.text.trim()] : undefined;
}

test("F124: the Settings language pill marks the language the chrome is actually in", { skip }, async () => {
  // Nothing saved, Hindi picked on the login page: the chrome is Hindi, so the
  // pill must not claim English (tapping English must then really switch).
  await withUser(null, async () => {
    request.cookies[LOCALE_COOKIE] = "hi";
    assert.equal(await settingsPill(), "hi");
  });
  await withUser("bo", async () => {
    request.cookies[LOCALE_COOKIE] = "en";
    assert.equal(await settingsPill(), "bo");
  });
});

test("F124: the section-gate page (outside the shell) resolves the same locale", { skip }, async () => {
  const { default: GatePage } = await import("../../apps/web/src/app/gate/[slug]/page.tsx");
  const gateTitle = async () => {
    const html = await render(
      withAppRouter(await GatePage({ params: Promise.resolve({ slug: "observation" }), searchParams: Promise.resolve({}) })),
    );
    // The card's small heading, <div class="label">{tGate("title")}</div>.
    return html.match(/<div class="label">([^<]*)<\/div>/)?.[1];
  };
  await withUser(null, async () => {
    request.cookies[LOCALE_COOKIE] = "hi";
    assert.equal(await gateTitle(), (loadMessages("hi").gate as Record<string, string>).title, "under <html lang=\"hi\">, the gate must not be English");
  });
  await withUser("bo", async () => {
    request.cookies[LOCALE_COOKIE] = "hi";
    assert.equal(await gateTitle(), (loadMessages("bo").gate as Record<string, string>).title);
  });
});

test("F124: signed out, the cookie still decides (the pre-auth login picker)", async () => {
  // No session, so no database read: runs without Postgres too.
  request.session = null;
  for (const locale of ["en", "hi", "bo"] as const) {
    request.cookies = { [LOCALE_COOKIE]: locale };
    assert.equal(await stringsLocale(), locale);
  }
  request.cookies = { [LOCALE_COOKIE]: "<script>" };
  assert.equal(await stringsLocale(), "en", "a forged cookie falls back to English");
});
