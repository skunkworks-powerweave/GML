"use client";

// The help articles in the reader's language, loaded on first use and kept for
// the rest of the visit (per language: the picker can change it mid-visit).
// Null until they arrive. See ./entries.ts for why they are not sent up front.

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { helpEntries, type HelpEntryText } from "./entries";

const loaded = new Map<string, Record<string, HelpEntryText>>();
const pending = new Map<string, Promise<Record<string, HelpEntryText>>>();

/** Put a language's articles in the cache without fetching (tests do this). */
export function primeHelpEntries(locale: string, entries: Record<string, HelpEntryText>): void {
  loaded.set(locale, entries);
}

/** The articles, or null while they load. `wanted` false defers the fetch (a closed panel). */
export function useHelpEntries(wanted = true): Record<string, HelpEntryText> | null {
  const locale = useLocale();
  const [, rendered] = useState(0);
  useEffect(() => {
    if (!wanted || loaded.has(locale)) return;
    let live = true;
    let request = pending.get(locale);
    if (!request) {
      request = helpEntries(locale);
      pending.set(locale, request);
      request.then(
        (entries) => loaded.set(locale, entries),
        () => pending.delete(locale), // a failed fetch is retried next time
      );
    }
    request.then(
      () => live && rendered((n) => n + 1),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wanted, locale]);
  return loaded.get(locale) ?? null;
}
