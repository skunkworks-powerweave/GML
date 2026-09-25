// next-intl request configuration.
//
// WHY THIS FILE EXISTS: without it, every server-side `getTranslations()` call
// throws `Couldn't find next-intl config file`, which returned HTTP 500 on
// /login, /dashboard and every other translated route in the production image.
// `next build` did not catch it -- the failure only appears at request time.
// See docs/verification.md (B12).
//
// LOCALE RESOLUTION is ./resolve.ts: the signed-in user's saved
// user_prefs.ui_language, else the gml-locale cookie (the pre-auth picker's
// choice), else DEFAULT_LOCALE. This used to read the cookie alone, on the
// assumption that it mirrored the database. It did not -- nothing wrote it at
// sign-in -- so the strings rendered in one language while the layouts, which
// read the database, declared another. One resolver, shared per request with
// those layouts, is what keeps them from disagreeing.

import { getRequestConfig } from "next-intl/server";
import { loadMessages, normalizeLocale } from "./config";
import { resolveUiLocale } from "./resolve";

export default getRequestConfig(async ({ locale: requested }) => {
  // An explicit locale from `getTranslations({ locale })` wins -- gate/[slug]
  // resolves the user's locale itself and passes it in.
  if (requested) {
    const explicit = normalizeLocale(requested);
    return { locale: explicit, messages: loadMessages(explicit) };
  }

  const locale = await resolveUiLocale();
  return { locale, messages: loadMessages(locale) };
});
