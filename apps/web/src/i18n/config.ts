// next-intl runtime config — spec 125. The three supported UI locales are
// English (`en`, default), Hindi (`hi`, Devanagari rendered via the
// `--deva` CSS font variable), and Tibetan/Bhoti (`bo`, rendered in the
// Tibetan script and used for Ladakhi/Bhoti speakers in Leh and Kargil).
//
// Translation coverage is intentionally narrow: per the JSX prototype, only
// global chrome (topbar, sidebar, bottom tabs, login affordances, section
// gate) is translated. Page bodies stay English unless and until a future
// spec explicitly translates them. See `apps/web/src/app/(authenticated)/layout.tsx`
// for the runtime wiring.
//
// SM-7 reminder: locale state is per-user (read from `user_prefs.uiLanguage`)
// and never sniffed from the Accept-Language header — the picker is the
// single source of truth, by product decision.
//
// `bo` falls back to `en` when a key is missing — see `loadMessages` below.
// In development the fallback emits a console warning so missing keys
// surface during translation work; in production it stays silent.

import enMessages from "./locales/en.json";
import hiMessages from "./locales/hi.json";
import boMessages from "./locales/bo.json";

export const SUPPORTED_LOCALES = ["en", "hi", "bo"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Pretty labels for the language picker; rendered in their own scripts. */
export const LOCALE_LABELS: Record<Locale, { label: string; native: string; script: string }> = {
  en: { label: "English", native: "English", script: "EN" },
  hi: { label: "Hindi", native: "हिन्दी", script: "हिन्दी" },
  bo: { label: "Bhoti / Ladakhi", native: "བོད་ཡིག", script: "བོད་" },
};

/** Source of truth for the messages bundles. Order matters: `en` is the fallback. */
const MESSAGES: Record<Locale, Record<string, Record<string, string>>> = {
  en: enMessages,
  hi: hiMessages,
  bo: boMessages,
};

/**
 * Type guard that narrows an unknown string to a supported locale, falling
 * back to the default when the input is missing or unknown. Used everywhere
 * we read `user_prefs.uiLanguage` — the column is varchar(8) with a CHECK
 * constraint, but TypeScript can't see the constraint so we re-narrow here.
 */
export function normalizeLocale(value: string | null | undefined): Locale {
  if (!value) return DEFAULT_LOCALE;
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
    ? (value as Locale)
    : DEFAULT_LOCALE;
}

/**
 * Build the messages bundle for a given locale, merging with English as a
 * deep fallback (per-key, per-namespace). The fallback keeps the UI usable
 * when a translator has not yet filled in every Bhoti string; missing keys
 * render the English string instead of next-intl's default `{key}` ICU
 * placeholder, which would visually break the chrome.
 *
 * In development a `console.warn` is emitted per missing key so the gap is
 * visible during translation work; production stays quiet.
 */
export function loadMessages(locale: Locale): Record<string, Record<string, string>> {
  if (locale === DEFAULT_LOCALE) {
    return MESSAGES[DEFAULT_LOCALE];
  }
  const target = MESSAGES[locale];
  const fallback = MESSAGES[DEFAULT_LOCALE];
  const merged: Record<string, Record<string, string>> = {};
  for (const namespace of Object.keys(fallback)) {
    const targetGroup = target[namespace] ?? {};
    const fallbackGroup = fallback[namespace];
    const out: Record<string, string> = {};
    for (const key of Object.keys(fallbackGroup)) {
      if (targetGroup[key]) {
        out[key] = targetGroup[key];
      } else {
        if (process.env.NODE_ENV === "development") {
          // eslint-disable-next-line no-console
          console.warn(`[i18n] missing ${locale}:${namespace}.${key} — falling back to en`);
        }
        out[key] = fallbackGroup[key];
      }
    }
    merged[namespace] = out;
  }
  return merged;
}

/**
 * Map of locale → CSS font-family override. Hindi gets the Devanagari font
 * stack (`--deva`); English and Tibetan stay on the default sans / Tibetan
 * system fonts. Applied as an inline style on the `<html>` element by the
 * authenticated layout so the rule wins over per-component overrides.
 */
export const LOCALE_FONT_FAMILY: Record<Locale, string | undefined> = {
  en: undefined,
  hi: "var(--deva)",
  bo: undefined,
};

/** ISO language code used for the `<html lang>` attribute. */
export const LOCALE_HTML_LANG: Record<Locale, string> = {
  en: "en",
  hi: "hi",
  bo: "bo",
};
