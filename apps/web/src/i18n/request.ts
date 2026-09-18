// next-intl request configuration.
//
// WHY THIS FILE EXISTS: without it, every server-side `getTranslations()` call
// throws `Couldn't find next-intl config file`, which returned HTTP 500 on
// /login, /dashboard and every other translated route in the production image.
// `next build` did not catch it -- the failure only appears at request time.
// See docs/verification.md (B12).
//
// LOCALE RESOLUTION. The database is the source of truth
// (`user_prefs.uiLanguage`), but a Server Component cannot write cookies and we
// do not want a DB round-trip inside this config on every single render. So the
// `gml-locale` cookie is the fast read path and is kept in sync by the two
// places that can write it:
//   - apps/web/src/app/login/language-picker.tsx  (pre-auth picker)
//   - apps/web/src/app/api/user-prefs/route.ts    (post-auth, mirrors the DB write)
// If the cookie is absent or malformed, normalizeLocale() falls back to
// DEFAULT_LOCALE, so a missing cookie degrades to English rather than throwing.

import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, loadMessages, normalizeLocale } from "./config";

export default getRequestConfig(async ({ locale: requested }) => {
  // An explicit locale from `getTranslations({ locale })` wins -- gate/[slug]
  // resolves the user's locale itself and passes it in.
  if (requested) {
    const explicit = normalizeLocale(requested);
    return { locale: explicit, messages: loadMessages(explicit) };
  }

  let cookieValue: string | undefined;
  try {
    cookieValue = (await cookies()).get(LOCALE_COOKIE)?.value;
  } catch {
    // Reading cookies throws outside a request scope (e.g. during static
    // prerender). Fall through to the default rather than failing the render.
    cookieValue = undefined;
  }

  // normalizeLocale() already falls back to DEFAULT_LOCALE for null/unknown.
  const locale = normalizeLocale(cookieValue);
  return { locale, messages: loadMessages(locale) };
});
