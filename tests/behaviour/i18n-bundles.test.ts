// Every page's copy exists in all three languages, and is actually translated.
//
// ── THE DEFECT (UAT, 2026-09-27) ─────────────────────────────────────────────
//
// Only the chrome (menus, tabs, a few buttons) was ever translated. A user who
// picked Hindi or Bhoti got a translated menu over English pages, and a login
// screen whose heading was Hindi while its instructions, field label, brand
// panel and footer stayed English. Page copy now lives in one file per product
// area and locale (apps/web/src/i18n/locales/<locale>/<namespace>.json).
//
// What this file holds every namespace file to:
//   - the same keys in en, hi and bo -- a missing key silently shows English;
//   - no empty strings (an empty string also falls back to English);
//   - the same ICU arguments ({name}, {count, plural, ...}) in every language,
//     or a translated sentence drops a value or throws at render;
//   - every message compiles and formats in every language;
//   - a Hindi string is Devanagari and a Bhoti string is Tibetan wherever the
//     English has words to translate: a copied English string passes the key
//     check and is still English on screen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { SRC_DIR, webRequire } from "./_ui.js";
import { PAGE_NAMESPACES, loadMessages } from "../../apps/web/src/i18n/config.ts";

type Tree = { [k: string]: string | Tree };
const LOCALES = ["en", "hi", "bo"] as const;

const file = (locale: string, ns: string): Tree =>
  JSON.parse(readFileSync(join(SRC_DIR, "i18n", "locales", locale, `${ns}.json`), "utf8"));

function leaves(tree: Tree, prefix = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push([path, v]);
    else out.push(...leaves(v, path));
  }
  return out;
}

// The ICU parser next-intl itself uses, reached through its own dependencies
// (it is not a direct dependency of the app).
const intlRequire = createRequire(
  createRequire(createRequire(webRequire.resolve("next-intl")).resolve("use-intl")).resolve("intl-messageformat"),
);
const { parse } = intlRequire("@formatjs/icu-messageformat-parser") as {
  parse: (m: string, o?: { ignoreTag?: boolean }) => unknown[];
};

type El = { type: number; value?: string; options?: Record<string, { value: El[] }>; children?: El[] };
/** Argument names in an ICU message, with their kind (plain, plural, select, ...). */
function args(message: string): string[] {
  const out = new Set<string>();
  const walk = (els: El[]) => {
    for (const el of els) {
      // 0 literal, 7 pound: no argument. 8 is a rich-text tag: its name is part
      // of the contract with t.rich(), so it counts too.
      if (el.type !== 0 && el.type !== 7 && el.value) out.add(`${el.type}:${el.value}`);
      if (el.options) for (const o of Object.values(el.options)) walk(o.value);
      if (el.children) walk(el.children);
    }
  };
  walk(parse(message) as El[]);
  return [...out].sort();
}

/** Words that stay as they are in every language: names, acronyms, formats. */
const UNTRANSLATED = /\b(GML|Goldenmile|RTT|TKT|TTT|SCORM|WhatsApp|CSV|PDF|HLS|MP4|URL|ID|OK|Leh|Kargil|Drass|Ladakh|UTC|Q[1-4]|v\d[\w.]*)\b/g;
const hasWords = (s: string) =>
  /[A-Za-z]{2,}/.test(
    s
      .replace(/\{[^{}]*\}/g, " ") // arguments
      .replace(/<\/?[a-zA-Z]+>/g, " ") // rich-text tags
      .replace(/https?:\/\/\S+|\S+@\S+/g, " ")
      .replace(UNTRANSLATED, " "),
  );
const SCRIPT = { hi: /[ऀ-ॿ]/u, bo: /[ༀ-࿿]/u } as const;

for (const ns of PAGE_NAMESPACES) {
  test(`${ns}: the same keys, none empty, in en, hi and bo`, () => {
    const en = new Map(leaves(file("en", ns)));
    for (const locale of ["hi", "bo"] as const) {
      const other = new Map(leaves(file(locale, ns)));
      const missing = [...en.keys()].filter((k) => !other.has(k));
      const extra = [...other.keys()].filter((k) => !en.has(k));
      const empty = [...other].filter(([, v]) => v.trim() === "").map(([k]) => k);
      assert.deepEqual(missing, [], `${locale}/${ns}.json is missing keys en has (they would show English)`);
      assert.deepEqual(extra, [], `${locale}/${ns}.json has keys en does not (nothing reads them)`);
      assert.deepEqual(empty, [], `${locale}/${ns}.json has empty strings (they fall back to English)`);
    }
    assert.deepEqual([...en].filter(([, v]) => v.trim() === "").map(([k]) => k), [], `en/${ns}.json has empty strings`);
  });

  test(`${ns}: every message keeps the English arguments and compiles`, () => {
    const en = new Map(leaves(file("en", ns)));
    for (const locale of ["hi", "bo"] as const) {
      for (const [k, v] of leaves(file(locale, ns))) {
        const source = en.get(k);
        if (source === undefined) continue; // reported by the key test
        assert.deepEqual(args(v), args(source), `${locale}:${ns}.${k} must use the same arguments as English`);
      }
    }
  });

  test(`${ns}: Hindi is Devanagari and Bhoti is Tibetan, not copied English`, () => {
    const en = new Map(leaves(file("en", ns)));
    for (const locale of ["hi", "bo"] as const) {
      const untranslated = leaves(file(locale, ns))
        .filter(([k]) => hasWords(en.get(k) ?? ""))
        .filter(([, v]) => !SCRIPT[locale].test(v))
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
      assert.deepEqual(untranslated, [], `${locale}/${ns}.json has strings that are not in its script`);
    }
  });
}

test("the page namespaces do not shadow a chrome namespace", () => {
  const chrome = Object.keys(JSON.parse(readFileSync(join(SRC_DIR, "i18n", "locales", "en.json"), "utf8")));
  assert.deepEqual(PAGE_NAMESPACES.filter((ns) => chrome.includes(ns)), []);
});

test("every message formats in every language (the bundle the app really loads)", () => {
  const { createTranslator } = webRequire("next-intl") as {
    createTranslator: (o: { locale: string; messages: unknown; onError: (e: Error) => void }) => (k: string, v?: Record<string, unknown>) => string;
  };
  for (const locale of LOCALES) {
    const messages = loadMessages(locale);
    const failures: string[] = [];
    const t = createTranslator({ locale, messages, onError: (e) => failures.push(e.message) }) as unknown as {
      (k: string, v?: Record<string, unknown>): string;
      rich: (k: string, v?: Record<string, unknown>) => unknown;
    };
    for (const [ns, tree] of Object.entries(messages)) {
      for (const [k, v] of leaves(tree as Tree)) {
        // A value for every argument, of a type each kind accepts: a tag gets
        // a chunk renderer (and needs t.rich), a date or time a Date, a select
        // its "other" branch, the rest a number.
        const values: Record<string, unknown> = {};
        let rich = false;
        for (const a of args(v)) {
          const [kind, name] = a.split(":") as [string, string];
          if (kind === "8") rich = true;
          values[name] =
            kind === "8" ? (chunks: unknown) => chunks : kind === "3" || kind === "4" ? new Date(0) : kind === "5" ? "other" : 1;
        }
        if (rich) t.rich(`${ns}.${k}`, values);
        else t(`${ns}.${k}`, values);
      }
    }
    assert.deepEqual(failures, [], `${locale}: messages that do not format`);
  }
});
