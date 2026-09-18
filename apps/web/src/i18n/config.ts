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

/**
 * Name of the cookie carrying the UI locale.
 *
 * `user_prefs.uiLanguage` remains the source of truth; this cookie is the
 * read path for code that cannot hit the database -- notably the next-intl
 * request config, which runs on every server render. It was previously a bare
 * "gml-locale" string literal repeated across four files.
 */
export const LOCALE_COOKIE = "gml-locale";

/** Pretty labels for the language picker; rendered in their own scripts. */
export const LOCALE_LABELS: Record<Locale, { label: string; native: string; script: string }> = {
  en: { label: "English", native: "English", script: "EN" },
  hi: { label: "Hindi", native: "हिन्दी", script: "हिन्दी" },
  bo: { label: "Bhoti / Ladakhi", native: "བོད་ཡིག", script: "བོད་" },
};

/**
 * Source of truth for the messages bundles. Order matters: `en` is the
 * fallback locale.
 *
 * Spec 169 — values may now be either a flat `string` (the original
 * shape, kept for back-compat with most chrome namespaces) OR a nested
 * object of strings (used by the new `login.forgot.*` / `login.reset.*`
 * branches so the keys read naturally as `t("forgot.title")` etc.).
 * `loadMessages` walks both shapes per-key.
 */
type MessageValue = string | { [key: string]: MessageValue };
type MessageNamespace = Record<string, MessageValue>;
type MessageBundle = Record<string, MessageNamespace>;

const MESSAGES: Record<Locale, MessageBundle> = {
  en: enMessages as MessageBundle,
  hi: hiMessages as MessageBundle,
  bo: boMessages as MessageBundle,
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
 * deep fallback (per-key, per-namespace, per-nested-subkey). The fallback
 * keeps the UI usable when a translator has not yet filled in every Bhoti
 * string; missing keys render the English string instead of next-intl's
 * default `{key}` ICU placeholder, which would visually break the chrome.
 *
 * In development a `console.warn` is emitted per missing key so the gap is
 * visible during translation work.
 *
 * Spec 169 — the bo (Bhoti / Ladakhi) bundle currently ships with EMPTY-
 * STRING placeholders for the new `login.forgot.*` / `login.reset.*` /
 * `forbidden.*` keys (the strings are awaiting a Ladakhi translator). An
 * empty string here counts as MISSING so the English fallback wins and
 * the chrome remains readable. A `console.warn` is emitted for any empty
 * bo key when NODE_ENV !== 'production' so the gap is loud during
 * translation work. Production stays silent to keep the log channel
 * unspammed.
 */
function isLeafString(value: MessageValue | undefined): value is string {
  return typeof value === "string";
}

function mergeRecursive(
  targetGroup: MessageNamespace | MessageValue,
  fallbackGroup: MessageNamespace | MessageValue,
  locale: Locale,
  path: string,
): MessageValue {
  // Leaf: a non-empty string in the target wins; empty/missing → fallback.
  if (isLeafString(fallbackGroup)) {
    if (isLeafString(targetGroup) && targetGroup.length > 0) {
      return targetGroup;
    }
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[i18n] missing ${locale}:${path} — falling back to en`);
    }
    return fallbackGroup;
  }
  // Branch: recurse per-key.
  const out: Record<string, MessageValue> = {};
  const fallbackBranch = fallbackGroup as Record<string, MessageValue>;
  const targetBranch =
    typeof targetGroup === "object" && targetGroup !== null
      ? (targetGroup as Record<string, MessageValue>)
      : {};
  for (const key of Object.keys(fallbackBranch)) {
    out[key] = mergeRecursive(
      targetBranch[key],
      fallbackBranch[key],
      locale,
      path === "" ? key : `${path}.${key}`,
    );
  }
  return out;
}

export function loadMessages(locale: Locale): MessageBundle {
  if (locale === DEFAULT_LOCALE) {
    return MESSAGES[DEFAULT_LOCALE];
  }
  const target = MESSAGES[locale];
  const fallback = MESSAGES[DEFAULT_LOCALE];
  const merged: MessageBundle = {};
  for (const namespace of Object.keys(fallback)) {
    const merged_namespace = mergeRecursive(
      target[namespace],
      fallback[namespace],
      locale,
      namespace,
    );
    merged[namespace] =
      typeof merged_namespace === "object" && merged_namespace !== null
        ? (merged_namespace as MessageNamespace)
        : {};
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
