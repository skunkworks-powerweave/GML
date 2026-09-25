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
// COST. React's cache() memoises per server request, and the authenticated
// layout takes ftuxSeenAt from the same row, so this is the one user_prefs
// read a page render makes -- the layout already made it. auth() verifies the
// token locally (see auth.ts). Signed out, there is no database read at all.

import { cache } from "react";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { userPrefs, type UserPrefs } from "@gml/db/schema";
import { auth } from "@/auth";
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale, type Locale } from "./config";

export type ViewerPrefs = {
  /** The locale every string, lang attribute, font and picker must use. */
  locale: Locale;
  /** The signed-in viewer's saved row; null when signed out or never saved. */
  prefs: UserPrefs | null;
};

async function cookieLocale(): Promise<Locale> {
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
    // Loaded on use: the root layout and request config run for signed-out
    // pages too, and those must not need the database client, which refuses
    // to load without DATABASE_URL.
    const { db } = await import("@gml/db");
    // Not caught: this is the read the authenticated layout has always made,
    // and a database outage fails the page exactly as it did before.
    const [row] = await db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1);
    if (row) return { locale: normalizeLocale(row.uiLanguage), prefs: row };
  }
  return { locale: await cookieLocale(), prefs: null };
});

/** Shorthand for callers that only need the language. */
export async function resolveUiLocale(): Promise<Locale> {
  return (await viewerPrefs()).locale;
}
