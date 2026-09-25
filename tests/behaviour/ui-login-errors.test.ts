// Login error messages in the user's language, RENDERED.
//
// ── THE DEFECT (F90) ─────────────────────────────────────────────────────────
//
// The login page's labels were translated, but every error it could show was
// an English literal returned by the server action ("Incorrect email or
// password.", "Too many sign-in attempts...", ...). hi.json and bo.json had no
// key for any of them. A teacher who had picked Hindi or Bhoti and mistyped
// her password was told so in English -- the one moment the login screen most
// needs to be understood.
//
// The action now returns a CODE, and the shells render it through the real
// LoginError component with the app's real bundles.

import { test } from "node:test";
import assert from "node:assert/strict";
import { h, renderSync, withIntl, withAppRouter, elements, attr, openingTags, request, resetRequest } from "./_ui.js";
import { loadMessages } from "../../apps/web/src/i18n/config.ts";

const CODES = ["missing_fields", "invalid_credentials", "inactive", "email_not_confirmed", "rate_limited", "unavailable"] as const;
const SCRIPT = { hi: /[ऀ-ॿ]/u, bo: /[ༀ-࿿]/u } as const;

const loginError = () => import("../../apps/web/src/app/login/login-error.tsx");

test("every sign-in error code has a message in English, Hindi and Bhoti", () => {
  for (const locale of ["en", "hi", "bo"] as const) {
    const login = (loadMessages(locale) as Record<string, unknown>).login as { error?: Record<string, string> } | undefined;
    for (const code of CODES) {
      const msg = login?.error?.[code];
      assert.ok(typeof msg === "string" && msg.length > 0, `${locale}: login.error.${code} is missing`);
      if (locale !== "en") assert.match(msg!, SCRIPT[locale], `${locale}: login.error.${code} must be in its own script`);
    }
  }
});

test("the login error renders in the picked language, as an alert", async () => {
  const { LoginError } = await loginError();
  const en = loadMessages("en") as unknown as { login: { error: Record<string, string> } };
  for (const locale of ["hi", "bo"] as const) {
    for (const code of CODES) {
      const html = renderSync(await withIntl(h(LoginError, { code }), locale));
      const [p] = elements(html, "p");
      assert.ok(p, `${locale}/${code}: nothing rendered`);
      assert.equal(attr(openingTags(html, "p")[0]!, "role"), "alert");
      assert.match(p!.text, SCRIPT[locale], `${locale}/${code}: rendered "${p!.text}"`);
      assert.notEqual(p!.text, en.login.error[code], `${locale}/${code} fell back to English`);
    }
  }
});

// ── F84: /login ignored ?error= ──────────────────────────────────────────────
//
// /auth/callback and /auth/confirm send a failed email link to
// /login?error=link_expired or link_invalid. The page read only from/next, so
// the person landed on a bare sign-in form with no idea why their link had
// not worked.

test("/login explains a failed email link, in the picked language, on both shells", async () => {
  const { default: LoginPage } = await import("../../apps/web/src/app/login/page.tsx");
  const hi = loadMessages("hi") as unknown as { login: { error: Record<string, string> } };
  for (const device of ["desktop", "mobile"] as const) {
    for (const code of ["link_expired", "link_invalid"] as const) {
      request.cookies = { "gml-device": device };
      try {
        const el = await LoginPage({ searchParams: Promise.resolve({ error: code }) });
        const html = renderSync(withAppRouter(await withIntl(el, "hi")));
        const alerts = elements(html, "p").filter((p) => /role="alert"/.test(p.open));
        assert.equal(alerts.length, 1, `${device}/${code}: expected one alert`);
        assert.equal(alerts[0]!.text, hi.login.error[code]);
      } finally {
        resetRequest();
      }
    }
  }
  // Anything else in ?error= is not echoed.
  const el = await LoginPage({ searchParams: Promise.resolve({ error: "<script>" }) });
  const html = renderSync(withAppRouter(await withIntl(el, "en")));
  assert.equal(elements(html, "p").filter((p) => /role="alert"/.test(p.open)).length, 0);
});

test("no error, no alert", async () => {
  const { LoginError } = await loginError();
  assert.equal(renderSync(await withIntl(h(LoginError, { code: undefined }), "en")), "");
});
