// Stands in for `next-intl/server` (see ../_ui.ts).
//
// The strings are the app's real ones: this reads the same bundles through the
// same loadMessages() the production request config uses, for whichever locale
// the test put in the fake request, and formats them with next-intl's own
// createTranslator -- so ICU arguments ({name}), plurals and t.rich() behave
// as in the app. A key that does not exist THROWS rather than echoing the key
// back, so a component that asks for a string nobody wrote fails its test
// instead of rendering "nav.primary" to a user.

import { createRequire } from "node:module";
import { loadMessages, normalizeLocale } from "../../../apps/web/src/i18n/config";

const webRequire = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { createTranslator, createFormatter } = webRequire("next-intl") as {
  createTranslator: (o: Record<string, unknown>) => unknown;
  createFormatter: (o: Record<string, unknown>) => unknown;
};

type State = { locale: string };
const state = () =>
  ((globalThis as Record<string, unknown>).__gmlTestRequest ?? { locale: "en" }) as State;

const TIME_ZONE = "Asia/Kolkata";

/** Missing or malformed messages fail the test instead of rendering a key. */
function fail(error: Error): never {
  throw error;
}

export async function getTranslations(arg?: string | { locale?: string; namespace?: string }): Promise<unknown> {
  const namespace = typeof arg === "string" ? arg : arg?.namespace;
  const locale = normalizeLocale(typeof arg === "object" && arg?.locale ? arg.locale : state().locale);
  return createTranslator({ locale, messages: loadMessages(locale), namespace, timeZone: TIME_ZONE, onError: fail });
}

export async function getMessages(arg?: { locale?: string }): Promise<unknown> {
  return loadMessages(normalizeLocale(arg?.locale ?? state().locale));
}

export async function getFormatter(arg?: { locale?: string }): Promise<unknown> {
  return createFormatter({ locale: normalizeLocale(arg?.locale ?? state().locale), timeZone: TIME_ZONE, onError: fail });
}

export async function getLocale(): Promise<string> {
  return normalizeLocale(state().locale);
}

export async function getTimeZone(): Promise<string> {
  return TIME_ZONE;
}

/**
 * next-intl's own getRequestConfig is the identity function: it only brands
 * the callback src/i18n/request.ts exports. The same here, so a test can call
 * the app's REAL request config and read the locale it resolves.
 */
export function getRequestConfig<T>(createRequestConfig: T): T {
  return createRequestConfig;
}
