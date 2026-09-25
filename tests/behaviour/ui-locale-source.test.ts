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

import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { h, render, request, withAppRouter, openingTags, elements, attr } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";
import { closeAppPool } from "./_mentorship.js";
import { LOCALE_COOKIE, loadMessages } from "../../apps/web/src/i18n/config.ts";

const skip = needsDatabase();
// Only when Postgres is here: without DATABASE_URL the app's pool cannot even
// be constructed, and the signed-out test below still runs.
after(async () => {
  if (!skip) await closeAppPool();
});

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
  body: (id: string, c: Client) => Promise<void>,
): Promise<void> {
  await withClient(async (c) => {
    const f = fixture(c, tag("locale-src"));
    try {
      const id = await f.user("teacher");
      // user_prefs cascades from users, so the fixture's cleanup removes it.
      if (saved) await c.query(`INSERT INTO user_prefs (user_id, ui_language) VALUES ($1, $2)`, [id, saved]);
      actAs(id, "teacher");
      await body(id, c);
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

// ── The first saved preference ───────────────────────────────────────────────
//
// Signed in with no row, the cookie decides (above). But the row did not stay
// absent: PUT /api/user-prefs creates it on the first write of ANY field, and
// created it from its defaults, uiLanguage 'en' included. The first-run tour's
// Skip / Got it PUTs {ftuxSeenAt} on every first sign-in, and every Settings
// toggle PUTs its one field -- so a teacher who picked हिन्दी on the login page
// was switched to English by dismissing the tour, and a Settings toggle
// redrew the chrome in English under a form still showing हिन्दी (whose pill
// then computed an empty delta and sent nothing).

/** Call the real PUT /api/user-prefs handler as the signed-in test user. */
async function putPrefs(patch: Record<string, unknown>): Promise<number> {
  const { PUT } = await import("../../apps/web/src/app/api/user-prefs/route.ts");
  const res = await PUT(
    new Request("http://x/api/user-prefs", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
  // The handler voids its audit write; let it land before the fixture deletes
  // the user it names.
  await new Promise((r) => setTimeout(r, 300));
  return res.status;
}

async function savedLanguage(c: Client, id: string): Promise<string[]> {
  const { rows } = await c.query<{ ui_language: string }>(`SELECT ui_language FROM user_prefs WHERE user_id = $1`, [id]);
  return rows.map((r) => r.ui_language);
}

test("F124: the first saved preference keeps the language picked on the login page (the tour's PUT, a Settings toggle)", { skip }, async () => {
  const cases: Array<[Locale, Record<string, unknown>, string]> = [
    ["hi", { ftuxSeenAt: new Date().toISOString() }, "the first-run tour's Skip / Got it"],
    ["hi", { highContrast: true }, "a Settings toggle"],
    ["bo", { ftuxSeenAt: new Date().toISOString() }, "the first-run tour's Skip / Got it"],
  ];
  for (const [cookie, patch, what] of cases) {
    await withUser(null, async (id, c) => {
      request.cookies[LOCALE_COOKIE] = cookie;
      assert.equal(await stringsLocale(), cookie, "before: the login-page choice");
      assert.equal(await putPrefs(patch), 200);
      assert.deepEqual(await savedLanguage(c, id), [cookie], `${what} must save the language on screen, not the default 'en'`);
      assert.equal(await stringsLocale(), cookie, `after ${what} the chrome must still be ${cookie}`);
      assert.deepEqual(await declared(), { html: cookie, wrapper: cookie, picker: cookie });
      assert.equal(await settingsPill(), cookie, "and the Settings pill agrees, so tapping another language really switches");
    });
  }
});

test("F124: an explicit language in the first write wins, and a later write never touches a saved language", { skip }, async () => {
  // The first write names a language: that one, not the cookie's.
  await withUser(null, async (id, c) => {
    request.cookies[LOCALE_COOKIE] = "hi";
    assert.equal(await putPrefs({ uiLanguage: "bo" }), 200);
    assert.deepEqual(await savedLanguage(c, id), ["bo"]);
  });
  // A saved row is the user's choice: a stale device cookie (a previous user's
  // login-page pick on a shared phone) must not leak into it on an unrelated
  // write.
  await withUser("en", async (id, c) => {
    request.cookies[LOCALE_COOKIE] = "hi";
    assert.equal(await putPrefs({ highContrast: true }), 200);
    assert.deepEqual(await savedLanguage(c, id), ["en"]);
    assert.equal(await stringsLocale(), "en");
  });
  // No cookie, nothing saved: English, as before.
  await withUser(null, async (id, c) => {
    assert.equal(await putPrefs({ ftuxSeenAt: new Date().toISOString() }), 200);
    assert.deepEqual(await savedLanguage(c, id), ["en"]);
  });
});

test("F124: GET /api/user-prefs with nothing saved reports the language on screen", { skip }, async () => {
  // It answered the defaults, 'en' included, while the page around it was in
  // the login page's Hindi -- a different answer from every other reader.
  await withUser(null, async () => {
    request.cookies[LOCALE_COOKIE] = "hi";
    const { GET } = await import("../../apps/web/src/app/api/user-prefs/route.ts");
    const body = (await (await GET()).json()) as { uiLanguage: string };
    assert.equal(body.uiLanguage, "hi");
  });
});

test("F124: the login segment, signed in (/login/reset after a recovery link), uses the locale <html lang> declares", { skip }, async () => {
  // login/layout.tsx read the cookie on its own, so on a signed-in login route
  // <html lang> came from the saved row and the segment's wrapper, font and
  // strings from the cookie.
  const { default: LoginLayout } = await import("../../apps/web/src/app/login/layout.tsx");
  const { default: RootLayout } = await import("../../apps/web/src/app/layout.tsx");
  await withUser("bo", async () => {
    request.cookies[LOCALE_COOKIE] = "hi";
    const root = await render(h(RootLayout, null, h("p", null, "x")));
    const html = await render(await LoginLayout({ children: h("p", null, "x") }));
    const wrapper = openingTags(html, "div").find((t) => attr(t, "data-locale") !== null) ?? "";
    assert.equal(attr(openingTags(root, "html")[0] ?? "", "lang"), "bo");
    assert.deepEqual([attr(wrapper, "data-locale"), attr(wrapper, "lang")], ["bo", "bo"], "the login segment must not contradict <html lang>");
  });
});
