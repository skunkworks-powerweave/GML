"use server";

// The help articles, fetched by the help panel when it first opens.
//
// They are most of the help namespace -- every article, in Devanagari or
// Tibetan at three bytes a character -- and most visits never open the panel,
// so they are not part of the strings every page hands the browser
// (clientMessages in i18n/config). useHelpEntries asks for them once per
// language and keeps them.

import { loadMessages, normalizeLocale } from "@/i18n/config";

export type HelpEntryText = { title: string; short: string; long?: string };

/** Every help article in `locale` (English wherever one is not translated). */
export async function helpEntries(locale: string): Promise<Record<string, HelpEntryText>> {
  const help = loadMessages(normalizeLocale(locale)).help as { entries?: Record<string, HelpEntryText> };
  return help.entries ?? {};
}
