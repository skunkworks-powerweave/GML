import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const VIEWER_PATH = "apps/web/src/components/pdf/PdfViewer.tsx";
const PAGE_PATH = "apps/web/src/app/(authenticated)/repo/resource/[id]/view/page.tsx";
const DETAIL_PATH = "apps/web/src/app/(authenticated)/repo/resource/[id]/page.tsx";
const SPEC_DIR = "specs/087-pdf-canvas-viewer";

test("spec 087: PdfViewer component exists at the agreed path", () => {
  assert.ok(existsSync(resolve(root, VIEWER_PATH)), `${VIEWER_PATH} must exist`);
});

test("spec 087: /view server-component page exists at the agreed path", () => {
  assert.ok(existsSync(resolve(root, PAGE_PATH)), `${PAGE_PATH} must exist`);
});

test("spec 087: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 087: PdfViewer is a client component (\"use client\" directive)", () => {
  const src = read(VIEWER_PATH);
  assert.match(src, /^["']use client["'];?/);
});

test("spec 087: PdfViewer renders an iframe with the toolbar-hiding URL fragment", () => {
  const src = read(VIEWER_PATH);
  assert.match(src, /<iframe/);
  // The fragment-hiding params are load-bearing for SM-4 deterrence.
  assert.match(src, /#toolbar=0/);
  assert.match(src, /navpanes=0/);
  assert.match(src, /scrollbar=0/);
});

test("spec 087: PdfViewer renders a watermark overlay with the required deterrence styles", () => {
  const src = read(VIEWER_PATH);
  // The overlay must be present and identifiable.
  assert.match(src, /pdf-watermark-overlay/);
  // SM-4 styling: mix-blend-mode + pointer-events: none + opacity around 0.15.
  assert.match(src, /mixBlendMode:\s*["']difference["']/);
  assert.match(src, /pointerEvents:\s*["']none["']/);
  assert.match(src, /opacity:\s*0\.15/);
  // Watermark prop must be threaded through the JSX, not hard-coded.
  assert.match(src, /\{watermark\}/);
});

test("spec 087: PdfViewer wrapper blocks the browser context menu", () => {
  const src = read(VIEWER_PATH);
  // Must call preventDefault on the context-menu handler (not just attach a noop).
  assert.match(src, /onContextMenu=\{[^}]*preventDefault\(\)[^}]*\}/);
});

test("spec 087: PdfViewer does NOT pull in pdfjs-dist (low-bandwidth constraint)", () => {
  const src = read(VIEWER_PATH);
  // Only flag actual `import ... from "pdfjs-dist"` or dynamic `import("pdfjs-dist")` —
  // a documentation comment that mentions the package name is intentional.
  assert.ok(
    !/\bimport\b[^;\n]*["']pdfjs-dist["']/.test(src),
    "must not import pdfjs-dist (~3 MB bundle hit)",
  );
  assert.ok(
    !/\brequire\(["']pdfjs-dist["']\)/.test(src),
    "must not require('pdfjs-dist') either",
  );
});

test("spec 087: view page is force-dynamic and gates on auth() with /login redirect", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /export const dynamic\s*=\s*["']force-dynamic["']/);
  assert.match(src, /from\s+["']@\/auth["']/);
  assert.match(src, /await\s+auth\(\)/);
  assert.match(src, /redirect\(["']\/login["']\)/);
});

test("spec 087: view page mints a 5-min signed URL via signMediaToken and routes through /api/media/", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /signMediaToken/);
  assert.match(src, /from\s+["']@\/lib\/video\/signed-url["']/);
  assert.match(src, /\/api\/media\//);
  // The bucket name is part of the contract — keeps PDFs separate from HLS.
  assert.match(src, /gml-resources/);
});

test("spec 087: view page renders the PdfViewer with src + watermark + resourceId props", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /from\s+["']@\/components\/pdf\/PdfViewer["']/);
  assert.match(src, /<PdfViewer\b/);
  assert.match(src, /src=\{signedUrl\}/);
  assert.match(src, /watermark=\{watermark\}/);
  // Watermark string must include OBS-CONFIDENTIAL tag (SM-4 contract).
  assert.match(src, /OBS-CONFIDENTIAL/);
});

test("spec 087: view page audits every view with action 'resource.pdf.view'", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /recordAudit/);
  assert.match(src, /from\s+["']@\/lib\/audit["']/);
  assert.match(src, /action:\s*["']resource\.pdf\.view["']/);
  assert.match(src, /entityType:\s*["']resource["']/);
  // piiAudited flag must be present in metadata per the spec.
  assert.match(src, /piiAudited:\s*false/);
});

test("spec 087: view page 404s when fileKey is null (no PDF to serve)", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /notFound\(\)/);
  assert.match(src, /res\.fileKey/);
});

test("spec 087: view page renders the SM-4 disclosure footer verbatim", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /PDF viewing is logged/);
  assert.match(src, /confidential/);
  assert.match(src, /do not redistribute/);
  assert.match(src, /deterrent,\s*not DRM/);
});

test("spec 087: resource detail page (spec 055) now labels the button 'View PDF', not 'Download PDF'", () => {
  const src = read(DETAIL_PATH);
  assert.match(src, />\s*View PDF\s*</);
  assert.ok(
    !/>\s*Download PDF\s*</.test(src),
    "detail page must not still say 'Download PDF' (viewer is in-browser only)",
  );
  // Href contract unchanged.
  assert.match(src, /\/repo\/resource\/\$\{res\.id\}\/view/);
});

test("spec 087: no new dependencies introduced (pdfjs-dist absent from package.json)", () => {
  const pkg = JSON.parse(read("apps/web/package.json"));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  assert.ok(!("pdfjs-dist" in deps), "pdfjs-dist must not appear in apps/web/package.json");
  assert.ok(!("react-pdf" in deps), "react-pdf must not appear either");
});

test("spec 087: plan.md follows the three-line CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
});

test("spec 087: no stub / TODO / placeholder markers in shipped source", () => {
  for (const path of [VIEWER_PATH, PAGE_PATH]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
    assert.ok(!/placeholder/i.test(src), `${path} must not contain 'placeholder' literals`);
  }
});
