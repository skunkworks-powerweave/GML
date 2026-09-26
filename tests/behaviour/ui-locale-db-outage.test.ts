// The page still renders, in the right language, when user_prefs cannot be read.
//
// ── THE DEFECT (F124, a regression of its first fix) ─────────────────────────
//
// F124 made one per-request resolver (i18n/resolve.ts) decide the UI language
// for everything, from the signed-in user's user_prefs row. Before it, only
// the (authenticated) layout read that row, so a failed read was caught by
// app/error.tsx -- inside the root layout, hydrated, with a working "Try
// again". Now the ROOT layout (<html lang>, the Display body classes) and the
// next-intl request config (every getTranslations()) await the resolver, and
// the read was not caught: a transient database error threw from the root
// layout itself. That skips app/error.tsx and lands on global-error.tsx, which
// says the deployment itself is broken, and whose static shell never hydrates
// under the CSP, so its "Try again" does nothing. It also took down signed-in
// pages that never needed the database: /login/reset, /forbidden, 404s.
//
// The resolver now fails soft: it logs the error and answers the cookie's
// locale with no prefs, flagged `failed` -- so the authenticated layout does
// not read the missing row as "has never seen the first-run tour" and replay
// it to everyone for the length of the outage.
//
// Executed here: the real root layout, request config, login layout and
// authenticated layout, signed in, with DATABASE_URL pointing at a port
// nothing listens on. This file sets DATABASE_URL for its own process (node
// --test runs each file in its own), so it needs no Postgres at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, render, request, resetRequest, withAppRouter, openingTags, attr } from "./_ui.js";
import { LOCALE_COOKIE } from "../../apps/web/src/i18n/config.ts";

// Before anything loads @gml/db, whose pool reads this once. Port 1 is
// reserved (tcpmux) and closed on a developer machine and a CI runner alike:
// the connection is refused, the same error a database restart produces.
process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:1/unreachable?sslmode=disable";

const USER_ID = "0c7ce1a2-12e4-4839-8f46-a57bfad08006";

function signedIn(cookie: string): void {
  resetRequest();
  request.session = { user: { id: USER_ID, email: "t@example.org", name: "Tsering Dolma", image: null, role: "teacher" } };
  request.cookies[LOCALE_COOKIE] = cookie;
}

/** Run `body` with console.error captured, and hand back what was logged. */
async function capturingErrors(body: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.error = original;
  }
  return logged;
}

test("F124: with the database unreachable, the root layout still renders, in the cookie's language", async () => {
  signedIn("hi");
  const { default: RootLayout } = await import("../../apps/web/src/app/layout.tsx");
  let html = "";
  const logged = await capturingErrors(async () => {
    html = await render(h(RootLayout, null, h("p", null, "x")));
  });
  assert.equal(attr(openingTags(html, "html")[0] ?? "", "lang"), "hi", "<html lang> falls back to the login-page choice");
  assert.equal(attr(openingTags(html, "body")[0] ?? "", "class"), "min-h-full flex flex-col", "no Display classes: nothing could be read");
  assert.ok(
    logged.some((line) => line.includes("user_prefs")),
    `the failure must be logged, not swallowed; logged: ${JSON.stringify(logged)}`,
  );
});

test("F124: with the database unreachable, the strings and the resolver answer the cookie's locale, flagged as a failure", async () => {
  signedIn("bo");
  const { default: requestConfig } = await import("../../apps/web/src/i18n/request.ts");
  const { viewerPrefs } = await import("../../apps/web/src/i18n/resolve.ts");
  await capturingErrors(async () => {
    const config = await (requestConfig as unknown as (p: { locale?: string }) => Promise<{ locale: string }>)({
      locale: undefined,
    });
    assert.equal(config.locale, "bo", "getTranslations() must not throw, and must use the cookie's locale");
    assert.deepEqual(await viewerPrefs(), { locale: "bo", prefs: null, failed: true });
  });
});

test("F124: with the database unreachable, the login segment (/login/reset) still renders", async () => {
  signedIn("hi");
  const { default: LoginLayout } = await import("../../apps/web/src/app/login/layout.tsx");
  let html = "";
  await capturingErrors(async () => {
    html = await render(await LoginLayout({ children: h("p", null, "x") }));
  });
  const wrapper = openingTags(html, "div").find((t) => attr(t, "data-locale") !== null) ?? "";
  assert.equal(attr(wrapper, "lang"), "hi");
});

test("F124: with the database unreachable, the shell renders and does not replay the first-run tour", async () => {
  // A row that could not be read is not a row that says "never seen": treating
  // it as one would put the tour over every page for every user until the
  // database came back.
  signedIn("hi");
  request.cookies["gml-device"] = "desktop";
  const { default: AuthenticatedLayout } = await import("../../apps/web/src/app/(authenticated)/layout.tsx");
  let html = "";
  await capturingErrors(async () => {
    html = await render(withAppRouter(await AuthenticatedLayout({ children: h("p", null, "page") })));
  });
  const wrapper = openingTags(html, "div").find((t) => attr(t, "data-locale") !== null) ?? "";
  assert.equal(attr(wrapper, "lang"), "hi", "the shell is in the cookie's language");
  assert.ok(html.includes("<p>page</p>"), "the page below the shell is rendered");
  assert.ok(!html.includes("ftux-root"), "the first-run tour must not mount on a failed read");
});
