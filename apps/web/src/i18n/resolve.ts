// The viewer's UI language (and the rest of their user_prefs row), resolved
// ONCE per request, for everything that renders in it.
//
// WHY THIS EXISTS. The locale used to have two sources that disagreed:
// request.ts (every translated string) and the root layout (<html lang>) read
// the gml-locale cookie, while the authenticated layout (wrapper lang, script
// font, NextIntlClientProvider, the topbar picker's "current"), the settings
// page and the gate page read user_prefs.ui_language. The cookie was assumed
// to mirror the database, but only PUT /api/user-prefs wrote it; sign-in never
// did. So a teacher who saved Hindi got English strings on a new or shared
// phone under lang="hi" in a Devanagari font, with the picker saying हि -- and
// choosing हिन्दी there did nothing, because it already "was" Hindi.
//
// THE RULE. Signed in with a saved row: the row, whatever the device's cookie
// says (the cookie may be a previous user's login-page choice on a shared
// handset). Signed out, or nothing saved yet: the cookie, which is the
// pre-auth picker's choice. Either way every caller in the request gets the
// same answer.
//
// THE FIRST ROW. It is created by the first PUT /api/user-prefs of any field
// -- on every first sign-in, the first-run tour's {ftuxSeenAt} -- and that
// insert takes its language from the same cookie (cookieLocale below), so the
// row starts in the language the user was already seeing instead of flipping
// them to the 'en' default.
//
// COST. React's cache() memoises per server request, and the authenticated
// layout takes ftuxSeenAt from the same row, so this is the one user_prefs
// read a page render makes -- the layout already made it. auth() verifies the
// token locally (see auth.ts). Signed out, there is no database read at all.
//
// FAILURE IS SOFT. The root layout (<html lang>, the Display body classes) and
// the request config (every getTranslations()) await this, so a throw here
// escapes app/error.tsx, which renders INSIDE the root layout, and lands on
// global-error.tsx: "a fault in the deployment itself", on a static shell
// that does not hydrate under the CSP (see that file), so no retry works.
// For a transient database error, on pages that may not need the database at
// all (/login/reset, /forbidden, a 404). So a
// failed read is logged and answered with the cookie's locale and no prefs,
// flagged `failed`; a page that needs the database itself still fails in its
// own error boundary, inside a working shell.

import { cache } from "react";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { userPrefs, type UserPrefs } from "@gml/db/schema";
import { auth } from "@/auth";
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale, type Locale } from "./config";

export type ViewerPrefs = {
  /** The locale every string, lang attribute, font and picker must use. */
  locale: Locale;
  /** The signed-in viewer's saved row; null when signed out, never saved, or unreadable. */
  prefs: UserPrefs | null;
  /**
   * The row could not be read (the database was unreachable). `prefs` is then
   * null WITHOUT meaning "nothing saved": a caller that acts on a missing row
   * -- the first-run tour mounts on a null ftuxSeenAt -- must not act on this.
   */
  failed: boolean;
};

/** The pre-auth picker's choice on this device (the gml-locale cookie). */
export async function cookieLocale(): Promise<Locale> {
  try {
    return normalizeLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  } catch {
    // Outside a request scope (static prerender) there are no cookies.
    return DEFAULT_LOCALE;
  }
}

export const viewerPrefs = cache(async (): Promise<ViewerPrefs> => {
  const session = await auth();
  const userId = session?.user?.id;
  if (userId) {
    try {
      // Imported here rather than at the top for the behaviour tests alone.
      // In the app it changes nothing: @/auth, imported above, already loads
      // @gml/db statically (and with it the requirement for DATABASE_URL),
      // and the pool connects on the first query either way. The tests
      // replace @/auth with a stub, and a top-level import would make their
      // signed-out renders of the root and login layouts need a database
      // they never query.
      const { db } = await import("@gml/db");
      const [row] = await db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1);
      if (row) return { locale: normalizeLocale(row.uiLanguage), prefs: row, failed: false };
    } catch (err) {
      console.error("[i18n] reading user_prefs failed; rendering in the cookie's locale", err);
      return { locale: await cookieLocale(), prefs: null, failed: true };
    }
  }
  return { locale: await cookieLocale(), prefs: null, failed: false };
});

/** Shorthand for callers that only need the language. */
export async function resolveUiLocale(): Promise<Locale> {
  return (await viewerPrefs()).locale;
}
