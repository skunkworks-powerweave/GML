// What a rendered page's layout does at PHONE width, read from its markup.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// The phone shell renders the same page JSX as the desktop shell. That JSX set
// its columns as inline styles -- gridTemplateColumns "1fr 1fr", "1.6fr 1fr",
// "repeat(5, 1fr)" -- which apply at EVERY width (no stylesheet can override an
// inline style), put eight-column tables in boxes with nowhere to scroll, and
// laid filter chips and the cycle stepper out in rows that could not wrap. At
// 360 px the pages were 540-770 px wide, Chrome widened the layout viewport to
// match, and the fixed bottom tab bar -- the only navigation on a phone -- was
// placed off screen.
//
// There is no browser in this suite, so this module does not measure pixels.
// It resolves, for each element of the REAL rendered markup, the few
// properties that decide whether a layout can fit a phone, from the three
// places the app's CSS comes from, in the cascade's own order:
//
//   1. the element's inline style (beats everything below);
//   2. apps/web/src/app/globals.css's own rules -- UNLAYERED, so they beat
//      every Tailwind utility on the same property regardless of specificity;
//   3. Tailwind utilities, compiled by the app's own Tailwind (the same
//      compiler `next build` runs) for exactly the classes on the page, with
//      each rule's @media condition evaluated at the viewport width asked for.
//
// and then applies three rules of CSS layout that the defects broke:
//
//   - a GRID must not keep desktop columns side by side: at phone width it is
//     one column, an auto-fit/auto-fill of tracks that fit, or narrow fixed
//     columns (a label, an icon) beside flexible ones that cannot be pushed
//     wider than the phone by their content (see gridProblem);
//   - a TABLE needs a horizontal scroll container, and nothing between that
//     container and the page may grow to the table's width: a grid track whose
//     minimum is `auto` (an implicit track, or a bare `1fr`) and a flex item
//     with min-width:auto both take their content's min-content width, so the
//     page scrolls instead of the box;
//   - a ROW of three or more links, buttons or stepper steps must be allowed to
//     wrap.
//
// Only simple selectors (`.x`, `tag.x`) are read from globals.css: those are
// the ones that set display, wrapping, templates and overflow on the elements
// pages render. Anything else a rule could express is out of scope, and each
// rule above is exercised by the self-tests in ui-phone-layout.test.ts.

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_URL = new URL("../../apps/web/", import.meta.url);
const GLOBALS_CSS = fileURLToPath(new URL("src/app/globals.css", WEB_URL));

/** The narrowest phone the programme's teachers carry. */
export const PHONE_WIDTH = 360;
/**
 * The content box on that phone: MobileShell's <main> pads 16px each side and
 * .page-body / .page-header another 32px, so 360 - 2 * 48.
 */
export const PHONE_CONTENT = 264;
/** A label column beside a value, e.g. "Uploaded | 3 Sep 2026". */
const MAX_LABEL_TRACK = 140;

// ── markup → tree ────────────────────────────────────────────────────────────

export type El = { tag: string; attrs: Record<string, string>; children: El[]; parent: El | null };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** React's static markup as an element tree (text is not kept). */
export function parseMarkup(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[2]) {
      const tag = m[2].toLowerCase();
      // Close up to the matching open tag (React's markup is balanced).
      let n: El | null = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    if (!m[3]) continue; // comment, script or style
    const tag = m[3].toLowerCase();
    const attrs: Record<string, string> = {};
    for (const a of (m[4] ?? "").matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) attrs[a[1]!] = decode(a[2] ?? "");
    const el: El = { tag, attrs, children: [], parent: cur };
    cur.children.push(el);
    if (!m[5] && !VOID.has(tag)) cur = el;
  }
  return root;
}

export function* walk(el: El): Generator<El> {
  for (const c of el.children) {
    yield c;
    yield* walk(c);
  }
}

// ── the three style sources ─────────────────────────────────────────────────

type Decl = Record<string, string>;
type Block = { prelude: string; decls: Decl; children: Block[] };

/** A minimal CSS block parser: preludes, declarations and nested blocks. */
function parseBlocks(css: string): Block[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  // One block's body, up to its closing brace (or the end of the sheet).
  const body = (): { decls: Decl; children: Block[] } => {
    const decls: Decl = {};
    const children: Block[] = [];
    let buf = "";
    const declaration = () => {
      const t = buf.trim();
      const k = t.indexOf(":");
      // An at-rule statement (@import ...;) is not a declaration.
      if (k > 0 && !t.startsWith("@")) decls[t.slice(0, k).trim().toLowerCase()] = t.slice(k + 1).trim();
      buf = "";
    };
    while (i < src.length) {
      const ch = src[i++]!;
      if (ch === "{") {
        const prelude = buf.trim();
        buf = "";
        children.push({ prelude, ...body() });
      } else if (ch === "}") {
        declaration();
        return { decls, children };
      } else if (ch === ";") declaration();
      else buf += ch;
    }
    declaration();
    return { decls, children };
  };
  return body().children;
}

/** Does a media query hold at this viewport width? Unknown forms do not. */
function mediaMatches(prelude: string, width: number): boolean {
  const q = prelude.replace(/^@media\s*/, "").trim();
  if (/\bprint\b/.test(q)) return false;
  const px = (v: string, unit: string) => (unit === "rem" || unit === "em" ? Number(v) * 16 : Number(v));
  let ok = true;
  let matchedAny = false;
  for (const m of q.matchAll(/\(\s*width\s*(>=|<=|>|<)\s*([\d.]+)(px|rem|em)\s*\)/g)) {
    matchedAny = true;
    const v = px(m[2]!, m[3]!);
    ok &&= m[1] === ">=" ? width >= v : m[1] === "<=" ? width <= v : m[1] === ">" ? width > v : width < v;
  }
  for (const m of q.matchAll(/\(\s*(min|max)-width\s*:\s*([\d.]+)(px|rem|em)\s*\)/g)) {
    matchedAny = true;
    const v = px(m[2]!, m[3]!);
    ok &&= m[1] === "min" ? width >= v : width <= v;
  }
  return matchedAny && ok;
}

type SimpleRule = { cls: string; tag: string | null; decls: Decl };

/** globals.css's top-level `.x` / `tag.x` rules, in source order. */
async function globalsRules(): Promise<SimpleRule[]> {
  const out: SimpleRule[] = [];
  for (const b of parseBlocks(await readFile(GLOBALS_CSS, "utf8"))) {
    if (b.prelude.startsWith("@")) continue; // @theme, @media print, @keyframes
    for (const sel of b.prelude.split(",").map((s) => s.trim())) {
      const m = sel.match(/^([a-z]+)?\.([\w-]+)$/);
      if (m) out.push({ tag: m[1] ?? null, cls: m[2]!, decls: b.decls });
    }
  }
  return out;
}

const webRequire = createRequire(new URL("package.json", WEB_URL));

/** Tailwind's CSS for exactly these class names, from the app's Tailwind. */
async function tailwindCss(classes: string[]): Promise<string> {
  const tw = webRequire("tailwindcss") as {
    compile: (css: string, opts: unknown) => Promise<{ build: (candidates: string[]) => string }>;
  };
  const twDir = path.dirname(webRequire.resolve("tailwindcss/package.json"));
  const { build } = await tw.compile(`@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);`, {
    base: twDir,
    async loadStylesheet(id: string, base: string) {
      const file = id.startsWith("tailwindcss/") ? path.join(twDir, id.slice("tailwindcss/".length)) : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: await readFile(file, "utf8") };
    },
  });
  return build(classes);
}

function unescapeClass(sel: string): string | null {
  const m = sel.match(/^\.((?:\\.|[\w-])+)$/);
  return m ? m[1]!.replace(/\\(.)/g, "$1") : null;
}

/** Each Tailwind class's declarations that hold at `width`. */
function tailwindAt(css: string, width: number): Map<string, Decl> {
  const out = new Map<string, Decl>();
  const visit = (blocks: Block[], applies: boolean) => {
    for (const b of blocks) {
      if (b.prelude.startsWith("@layer")) {
        visit(b.children, applies);
        continue;
      }
      const cls = unescapeClass(b.prelude);
      if (!cls) continue; // :root, :hover variants, @property ...
      const decls: Decl = applies ? { ...b.decls } : {};
      for (const inner of b.children) {
        if (inner.prelude.startsWith("@media") && mediaMatches(inner.prelude, width)) Object.assign(decls, inner.decls);
      }
      out.set(cls, { ...(out.get(cls) ?? {}), ...decls });
    }
  };
  visit(parseBlocks(css), true);
  return out;
}

function inlineStyle(el: El): Decl {
  const out: Decl = {};
  for (const part of (el.attrs.style ?? "").split(";")) {
    const k = part.indexOf(":");
    if (k > 0) out[part.slice(0, k).trim().toLowerCase()] = part.slice(k + 1).trim();
  }
  return out;
}

function classesOf(el: El): string[] {
  return (el.attrs.class ?? "").split(/\s+/).filter(Boolean);
}

export type Resolver = (el: El, prop: string) => string | undefined;

/** Resolve properties for the elements of `root` at a viewport `width`. */
export async function resolverFor(root: El, width: number): Promise<Resolver> {
  const classes = new Set<string>();
  for (const el of walk(root)) for (const c of classesOf(el)) classes.add(c);
  const tw = tailwindAt(await tailwindCss([...classes]), width);
  const globals = await globalsRules();
  return (el, prop) => {
    const inline = inlineStyle(el)[prop];
    if (inline !== undefined) return inline;
    const cls = new Set(classesOf(el));
    let fromGlobals: string | undefined;
    for (const r of globals) {
      if (cls.has(r.cls) && (r.tag === null || r.tag === el.tag) && r.decls[prop] !== undefined) fromGlobals = r.decls[prop];
    }
    if (fromGlobals !== undefined) return fromGlobals;
    let fromTw: string | undefined;
    for (const c of cls) {
      const v = tw.get(c)?.[prop];
      if (v !== undefined) fromTw = v;
    }
    return fromTw;
  };
}

// ── the layout rules ────────────────────────────────────────────────────────

/** Split a track list at top level: "100px minmax(0, 1fr)" -> 2 tracks. */
function topLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of list.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (buf) out.push(buf);
      buf = "";
    } else buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

function args(fn: string): string[] {
  const inner = fn.slice(fn.indexOf("(") + 1, fn.lastIndexOf(")"));
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(buf.trim());
      buf = "";
    } else buf += ch;
  }
  out.push(buf.trim());
  return out;
}

type Track = { min: "auto" | number | "fits"; raw: string };

/** A track's minimum: a px number, "auto" (content-based) or "fits" (min(100%, ...)). */
function trackMin(t: string): Track["min"] {
  if (/^minmax\(/.test(t)) {
    const [lo] = args(t);
    return trackMin(lo!);
  }
  if (/^min\(/.test(t) && args(t).some((a) => a === "100%")) return "fits";
  if (/^0(px|rem)?$/.test(t) || /^calc\(var\(--spacing\)\s*\*\s*0\)$/.test(t)) return 0;
  const px = t.match(/^([\d.]+)px$/);
  if (px) return Number(px[1]);
  const rem = t.match(/^([\d.]+)rem$/);
  if (rem) return Number(rem[1]) * 16;
  return "auto"; // 1fr, auto, min-content, max-content, fit-content(...)
}

type Template = { kind: "implicit" } | { kind: "tracks"; tracks: Track[] } | { kind: "auto-repeat"; min: Track["min"] };

function template(value: string | undefined): Template {
  if (!value || value === "none") return { kind: "implicit" };
  const tracks: Track[] = [];
  for (const t of topLevel(value)) {
    if (/^repeat\(/.test(t)) {
      const [count, ...rest] = args(t);
      if (count === "auto-fit" || count === "auto-fill") return { kind: "auto-repeat", min: trackMin(rest.join(" ")) };
      for (let k = 0; k < Number(count); k++) for (const r of topLevel(rest.join(" "))) tracks.push({ min: trackMin(r), raw: r });
    } else tracks.push({ min: trackMin(t), raw: t });
  }
  return { kind: "tracks", tracks };
}

function isGrid(display: string | undefined): boolean {
  return display === "grid" || display === "inline-grid";
}
function isFlex(display: string | undefined): boolean {
  return display === "flex" || display === "inline-flex";
}

/** Hidden at this width: display:none (inline, a class, or `hidden`). */
function hiddenAt(el: El, get: Resolver): boolean {
  for (let n: El | null = el; n && n.tag !== "#root"; n = n.parent) {
    if (get(n, "display") === "none" || "hidden" in n.attrs) return true;
  }
  return false;
}

function describe(el: El): string {
  const cls = el.attrs.class ? ` class="${el.attrs.class}"` : "";
  const style = el.attrs.style ? ` style="${el.attrs.style}"` : "";
  return `<${el.tag}${cls}${style}>`;
}

/** Children as layout sees them: display:contents wrappers are transparent. */
function layoutChildren(el: El, get: Resolver): El[] {
  const out: El[] = [];
  for (const c of el.children) {
    if (get(c, "display") === "contents") out.push(...layoutChildren(c, get));
    else out.push(c);
  }
  return out;
}

function scrolls(el: El, get: Resolver): boolean {
  const v = get(el, "overflow-x") ?? get(el, "overflow");
  return v === "auto" || v === "scroll";
}

/** A scroll container (overflow hidden, auto or scroll): its automatic minimum width is zero. */
function clips(el: El, get: Resolver): boolean {
  const v = get(el, "overflow-x") ?? get(el, "overflow");
  return v === "hidden" || v === "auto" || v === "scroll";
}

function minWidthZero(el: El, get: Resolver): boolean {
  const v = get(el, "min-width");
  return v !== undefined && trackMin(v) === 0;
}

const FIXED = /^[\d.]+(px|rem)$/;

/**
 * Why a grid cannot fit a phone at its resolved template, or null.
 *
 * Fits: one column; an auto-fit/auto-fill whose tracks fit the column; or
 * fixed columns no wider than a label (<= 140px each) beside at most two
 * flexible ones -- where two flexible columns must both be allowed to shrink
 * (minmax(0, ...): an even split such as grid-cols-2), and a lone flexible
 * column with an `auto` minimum must hold only items that shrink themselves
 * (overflow clipped or scrolled, or min-width: 0), since otherwise its
 * content's min-content width -- a video id, a table -- sets the column.
 */
function gridProblem(grid: El, tpl: Template, get: Resolver): string | null {
  if (tpl.kind === "implicit") return null;
  if (tpl.kind === "auto-repeat") {
    return tpl.min === "fits" || (typeof tpl.min === "number" && tpl.min <= PHONE_CONTENT)
      ? null
      : `auto-repeats tracks of at least ${String(tpl.min)} into a ${PHONE_CONTENT}px column`;
  }
  const { tracks } = tpl;
  if (tracks.length === 1) return null;
  const shown = `(${tracks.map((t) => t.raw).join(" ")})`;
  const fixed = tracks.filter((t) => FIXED.test(t.raw));
  const flexible = tracks.filter((t) => !FIXED.test(t.raw));
  if (fixed.some((t) => (t.min as number) > MAX_LABEL_TRACK) || flexible.length > 2) {
    return `keeps ${tracks.length} columns side by side ${shown}`;
  }
  if (flexible.length === 2 && flexible.some((t) => t.min !== 0)) {
    return `keeps ${tracks.length} content-sized columns side by side ${shown}`;
  }
  const items = layoutChildren(grid, get).filter((c) => !hiddenAt(c, get));
  for (let k = 0; k < tracks.length; k++) {
    if (tracks[k]!.min !== "auto") continue;
    const stuck = items.filter((it, i) => i % tracks.length === k && !minWidthZero(it, get) && !clips(it, get));
    if (stuck.length > 0) return `column ${tracks[k]!.raw} of ${shown} grows to its content (use minmax(0, ...))`;
  }
  return null;
}

/**
 * Every reason the markup cannot lay out at `width` without the PAGE
 * scrolling sideways. An empty list is the pass condition.
 */
export async function phoneLayoutIssues(html: string, width = PHONE_WIDTH): Promise<string[]> {
  const root = parseMarkup(html);
  const get = await resolverFor(root, width);
  const issues: string[] = [];
  for (const el of walk(root)) {
    if (hiddenAt(el, get)) continue;
    const display = get(el, "display");

    if (isGrid(display)) {
      const why = gridProblem(el, template(get(el, "grid-template-columns")), get);
      if (why) issues.push(`grid ${why} at ${width}px: ${describe(el)}`);
    }

    if (isFlex(display) && get(el, "flex-wrap") !== "wrap" && !/column/.test(get(el, "flex-direction") ?? "")) {
      const items = layoutChildren(el, get).filter(
        (c) => c.tag === "a" || c.tag === "button" || classesOf(c).includes("step"),
      );
      if (items.length >= 3) issues.push(`row of ${items.length} links/buttons/steps cannot wrap: ${describe(el)}`);
    }

    if (el.tag === "table") {
      let box: El | null = el.parent;
      while (box && box.tag !== "#root" && !scrolls(box, get)) box = box.parent;
      if (!box || box.tag === "#root") {
        issues.push(`table has no horizontal scroll container, so the page scrolls: ${describe(el)}`);
        continue;
      }
      // The scroll box stops the TABLE, not its min-content width: that still
      // reaches every ancestor, and a grid track with an auto minimum or a
      // flex item with min-width:auto grows to it.
      for (let item: El = box; item.parent && item.parent.tag !== "#root"; item = item.parent) {
        const parent = item.parent;
        const pd = get(parent, "display");
        const itemShrinks = item === box || minWidthZero(item, get) || clips(item, get);
        if (isGrid(pd) && !itemShrinks) {
          const tpl = template(get(parent, "grid-template-columns"));
          const autoMin = tpl.kind === "implicit" || (tpl.kind === "tracks" && tpl.tracks.some((t) => t.min === "auto"));
          if (autoMin) issues.push(`grid track grows to a scrolled table's width (give it minmax(0, ...)): ${describe(parent)}`);
        }
        if (isFlex(pd) && !/column/.test(get(parent, "flex-direction") ?? "") && !itemShrinks) {
          issues.push(`flex item grows to a scrolled table's width (min-width: 0): ${describe(item)}`);
        }
      }
    }
  }
  return issues;
}

/** The grid-template-columns an element resolves to at `width`. */
export async function templateAt(html: string, width: number, pick: (el: El) => boolean): Promise<string[]> {
  const root = parseMarkup(html);
  const get = await resolverFor(root, width);
  return [...walk(root)].filter(pick).map((el) => get(el, "grid-template-columns") ?? "none");
}
