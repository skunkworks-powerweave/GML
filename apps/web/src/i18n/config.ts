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
 * `user_prefs.uiLanguage` is the source of truth for a signed-in user; this
 * cookie is the pre-auth picker's choice, and what ./resolve.ts falls back to
 * when nobody is signed in or nothing has been saved yet. It is NOT a mirror
 * the server can rely on: nothing writes it at sign-in, which is why reading
 * it alone rendered the chrome in a different language from the layouts. It
 * was previously a bare "gml-locale" string literal repeated across four files.
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
 * Spec 169 — values may be either a flat `string` OR a nested object of
 * strings; `loadMessages` walks both shapes per-key. (The nested
 * `login.forgot.*` / `login.reset.*` / `forbidden.*` branches that
 * introduced this were deleted in the 2026-09 freeze: no page ever read them,
 * and their copy described a lockout and an SMTP flag that no longer exist.
 * The nested shape is still supported for whoever needs it next.)
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
 * An empty string counts as MISSING, so a placeholder a translator has not
 * filled yet falls back to English and the chrome remains readable. (bo.json
 * no longer ships any: tests/behaviour/ui-i18n.test.ts requires every en key
 * to be present and non-empty in hi and bo.) A `console.warn` is emitted for any empty
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
 * Map of locale → CSS font-family override. Hindi gets the Devanagari stack
 * (`--deva`), Bhoti the Tibetan stack (`--tib`), both backed by the faces
 * app/layout.tsx self-hosts; English keeps the default sans.
 *
 * Applied as an inline style on the locale WRAPPER <div> in
 * (authenticated)/layout.tsx and login/layout.tsx -- not on <html>, as this
 * comment used to claim. It is only inherited, so a component that sets its
 * own font-family (the mono labels, the serif headings) overrides it, and
 * script glyphs inside it fall back to whatever the system has. Put the
 * .deva / .tib class on script text that sits inside such a component.
 */
export const LOCALE_FONT_FAMILY: Record<Locale, string | undefined> = {
  en: undefined,
  hi: "var(--deva)",
  bo: "var(--tib)",
};

/** ISO language code used for the `<html lang>` attribute. */
export const LOCALE_HTML_LANG: Record<Locale, string> = {
  en: "en",
  hi: "hi",
  bo: "bo",
};
