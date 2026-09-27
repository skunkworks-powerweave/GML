// Helpers for governance tests that used to pin interface copy as a literal in
// a source file. Copy now lives in the translation bundles
// (apps/web/src/i18n/locales/en.json and locales/en/<namespace>.json), and a
// component reads it by key, so such a test asserts both halves: the source
// reads the key, and the English bundle holds the words.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const LOCALES = resolve(root, "apps/web/src/i18n/locales");

/** The whole bundle for a locale: the chrome file plus every page namespace file. */
export function bundle(locale = "en") {
  const out = JSON.parse(readFileSync(resolve(LOCALES, `${locale}.json`), "utf8"));
  for (const name of readdirSync(resolve(LOCALES, locale))) {
    if (name.endsWith(".json")) out[name.slice(0, -5)] = JSON.parse(readFileSync(resolve(LOCALES, locale, name), "utf8"));
  }
  return out;
}

/** The message at a dotted path ("login.forgot.title"), or undefined. */
export function message(path, locale = "en") {
  return path.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), bundle(locale));
}

/**
 * Does `src` read `key` through a translator -- t("key"), tLogin('key'),
 * t(`key`), t.rich("key", …) -- with or without arguments?
 */
export function readsKey(src, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bt\\w*(?:\\.(?:rich|markup|raw))?\\(\\s*["'\`]${k}["'\`]`).test(src);
}
