import "server-only";

// notify(), with each inbox row written in its RECIPIENT's language.
//
// An inbox row is read by the person it is addressed to, not by whoever caused
// it, and its subject and body are stored as text. So they are rendered here,
// per recipient, from that user's saved interface language
// (user_prefs.ui_language; English when they never chose one) -- a mentor
// working in English who logs a meeting leaves the Bhoti-speaking mentee a
// Bhoti notification.

import { inArray } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { notify, type NotificationInput } from "@gml/db/notify";
import { userPrefs } from "@gml/db/schema";
import { DEFAULT_LOCALE, INTL_LOCALE, normalizeLocale, type Locale } from "@/i18n/config";
import type { Db } from "./visibility";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

export type LocalizedNotification = Omit<NotificationInput, "subject" | "body"> & {
  /**
   * The subject and body, from a translator for the recipient's language.
   * `intl` is the Intl locale tag for formatting a date in that language.
   */
  text: (t: Translate, intl: string) => { subject: string; body?: string | null };
};

/** Each user's saved interface language (English where none is saved). */
export async function recipientLocales(db: Db, userIds: string[]): Promise<Map<string, Locale>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ userId: userPrefs.userId, ui: userPrefs.uiLanguage })
    .from(userPrefs)
    .where(inArray(userPrefs.userId, ids));
  return new Map(rows.map((r) => [r.userId, normalizeLocale(r.ui)]));
}

/**
 * notify() with every row's text rendered in its recipient's language, from
 * the given message namespace. Never throws (as notify()): the action the
 * notification reports has already happened.
 */
export async function notifyLocalized(
  db: Db,
  namespace: string,
  rows: LocalizedNotification[],
  opts: { excludeUserId?: string | null } = {},
): Promise<number> {
  try {
    const locales = await recipientLocales(db, rows.map((r) => r.userId));
    const translators = new Map<Locale, Translate>();
    const out: NotificationInput[] = [];
    for (const { text, ...row } of rows) {
      const locale = locales.get(row.userId) ?? DEFAULT_LOCALE;
      let t = translators.get(locale);
      if (!t) {
        t = await getTranslations({ locale, namespace });
        translators.set(locale, t);
      }
      out.push({ ...row, ...text(t, INTL_LOCALE[locale]) });
    }
    return await notify(db, out, opts);
  } catch (err) {
    console.error("[notify] could not write localized notifications", { namespace, err });
    return 0;
  }
}
