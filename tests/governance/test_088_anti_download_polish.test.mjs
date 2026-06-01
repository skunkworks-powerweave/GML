import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const GUARD_PATH = "apps/web/src/components/AntiDownloadGuard.tsx";
const CSS_PATH = "apps/web/src/app/globals.css";
const LAYOUT_PATH = "apps/web/src/app/(authenticated)/layout.tsx";
const SPEC_DIR = "specs/088-anti-download-polish";

test("spec 088: AntiDownloadGuard.tsx exists at apps/web/src/components/AntiDownloadGuard.tsx", () => {
  assert.ok(existsSync(resolve(root, GUARD_PATH)), `${GUARD_PATH} must exist`);
});

test("spec 088: AntiDownloadGuard.tsx declares 'use client' on the first line", () => {
  const src = read(GUARD_PATH);
  // Must be the first non-blank statement, single OR double quoted.
  const firstLine = src.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  assert.match(firstLine, /^["']use client["']\s*;?\s*$/, "first non-blank line must be 'use client'");
});

test("spec 088: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 088: globals.css contains the @media print deterrence rule with the prohibition banner", () => {
  const src = read(CSS_PATH);
  assert.match(src, /@media\s+print\s*\{/);
  // The print rule must blank media (video / iframe / [data-pdf-viewer]) and the .no-print class.
  assert.match(src, /\bno-print\b[\s\S]{0,80}display:\s*none/);
  assert.match(src, /\bvideo\b[\s\S]{0,80}display:\s*none/);
  assert.match(src, /\biframe\b[\s\S]{0,80}display:\s*none/);
  assert.match(src, /\[data-pdf-viewer\][\s\S]{0,80}display:\s*none/);
  // Stamped banner copy must be present so an operator reviewing a printed
  // capture sees the policy even if every media element was hidden.
  assert.match(src, /Printing of confidential materials is prohibited\./);
});

test("spec 088: globals.css ships the CSS-layer deterrents (.no-select, .no-context, .media-frame::after hatch)", () => {
  const src = read(CSS_PATH);
  assert.match(src, /\.no-select\s*\{[^}]*user-select:\s*none/);
  assert.match(src, /\.no-context\s+\*\s*\{[^}]*-webkit-touch-callout:\s*none/);
  assert.match(src, /\.media-frame\s*\{[^}]*position:\s*relative/);
  assert.match(src, /\.media-frame::after\s*\{[\s\S]*repeating-linear-gradient/);
  // The hatch must be sub-2% opacity so it's invisible in normal viewing
  // but stays as a faint crop-resistant texture on a clean screenshot.
  assert.match(src, /rgba\(0,\s*0,\s*0,\s*0\.0?1[0-9]?\)/);
});

test("spec 088: (authenticated)/layout.tsx imports AntiDownloadGuard", () => {
  const src = read(LAYOUT_PATH);
  assert.match(
    src,
    /import\s+AntiDownloadGuard\s+from\s+["']@\/components\/AntiDownloadGuard["']/,
    "layout must import AntiDownloadGuard from @/components/AntiDownloadGuard",
  );
});

test("spec 088: (authenticated)/layout.tsx renders <AntiDownloadGuard /> in the tree", () => {
  const src = read(LAYOUT_PATH);
  assert.match(src, /<AntiDownloadGuard\s*\/>/);
});

test("spec 088: (authenticated)/layout.tsx still gates on auth() and preserves the device-shell switch", () => {
  // Sanity — the integration must not have eaten the existing auth gate or the
  // mobile/desktop shell branch (regression-class bug we want to fail loud on).
  const src = read(LAYOUT_PATH);
  assert.match(src, /const\s+session\s*=\s*await\s+auth\(\)/);
  assert.match(src, /redirect\(["']\/login["']\)/);
  assert.match(src, /MobileShell/);
  assert.match(src, /DesktopShell/);
});

test("spec 088: AntiDownloadGuard JSDoc contains the literal 'deterrence' (honest disclosure landed)", () => {
  const src = read(GUARD_PATH);
  // The component must explicitly own the deterrence-not-prevention posture in
  // a top-of-file comment block — guards against future "lockdown" rewrites
  // that quietly pretend to do DRM.
  const header = src.slice(0, 2000); // generous header window
  assert.match(header, /deterrence/i);
  // And the bypass paths must be enumerated so the disclosure is concrete.
  assert.match(header, /DevTools/);
  assert.match(header, /screen capture/i);
});

test("spec 088: AntiDownloadGuard wires the three keydown deterrents (save / print / printscreen)", () => {
  const src = read(GUARD_PATH);
  assert.match(src, /addEventListener\(\s*["']keydown["']/);
  // Modifier-key checks for save+print and a PrintScreen branch.
  assert.match(src, /ctrlKey/);
  assert.match(src, /metaKey/);
  assert.match(src, /PrintScreen/);
  // Each branch emits a dotted-notation audit action.
  assert.match(src, /anti_download\.attempt\.save/);
  assert.match(src, /anti_download\.attempt\.print/);
  assert.match(src, /anti_download\.attempt\.printscreen/);
  // And the listener must preventDefault (otherwise the browser's native
  // save/print dialog still pops — defeats the whole point of the spec).
  assert.match(src, /preventDefault\(\)/);
});

test("spec 088: AntiDownloadGuard surfaces the 'Screenshots are logged' toast via createPortal", () => {
  const src = read(GUARD_PATH);
  assert.match(src, /createPortal/);
  assert.match(src, /Screenshots are logged\./);
});

test("spec 088: AntiDownloadGuard runs the DevTools heuristic with sessionStorage throttle", () => {
  const src = read(GUARD_PATH);
  assert.match(src, /setInterval/);
  assert.match(src, /outerHeight\s*-\s*(?:window\.)?innerHeight/);
  assert.match(src, /anti_download\.devtools\.detected/);
  assert.match(src, /sessionStorage/);
  // Cleanup must clear the interval (no leaked timer on unmount / fast-refresh).
  assert.match(src, /clearInterval/);
});

test("spec 088: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});

test("spec 088: no stub / TODO / placeholder markers in the guard component", () => {
  const src = read(GUARD_PATH);
  assert.ok(!/\bTODO\b/i.test(src), "AntiDownloadGuard must not contain TODO markers");
  assert.ok(!/\bFIXME\b/i.test(src), "AntiDownloadGuard must not contain FIXME markers");
  assert.ok(!/placeholder/i.test(src), "AntiDownloadGuard must not contain 'placeholder' literals");
});
