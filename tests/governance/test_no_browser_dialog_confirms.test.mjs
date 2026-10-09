// No action may hinge on window.confirm().
//
// A browser that shows no dialogs -- the Claude desktop app's browser pane, and
// some phones' in-app browsers (WhatsApp, Teams) -- answers window.confirm()
// with "Cancel" at once. On the live site that made every Delete in the admin
// grid silently do nothing (QA, 9 Oct 2026). Confirmations are on the page
// instead (a "Yes, ..." and a "Cancel" button).
//
// One reviewed exception: SignOutButton asks only when unsaved local copies of
// forms exist, and treats a dialog it cannot show as "yes"; signing out never
// depends on it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SRC = join(root, "apps", "web", "src");
const ALLOWED = new Set(["apps/web/src/components/nav/SignOutButton.tsx"]);

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("no component outside the reviewed exception calls window.confirm()", () => {
  const offenders = files(SRC)
    .map((p) => relative(root, p).split("\\").join("/"))
    .filter((rel) => !ALLOWED.has(rel))
    .filter((rel) => /\bwindow\.confirm\s*\(/.test(stripComments(readFileSync(join(root, rel), "utf8"))));
  assert.deepEqual(offenders, [], "these ask through a browser dialog some browsers never show");
});
