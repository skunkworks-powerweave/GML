// No internal tracking reference is shown to a user (W3-73).
//
// Substrate-moat ids (SM-1..SM-9) and spec numbers are how this codebase
// cross-references its own reasoning, and they belong in comments. Written
// into copy, they reached users as text that means nothing to them: the empty
// inbox said "Notifications are kept for 90 days (SM-8).", the super-admin's
// video quality picker offered "720p (deferred — spec 041)", the RTT hub told
// any viewer with no phases to "Run the spec 086 seed script", and the class
// roster card said "SM-9: opening this list writes an audit_log entry."
//
// A structural invariant over every component and every state, so it is
// checked here rather than by rendering each one. Each .tsx under
// apps/web/src is PARSED with the TypeScript compiler -- not regex-matched --
// so comments, including the {/* ... */} ones inside JSX, are not copy and are
// never flagged, while every JSX text run and every string handed to a JSX
// attribute or expression is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
// typescript is apps/web's dependency, not the repo root's.
const ts = createRequire(join(root, "apps/web/package.json"))("typescript");

const INTERNAL_REF = /\bSM-\d\b|\bspecs? \d{3}\b/i;

function* tsxFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsxFiles(p);
    else if (p.endsWith(".tsx")) yield p;
  }
}

/** Every piece of text a component renders or hands to an element: [line, text]. */
function copyIn(file, source = readFileSync(file, "utf8")) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const visit = (node) => {
    let text = null;
    if (ts.isJsxText(node)) text = node.text;
    else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.parent &&
      (ts.isJsxAttribute(node.parent) || ts.isJsxExpression(node.parent))
    ) {
      text = node.text;
    } else if (ts.isTemplateExpression(node) && node.parent && ts.isJsxExpression(node.parent)) {
      text = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join("…");
    }
    if (text !== null) out.push([sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text.replace(/\s+/g, " ").trim()]);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

test("the scan reads every kind of JSX copy and no comment (so a pass means something)", () => {
  const probe = [
    "// SM-1 in a line comment",
    "/* spec 010 in a block comment */",
    "export const A = ({ n }: { n: number }) => (",
    '  <p title="deferred per spec 041">',
    "    {/* SM-8 in a JSX comment */}",
    "    Kept for 90 days (SM-8).",
    '    {"run the spec 086 seed"}',
    "    {`${n} rows (SM-9)`}",
    "  </p>",
    ");",
  ].join("\n");
  const found = copyIn("probe.tsx", probe).map(([, t]) => t).filter((t) => INTERNAL_REF.test(t));
  assert.deepEqual(found, ["deferred per spec 041", "Kept for 90 days (SM-8).", "run the spec 086 seed", "… rows (SM-9)"]);
});

test("no user-facing copy names a substrate moat or a spec number", () => {
  const hits = [];
  for (const file of tsxFiles(join(root, "apps/web/src"))) {
    for (const [line, text] of copyIn(file)) {
      if (INTERNAL_REF.test(text)) hits.push(`${relative(root, file)}:${line}: ${text.slice(0, 140)}`);
    }
  }
  assert.deepEqual(hits, [], `internal references in rendered copy -- move them into a comment:\n${hits.join("\n")}`);
});
