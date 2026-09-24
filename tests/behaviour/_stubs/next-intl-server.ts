// Stands in for `next-intl/server` (see ../_ui.ts).
//
// The strings are the app's real ones: this reads the same bundles through the
// same loadMessages() the production request config uses, for whichever locale
// the test put in the fake request. A key that does not exist THROWS rather
// than echoing the key back, so a component that asks for a string nobody
// wrote fails its test instead of rendering "nav.primary" to a user.

import { loadMessages, normalizeLocale } from "../../../apps/web/src/i18n/config";

type State = { locale: string };
const state = () =>
  ((globalThis as Record<string, unknown>).__gmlTestRequest ?? { locale: "en" }) as State;

function lookup(bundle: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
    bundle,
  );
}

export async function getTranslations(
  arg?: string | { locale?: string; namespace?: string },
): Promise<(key: string) => string> {
  const namespace = typeof arg === "string" ? arg : arg?.namespace;
  const locale = normalizeLocale(typeof arg === "object" && arg?.locale ? arg.locale : state().locale);
  const messages = loadMessages(locale);
  const root = namespace ? lookup(messages, namespace) : messages;
  return (key: string) => {
    const value = lookup(root, key);
    if (typeof value !== "string") {
      throw new Error(`missing translation ${locale}:${namespace ? `${namespace}.` : ""}${key}`);
    }
    return value;
  };
}

export async function getLocale(): Promise<string> {
  return normalizeLocale(state().locale);
}
