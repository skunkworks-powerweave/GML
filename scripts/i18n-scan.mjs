#!/usr/bin/env node
// Find interface text that is written into the source instead of read from
// the translation bundles (apps/web/src/i18n/locales). Such text shows in
// English whatever language the user picked.
//
//   node scripts/i18n-scan.mjs                   scan apps/web/src/{app,components}
//   node scripts/i18n-scan.mjs <path> [<path>…]  scan those files or folders
//   node scripts/i18n-scan.mjs --json …          one JSON object per finding
//
// Exit status 1 when anything is found. Parsed with the TypeScript compiler, so
// comments and code are told apart properly. What counts as interface text:
//
//   jsx-text    text between tags:              <p>Saved.</p>
//   attribute   a visible attribute or text prop: placeholder="Search"
//               aria-label, title, alt, and any prop named like *label, *text,
//               *title, *hint, *message, *placeholder, *description, heading…
//   expression  a string inside a JSX expression: {pending ? "Saving…" : x}
//   property    a text-named property:           { label: "Teachers" }
//               (title, label, description, placeholder, heading, message,
//               hint, caption, text, body, cta, empty, subtitle, tagline)
//   sentence    any other string of two or more words, e.g. an error message
//               in a lookup table or a server action's return value.
//
// Not interface text: className/style/href/key/id and other plumbing
// attributes; comparisons (mode === "password"); console.* and thrown Error
// messages (developer-facing); import paths; type positions; SQL tags.
//
// Names and codes that stay as they are in every language (GML, RTT, SCORM,
// WhatsApp, CSV, Leh, …) are not flagged on their own. A line that must stay
// English on purpose carries an `i18n-ignore` comment on it or on the line
// above, with the reason.

import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WEB = join(ROOT, "apps", "web");
const ts = createRequire(join(WEB, "package.json"))("typescript");

const args = process.argv.slice(2);
const json = args.includes("--json");
const targets = args.filter((a) => a !== "--json");
const roots = targets.length ? targets.map((t) => resolve(t)) : [join(WEB, "src", "app"), join(WEB, "src", "components")];

// API routes answer machines (JSON codes), not people.
const SKIP_DIR = /[\\/](api|node_modules|\.next)([\\/]|$)/;

function files(p, out = []) {
  const s = statSync(p);
  if (s.isDirectory()) {
    if (SKIP_DIR.test(p + "/")) return out;
    for (const name of readdirSync(p)) files(join(p, name), out);
  } else if (/\.(tsx|ts)$/.test(p) && !/\.d\.ts$|\.test\.tsx?$/.test(p)) {
    out.push(p);
  }
  return out;
}

const UNTRANSLATED =
  /\b(GML|LMS|Goldenmile|RTT|TKT|TTT|SCORM|WhatsApp|CSV|PDF|HLS|MP4|JSON|URL|UTC|IST|ID|EN|OK|Leh|Kargil|Drass|Ladakh|Q[1-4]|v\d[\w.]*|e\.g|i\.e|etc)\b/g;
/** Letters left once names, codes, arguments and URLs are taken out. */
function words(s) {
  return /[A-Za-z]{2,}/.test(
    s
      .replace(/\$\{[^}]*\}/g, " ")
      .replace(/https?:\/\/\S+|\S+@\S+\.\S+/g, " ")
      .replace(UNTRANSLATED, " "),
  );
}
/** Code that happens to contain spaces: key=value pairs, CSS, paths, SVG settings. */
const codeLike = (s) =>
  /\b[\w-]+=|;\s*\w+=|var\(--|^\/|^[a-z]+:\/\/|^(xMid|xMin|xMax)|^[\w.-]+\.[\w.-]+$|\b\d+(px|rem|em|ms|s|%)\b|^use (client|server)$|^[a-z]{2}-[A-Z]{2}$/.test(s) ||
  // class lists: "chip chip-lichen", "btn btn-sm"
  (/^[a-z0-9-]+( [a-z0-9-]+)*$/.test(s.trim()) && /-/.test(s));
const sentence = (s) => /[A-Za-z]{2,}[^\n]*\s+[A-Za-z]{2,}/.test(s) && words(s) && !codeLike(s);
/** A single lower-case token: an identifier used as a value, not a word shown to anyone. */
const token = (s) => /^[a-z][a-z0-9]*([_.:-][a-z0-9]+)*$/.test(s);

const PLUMBING_ATTR = // aria-* that are states, not text: aria-sort, aria-expanded, aria-current…
  /^(className|style|href|src|srcSet|key|id|name|type|value|defaultValue|role|rel|target|method|action|encType|accept|autoComplete|inputMode|lang|dir|htmlFor|form|pattern|step|min|max|width|height|viewBox|d|fill|stroke|x|y|cx|cy|r|as|prefetch|scroll|sizes|media|crossOrigin|referrerPolicy|sandbox|allow|nonce|slot|tabIndex|draftScope|draftVersion|testId|icon|variant|kind|size|tone|color|mode|layout|align|justify|position|preload|poster|download)$|^(data|on)[-A-Z]|^aria-(?!label$|description$|valuetext$|placeholder$|roledescription$)/;
const TEXT_ATTR =
  /^(placeholder|title|alt|label|aria-label|aria-description|aria-valuetext|aria-placeholder|aria-roledescription|summary|heading|subheading|caption|tagline|subtitle|description|hint|message|cta|confirm|emptyText|emptyLabel|empty)$|(Label|Text|Title|Hint|Message|Placeholder|Description|Heading|Caption|Cta|Confirm|Tooltip)$/;
const TEXT_PROP = /^(title|label|description|placeholder|heading|subheading|message|hint|caption|text|body|cta|empty|subtitle|tagline|tooltip|summary|confirm)$/;

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join("${}");
  return null;
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const obj = ts.isIdentifier(e.expression) ? e.expression.text : "";
    return `${obj}.${e.name.text}`;
  }
  return "";
}

/** Why a string literal is not interface text, or null if it may be. */
function exempt(node) {
  // "use client" / "use server" and other directive prologues.
  if (ts.isExpressionStatement(node.parent)) return "directive";
  // A literal that IS an attribute's value is judged by the attribute rule.
  if (ts.isJsxAttribute(node.parent)) return "attribute";
  // Class lists, locale tags, key=value strings and the like, wherever they sit.
  if (codeLike(literalText(node) ?? "")) return "code";
  // An identifier-like value in a list, a cast, a binding or a return:
  // (["password", "magic"] as const), mode = "password", return "ok".
  const up = node.parent;
  if (
    token(literalText(node) ?? "") &&
    (ts.isArrayLiteralExpression(up) || ts.isAsExpression(up) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(up)) ||
      ts.isPropertyAssignment(up) || ts.isReturnStatement(up) || ts.isVariableDeclaration(up) || ts.isParameter(up) ||
      ts.isBindingElement(up) || ts.isCallExpression(up) || ts.isArrowFunction(up))
  )
    return "token";
  let child = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportTypeNode?.(p)) return "import";
    if (ts.isTypeNode(p) || ts.isLiteralTypeNode(p)) return "type";
    if (ts.isTaggedTemplateExpression(p)) return "tagged";
    if (ts.isCaseClause(p) && p.expression === child) return "case";
    if (ts.isElementAccessExpression(p) && p.argumentExpression === child) return "index";
    if (ts.isPropertyAssignment(p) && p.name === child) return "key";
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword].includes(op)) return "comparison";
    }
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
      const name = ts.isCallExpression(p) ? calleeName(p) : ts.isIdentifier(p.expression) ? p.expression.text : "";
      if (/^console\./.test(name)) return "console";
      if (/^(Error|TypeError|RangeError|URL|URLSearchParams|RegExp|Date|Intl\.\w+)$/.test(name)) return "ctor";
      if (/^(t|t\w*|useTranslations|getTranslations|redirect|notFound|permanentRedirect|revalidatePath|revalidateTag|require|import|cn|clsx|cx|encodeURIComponent|decodeURIComponent|fetch|headers\.get|cookies\.get|searchParams\.get|get|getAll|has|set|append|delete|startsWith|endsWith|includes|split|replace|replaceAll|match|test|indexOf|join|padStart|padEnd|toLocaleString|toLocaleDateString|toLocaleTimeString|localeCompare|querySelector|querySelectorAll|getItem|setItem|removeItem|addEventListener|removeEventListener|dispatchEvent|matchMedia|audit|logAudit|writeAudit|recordAudit|sql|eq|ne|like|ilike|assertEnv|requireRole|requireApiRole|assertSectionGate|withSpan|log|warn|error|info|debug|fail|json|jsonError|apiError|NextResponse\.json|Response\.json|\w+\.(get|set|has|delete|append|startsWith|endsWith|includes|split|replace|match|test|join|push|localeCompare|toLocaleString|toLocaleDateString|querySelector|getAttribute|setAttribute|closest))$/.test(name))
        return "call";
    }
    if (ts.isThrowStatement(p)) return "throw";
    if (ts.isJsxAttribute(p)) {
      const n = p.name.getText();
      return PLUMBING_ATTR.test(n) && !TEXT_ATTR.test(n) ? "attr" : null;
    }
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) return null;
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && /^(className|style|href|src|key|id|name|type|kind|variant|role|method|pattern|path|route|slug|table|column|field|icon|color|tone|mode|format|accept|mime|mimeType|contentType|code|action|event|status|audience|locale|lang|dir|target|rel|sort|order|align|cursor|display|position|fontFamily|fontSize|fontWeight|background|border|padding|margin|width|height|gap|grid\w*|flex\w*|transform|transition|animation|boxShadow|outline|overflow|textAlign|textDecoration|textTransform|whiteSpace|wordBreak|letterSpacing|lineHeight|opacity|zIndex|inset|top|left|right|bottom|content)$/.test(p.name.text))
      return "prop";
  }
  return null;
}

function inJsx(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxExpression(p)) return true;
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

function propName(node) {
  const p = node.parent;
  if (p && ts.isPropertyAssignment(p) && p.initializer === node && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
  return null;
}

function scan(file) {
  const src = readFileSync(file, "utf8");
  const lines = src.split(/\r?\n/);
  const ignored = (line) => /i18n-ignore/.test(lines[line] ?? "") || /i18n-ignore/.test(lines[line - 1] ?? "");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = [];
  const add = (node, kind, text) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    if (ignored(line)) return;
    found.push({ file: relative(ROOT, file).replace(/\\/g, "/"), line: line + 1, col: character + 1, kind, text: text.replace(/\s+/g, " ").trim().slice(0, 120) });
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, " ").trim();
      if (text && words(text)) add(node, "jsx-text", text);
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const n = node.name.getText();
      if (TEXT_ATTR.test(n) && !PLUMBING_ATTR.test(n) && words(node.initializer.text)) add(node, "attribute", `${n}="${node.initializer.text}"`);
    } else {
      const text = literalText(node);
      if (text !== null && words(text) && !exempt(node)) {
        const prop = propName(node);
        if (inJsx(node)) add(node, "expression", text);
        else if (prop && TEXT_PROP.test(prop)) add(node, "property", `${prop}: ${text}`);
        else if (sentence(text)) add(node, "sentence", text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const all = roots.flatMap((r) => files(r)).flatMap(scan);
if (json) for (const f of all) console.log(JSON.stringify(f));
else {
  for (const f of all) console.log(`${f.file}:${f.line}:${f.col}\t${f.kind}\t${f.text}`);
  console.log(`\n${all.length} untranslated string(s) in ${new Set(all.map((f) => f.file)).size} file(s)`);
}
process.exit(all.length ? 1 : 0);
