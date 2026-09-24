// Language and script, as a user receives them: the rendered markup of the
// login pickers, the document's declared language, and the bundles the chrome
// reads its strings from. See _ui.ts for how the components are rendered.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { h, render, renderSync, request, resetRequest, withAppRouter, withIntl, elements, openingTags, attr, SRC_DIR } from "./_ui.js";
import {
  LOCALE_COOKIE,
  LOCALE_HTML_LANG,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  loadMessages,
} from "../../apps/web/src/i18n/config.ts";

beforeEach(() => resetRequest());

const TIBETAN = /^[ༀ-࿿]$/u;
const ARABIC = /[؀-ۿݐ-ݿ]/u;

function assertTibetanOnly(text: string, where: string) {
  const glyphs = [...text.replace(/\s+/g, "")];
  assert.ok(glyphs.length > 0, `${where}: the Bhoti button has no visible label`);
  assert.ok(!ARABIC.test(text), `${where}: the Bhoti button shows Arabic-script characters (${[...text].map((c) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")).join(" ")})`);
  for (const g of glyphs) {
    assert.ok(TIBETAN.test(g), `${where}: "${g}" (U+${g.codePointAt(0)!.toString(16).toUpperCase()}) is not in the Tibetan block U+0F00-U+0FFF`);
  }
}

// ── Defect D1: the Bhoti/Ladakhi picker ──────────────────────────────────────

test("D1: the desktop login picker labels Bhoti in Tibetan script, never Arabic", async () => {
  const { LoginLanguagePicker } = await import("../../apps/web/src/app/login/language-picker.tsx");
  const en = loadMessages("en");
  const html = renderSync(
    withAppRouter(h(LoginLanguagePicker, { labels: { english: en.language.english as string, hindi: en.language.hindi as string, bhoti: en.language.bhoti as string } })),
  );
  const bo = elements(html, "button").find((b) => attr(b.open, "aria-label") === en.language.bhoti);
  assert.ok(bo, "the picker must render a button whose accessible name is the Bhoti self-name");
  assertTibetanOnly(bo.text, "desktop login picker");
  assert.equal(bo.text, LOCALE_LABELS.bo.script, "the chip must read the one shared constant, not a hand-copied glyph");
  assert.match(attr(bo.open, "class") ?? "", /\btib\b/, "the chip must opt into the Tibetan font stack (.tib), or it depends on whatever the client has installed");
  assert.equal(attr(bo.open, "lang"), "bo", "the chip must declare its own language so it is not voiced as English");
});

test("D1: the mobile login pill row labels Bhoti in Tibetan script, never Arabic", async () => {
  const { MobileLogin } = await import("../../apps/web/src/app/login/MobileLogin.tsx");
  const en = loadMessages("en");
  const html = renderSync(withAppRouter(await withIntl(h(MobileLogin, { from: undefined, emailEnabled: false }), "en")));
  const row = html.slice(html.indexOf('data-testid="mobile-language-row"'));
  assert.ok(row.length > 0, "the mobile language row must render");
  const bo = elements(row, "button").find((b) => attr(b.open, "aria-label") === en.language.bhoti);
  assert.ok(bo, "the mobile row must render a Bhoti button");
  assertTibetanOnly(bo.text, "mobile login pill");
  assert.equal(bo.text, LOCALE_LABELS.bo.script);
  assert.match(attr(bo.open, "class") ?? "", /\btib\b/);
  assert.equal(attr(bo.open, "lang"), "bo");
});

test("D1: the shared constant itself is Tibetan (the thing both pickers now read)", () => {
  assertTibetanOnly(LOCALE_LABELS.bo.script, "LOCALE_LABELS.bo.script");
  assertTibetanOnly(LOCALE_LABELS.bo.native, "LOCALE_LABELS.bo.native");
});

// ── Defect D2: <html lang> follows the locale ────────────────────────────────

test("D2: the root layout declares <html lang> from the locale cookie, for every locale", async () => {
  const { default: RootLayout } = await import("../../apps/web/src/app/layout.tsx");
  for (const locale of SUPPORTED_LOCALES) {
    resetRequest();
    request.cookies[LOCALE_COOKIE] = locale;
    const html = await render(h(RootLayout, null, h("p", null, "x")));
    const tag = openingTags(html, "html")[0];
    assert.ok(tag, "RootLayout must render <html>");
    assert.equal(attr(tag, "lang"), LOCALE_HTML_LANG[locale], `with ${LOCALE_COOKIE}=${locale} the document must be declared lang="${LOCALE_HTML_LANG[locale]}"`);
  }
});

test("D2: an absent or forged locale cookie falls back to English rather than breaking", async () => {
  const { default: RootLayout } = await import("../../apps/web/src/app/layout.tsx");
  for (const value of [undefined, "", "xx", "<script>"]) {
    resetRequest();
    if (value !== undefined) request.cookies[LOCALE_COOKIE] = value;
    const html = await render(h(RootLayout, null, "x"));
    assert.equal(attr(openingTags(html, "html")[0], "lang"), "en", `cookie ${JSON.stringify(value)} must yield lang="en"`);
  }
});

test("D2: the login segment re-declares lang on its wrapper for the picked locale", async () => {
  const { default: LoginLayout } = await import("../../apps/web/src/app/login/layout.tsx");
  for (const locale of SUPPORTED_LOCALES) {
    resetRequest();
    request.cookies[LOCALE_COOKIE] = locale;
    const html = await render(await LoginLayout({ children: h("p", null, "x") }));
    const wrapper = openingTags(html, "div").find((t) => attr(t, "data-locale") === locale);
    assert.ok(wrapper, `login layout must render its locale wrapper for ${locale}`);
    assert.equal(attr(wrapper, "lang"), LOCALE_HTML_LANG[locale]);
  }
});

test("D1/D2: the root layout loads a Tibetan and a Devanagari webfont onto <html>", async () => {
  // No Tibetan face was bundled anywhere, so a school machine without one
  // rendered the (now correct) Bhoti glyphs as empty boxes.
  const { default: RootLayout } = await import("../../apps/web/src/app/layout.tsx");
  const html = await render(h(RootLayout, null, "x"));
  const cls = attr(openingTags(html, "html")[0], "class") ?? "";
  assert.match(cls, /fontvar--font-tibetan/, "html must carry the --font-tibetan variable class");
  assert.match(cls, /fontvar--font-deva/, "html must carry the --font-deva variable class");
  const css = readFileSync(join(SRC_DIR, "app", "globals.css"), "utf8");
  assert.match(css, /--tib:\s*[^;]*var\(--font-tibetan/, "globals.css must define --tib on top of the loaded face");
  assert.match(css, /--deva:\s*[^;]*var\(--font-deva/, "globals.css must define --deva on top of the loaded face");
  assert.match(css, /\.tib\s*\{\s*font-family:\s*var\(--tib\)/, "globals.css must expose a .tib utility like .deva");
});

// ── Defects D8 + D9: the bundles ─────────────────────────────────────────────

type Tree = { [k: string]: string | Tree };
function leaves(tree: Tree, prefix = ""): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") out.push(...leaves(v as Tree, path));
    else out.push([path, v]);
  }
  return out;
}
const bundle = (locale: string): Tree =>
  JSON.parse(readFileSync(join(SRC_DIR, "i18n", "locales", `${locale}.json`), "utf8"));

test("D9: every English string exists, non-empty, in the Hindi and Bhoti bundles", () => {
  const en = leaves(bundle("en"));
  for (const locale of ["hi", "bo"]) {
    const other = new Map(leaves(bundle(locale)));
    const missing = en.filter(([k]) => !other.has(k)).map(([k]) => k);
    const empty = en.filter(([k]) => other.get(k) === "").map(([k]) => k);
    assert.deepEqual(missing, [], `${locale}.json is missing keys that en.json has (they fall back to English)`);
    assert.deepEqual(empty, [], `${locale}.json has empty placeholders (they fall back to English)`);
  }
});

test("D9: a Bhoti user sees the offline warning in Tibetan, not the English fallback", () => {
  const bo = loadMessages("bo");
  const en = loadMessages("en");
  for (const key of ["offline", "checking"]) {
    const v = (bo.status as Record<string, string>)[key];
    assert.notEqual(v, (en.status as Record<string, string>)[key], `bo status.${key} must not be the English fallback`);
    assert.match(v, /[ༀ-࿿]/u, `bo status.${key} must be in Tibetan script`);
  }
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(tsx?|mts)$/.test(name)) out.push(p);
  }
  return out;
}

test("D8: no translation namespace is dead — every one in en.json is read by some component", () => {
  // The login.forgot / login.reset / forbidden namespaces advertised full Hindi
  // coverage of three pages that never read a single one of those keys.
  const used = new Set<string>();
  for (const file of sourceFiles(SRC_DIR)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:getTranslations|useTranslations)\(\s*(?:\{[^}]*namespace:\s*)?["']([A-Za-z]+)/g)) {
      used.add(m[1]);
    }
  }
  const declared = Object.keys(bundle("en"));
  const dead = declared.filter((ns) => !used.has(ns));
  assert.deepEqual(dead, [], "these namespaces are declared (and translated) but nothing renders them");
});

test("D9: the network-status tooltip is translated, not hardcoded English", async () => {
  const { NetworkStatus } = await import("../../apps/web/src/components/nav/NetworkStatus.tsx");
  const hi = loadMessages("hi").status as Record<string, string>;
  const html = renderSync(
    h(NetworkStatus, {
      labelOnline: hi.online,
      labelOffline: hi.offline,
      labelChecking: hi.checking,
      hintOnline: hi.onlineHint,
      hintOffline: hi.offlineHint,
      hintChecking: hi.checkingHint,
    }),
  );
  const tag = openingTags(html, "div").find((t) => attr(t, "data-testid") === "network-status")!;
  // Server-rendered state is "checking".
  assert.equal(attr(tag, "title"), hi.checkingHint);
  assert.match(attr(tag, "title") ?? "", /[ऀ-ॿ]/u, "the Hindi tooltip must be Devanagari");
});
