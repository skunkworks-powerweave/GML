// Governance test for spec 157 — admin grid sort + bulk delete.
//
// Workflow Run 15 MISS closure. Two features ported from the JSX prototype
// that the v1 grid (spec 012) shipped without:
//
//   (1) Sortable columns. URL-driven `?sort=<col>&dir=<asc|desc>`. Whitelist
//       sort against `entity.displayColumns[].key`. Default sort
//       `createdAt DESC` when the table has it. Header arrows + aria-sort.
//
//   (2) Bulk select + delete. Leftmost checkbox column + sticky toolbar
//       above the table. New `bulkDeleteAction` runs DELETE in
//       `db.transaction(...)` and audits `admin.row.bulk_delete` after
//       commit.
//
// Asserts (10+):
//   - All three target files exist (page.tsx, actions.ts, bulk-toolbar.tsx).
//   - page.tsx imports `asc` and `desc` from drizzle-orm.
//   - page.tsx imports the four bulk-* names from `./bulk-toolbar`.
//   - page.tsx parses `sp.sort` and `sp.dir`.
//   - page.tsx whitelists sort against `displayColumns[].key`.
//   - page.tsx falls back to `createdAt` and `desc` as the default sort.
//   - page.tsx calls `.orderBy(` on the SELECT chain with `desc(...)` /
//     `asc(...)` based on `sortDir`.
//   - page.tsx defines `buildSortHref(`.
//   - page.tsx renders sort-link headers with `data-sort-header`.
//   - page.tsx renders `aria-sort` on the column headers.
//   - page.tsx bumps the empty-state `colSpan` to `length + 2`.
//   - page.tsx wraps the table region in `<BulkSelectionProvider`.
//   - page.tsx mounts `<BulkDeleteToolbar entitySlug={slug}`.
//   - actions.ts imports `inArray` and `recordAudit`.
//   - actions.ts exports `bulkDeleteAction`.
//   - actions.ts gates with `requireRole(mutateRolesFor(entity))`.
//   - actions.ts uses `db.transaction(async (tx) => ` for the DELETE.
//   - actions.ts audits `admin.row.bulk_delete` AFTER the transaction.
//   - actions.ts metadata carries `count` and `ids`.
//   - bulk-toolbar.tsx is `"use client"`.
//   - bulk-toolbar.tsx exports `BulkSelectionProvider`, `BulkRowCheckbox`,
//     `BulkSelectAllCheckbox`, `BulkDeleteToolbar`.
//   - BulkDeleteToolbar gates submit with `window.confirm`.
//   - BulkDeleteToolbar posts to `bulkDeleteAction`.
//   - All five spec-kit files exist under
//     `specs/157-admin-grid-sort-and-bulk-delete/`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const PAGE_PATH =
  "apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx";
const ACTIONS_PATH =
  "apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts";
const TOOLBAR_PATH =
  "apps/web/src/app/(authenticated)/admin/data/[entity]/bulk-toolbar.tsx";
const SPEC_DIR = "specs/157-admin-grid-sort-and-bulk-delete";

// Strip block + line comments so commented-out shapes don't pass code-level
// assertions, and so the rationale-in-comments style spec 152 also uses
// can't mask actual code regressions.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/([^:])\/\/.*$/gm, "$1");
}

test("spec 157 — all three target files exist", () => {
  assert.ok(existsSync(resolve(root, PAGE_PATH)), `${PAGE_PATH} must exist`);
  assert.ok(existsSync(resolve(root, ACTIONS_PATH)), `${ACTIONS_PATH} must exist`);
  assert.ok(existsSync(resolve(root, TOOLBAR_PATH)), `${TOOLBAR_PATH} must exist`);
});

test("spec 157 — page.tsx imports asc and desc from drizzle-orm", () => {
  const src = read(PAGE_PATH);
  // The sort chain uses both asc and desc; both must be imported.
  assert.match(
    src,
    /import\s*\{[^}]*\basc\b[^}]*\}\s*from\s*"drizzle-orm"/,
    "page.tsx must import `asc` from drizzle-orm",
  );
  assert.match(
    src,
    /import\s*\{[^}]*\bdesc\b[^}]*\}\s*from\s*"drizzle-orm"/,
    "page.tsx must import `desc` from drizzle-orm",
  );
});

test("spec 157 — page.tsx imports the bulk-toolbar components", () => {
  const src = read(PAGE_PATH);
  for (const name of [
    "BulkDeleteToolbar",
    "BulkRowCheckbox",
    "BulkSelectAllCheckbox",
    "BulkSelectionProvider",
  ]) {
    assert.match(
      src,
      new RegExp(`${name}`),
      `page.tsx must import or reference ${name} from ./bulk-toolbar`,
    );
  }
  assert.match(
    src,
    /from\s*"\.\/bulk-toolbar"/,
    "page.tsx must import from ./bulk-toolbar",
  );
});

test("spec 157 — page.tsx parses sp.sort and sp.dir", () => {
  const src = read(PAGE_PATH);
  assert.match(src, /sp\.sort/, "page.tsx must read sp.sort");
  assert.match(src, /sp\.dir/, "page.tsx must read sp.dir");
});

test("spec 157 — page.tsx whitelists sort against displayColumns[].key", () => {
  const code = stripComments(read(PAGE_PATH));
  // Look for the Set<string> built from displayColumns. The shape we expect
  // is `new Set(entity.displayColumns.map((c) => c.key))` or a `sortableKeys`
  // identifier referencing displayColumns.
  assert.match(
    code,
    /new\s+Set\(\s*entity\.displayColumns\.map\(/,
    "page.tsx must whitelist sort via a Set built from entity.displayColumns",
  );
  assert.match(
    code,
    /sortableKeys/,
    "page.tsx must bind a `sortableKeys` set for the whitelist check",
  );
});

test("spec 157 — page.tsx falls back to createdAt + desc as the default sort", () => {
  const code = stripComments(read(PAGE_PATH));
  assert.match(
    code,
    /["']createdAt["']/,
    "page.tsx must reference 'createdAt' as the default sort column",
  );
  assert.match(
    code,
    /["']desc["']/,
    "page.tsx must reference 'desc' as a default sort direction",
  );
});

test("spec 157 — page.tsx adds .orderBy(...) to the SELECT chain dispatching on sortDir", () => {
  const code = stripComments(read(PAGE_PATH));
  assert.match(
    code,
    /\.orderBy\(/,
    "page.tsx must call .orderBy(...) on the SELECT chain",
  );
  // The dispatch should reference both desc and asc as helper functions.
  // The ternary form `(sortDir === "desc" ? desc : asc)(sortCol)` keeps
  // both identifiers in scope without an explicit `desc(...)` / `asc(...)`
  // call, so we match either form: an explicit call OR the ternary.
  assert.match(
    code,
    /(desc\s*\(|desc\s*:|desc\s+\?|:\s*desc\b)/,
    "page.tsx must reference desc as the descending sort helper",
  );
  assert.match(
    code,
    /(asc\s*\(|asc\s*:|asc\s+\?|:\s*asc\b)/,
    "page.tsx must reference asc as the ascending sort helper",
  );
  // The dispatch should be gated on the sortDir variable.
  assert.match(
    code,
    /sortDir\s*===\s*"desc"/,
    "page.tsx must dispatch on `sortDir === 'desc'` for the asc/desc helper choice",
  );
});

test("spec 157 — page.tsx defines buildSortHref(colKey)", () => {
  const code = stripComments(read(PAGE_PATH));
  assert.match(
    code,
    /buildSortHref\s*=\s*\(/,
    "page.tsx must define a buildSortHref helper",
  );
});

test("spec 157 — column headers are sort links with data-sort-header and aria-sort", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /data-sort-header=/,
    "each header link must carry a data-sort-header attribute for selector targeting",
  );
  assert.match(
    src,
    /aria-sort=/,
    "the active sort header must carry aria-sort for screen-reader announcement",
  );
  // The arrow indicators distinguish ascending vs descending visually.
  assert.match(
    src,
    /↑|↓/,
    "the active sort header must render an arrow indicator (↑ or ↓)",
  );
});

test("spec 157 — empty-state colSpan is bumped to displayColumns.length + 2", () => {
  const code = stripComments(read(PAGE_PATH));
  assert.match(
    code,
    /colSpan=\{entity\.displayColumns\.length\s*\+\s*2\}/,
    "the empty-state <td> must carry colSpan={displayColumns.length + 2} (was +1 — bulk-select column adds one)",
  );
});

test("spec 157 — page.tsx wraps the table region in <BulkSelectionProvider> and mounts <BulkDeleteToolbar entitySlug={slug}>", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /<BulkSelectionProvider\s+allRowIds=/,
    "page.tsx must wrap the table region in <BulkSelectionProvider allRowIds={...}>",
  );
  assert.match(
    src,
    /<BulkDeleteToolbar\s+entitySlug=\{slug\}/,
    "page.tsx must mount <BulkDeleteToolbar entitySlug={slug} /> inside the provider",
  );
});

test("spec 157 — actions.ts imports inArray and recordAudit", () => {
  const src = read(ACTIONS_PATH);
  assert.match(
    src,
    /import\s*\{[^}]*\binArray\b[^}]*\}\s*from\s*"drizzle-orm"/,
    "actions.ts must import inArray from drizzle-orm",
  );
  assert.match(
    src,
    /import\s*\{[^}]*\brecordAudit\b[^}]*\}\s*from\s*"@\/lib\/audit"/,
    "actions.ts must import recordAudit from @/lib/audit",
  );
});

test("spec 157 — actions.ts exports bulkDeleteAction and gates with requireRole(mutateRolesFor(entity))", () => {
  const src = read(ACTIONS_PATH);
  assert.match(
    src,
    /export\s+async\s+function\s+bulkDeleteAction\s*\(/,
    "actions.ts must export `bulkDeleteAction(formData)` as an async server action",
  );
  // bulkDeleteAction must role-gate via the shared helper.
  // Count requireRole(mutateRolesFor(entity)) calls — we now expect ≥4
  // (create + update + delete + bulkDelete).
  const calls = src.match(/await\s+requireRole\(\s*mutateRolesFor\(entity\)\s*\)/g) ?? [];
  assert.ok(
    calls.length >= 4,
    `expected ≥4 requireRole(mutateRolesFor(entity)) calls (create + update + delete + bulkDelete); found ${calls.length}`,
  );
});

test("spec 157 — bulkDeleteAction wraps the DELETE in db.transaction and uses inArray", () => {
  const code = stripComments(read(ACTIONS_PATH));
  assert.match(
    code,
    /db\.transaction\(\s*async\s*\(\s*tx\s*\)\s*=>/,
    "bulkDeleteAction must wrap the DELETE in db.transaction(async (tx) => { ... })",
  );
  assert.match(
    code,
    /tx\s*\.\s*delete\(/,
    "the DELETE inside the tx must run on tx (not db) so it shares the commit",
  );
  assert.match(
    code,
    /inArray\(/,
    "bulkDeleteAction must call inArray(...) so the DELETE targets all selected ids",
  );
});

test("spec 157 — recordAudit('admin.row.bulk_delete') fires AFTER the transaction commits", () => {
  const src = read(ACTIONS_PATH);
  // Find the bulkDeleteAction function body so we don't confuse the
  // transaction position in other actions for this one.
  const fnIdx = src.indexOf("bulkDeleteAction");
  assert.ok(fnIdx >= 0, "bulkDeleteAction must be defined");
  const tail = src.slice(fnIdx);
  const txStart = tail.search(/db\.transaction\(\s*async\s*\(\s*tx\s*\)\s*=>/);
  assert.ok(txStart >= 0, "db.transaction call must be present in bulkDeleteAction");
  const auditIdx = tail.search(/recordAudit\(\s*\{[\s\S]*?action:\s*"admin\.row\.bulk_delete"/);
  assert.ok(auditIdx >= 0, "recordAudit('admin.row.bulk_delete') must be present");
  assert.ok(
    auditIdx > txStart,
    "recordAudit must appear AFTER the db.transaction call (commit-then-audit)",
  );
});

test("spec 157 — audit metadata carries count and ids[0..5]", () => {
  const src = read(ACTIONS_PATH);
  // Audit metadata block of admin.row.bulk_delete must reference both count
  // and ids — we constrain that block to the slice-of-5 form so a future
  // contributor cannot inadvertently log the full id list.
  assert.match(
    src,
    /count:/,
    "audit metadata must include a count key",
  );
  assert.match(
    src,
    /ids:\s*rowIds\.slice\(\s*0\s*,\s*5\s*\)/,
    "audit metadata must cap ids at the first 5 (rowIds.slice(0, 5)) so the JSONB doesn't bloat",
  );
});

test("spec 157 — bulk-toolbar.tsx is a 'use client' component", () => {
  const src = read(TOOLBAR_PATH);
  assert.match(
    src,
    /^"use client"/m,
    "bulk-toolbar.tsx must start with 'use client'",
  );
});

test("spec 157 — bulk-toolbar.tsx exports the four named functions", () => {
  const src = read(TOOLBAR_PATH);
  for (const name of [
    "BulkSelectionProvider",
    "BulkRowCheckbox",
    "BulkSelectAllCheckbox",
    "BulkDeleteToolbar",
  ]) {
    assert.match(
      src,
      new RegExp(`export\\s+function\\s+${name}\\b`),
      `bulk-toolbar.tsx must export function ${name}`,
    );
  }
});

test("spec 157 — BulkDeleteToolbar gates submit with window.confirm and posts bulkDeleteAction", () => {
  const src = read(TOOLBAR_PATH);
  assert.match(
    src,
    /window\.confirm/,
    "BulkDeleteToolbar must gate submit with window.confirm (matches DeleteRowButton from spec 114)",
  );
  assert.match(
    src,
    /bulkDeleteAction/,
    "BulkDeleteToolbar must call bulkDeleteAction",
  );
  assert.match(
    src,
    /import[\s\S]*?bulkDeleteAction[\s\S]*?from\s+"\.\/actions"/,
    "bulk-toolbar.tsx must import bulkDeleteAction from ./actions",
  );
});

test("spec 157 — BulkSelectAllCheckbox sets indeterminate state via a ref", () => {
  const code = stripComments(read(TOOLBAR_PATH));
  // The indeterminate property on a DOM checkbox is set via a ref callback —
  // React 19's DOM types don't expose it as a prop. This pins the shape so
  // a future contributor doesn't accidentally lose the half-checked state.
  assert.match(
    code,
    /indeterminate/,
    "BulkSelectAllCheckbox must set the .indeterminate property via a ref",
  );
});

test("spec 157 — page.tsx comment block references spec 157 so the rationale is discoverable from source", () => {
  const src = read(PAGE_PATH);
  assert.match(
    src,
    /spec 157|Spec 157|157/,
    "page.tsx must reference spec 157 in a comment so a future reader can trace the rationale",
  );
});

test("spec 157 — actions.ts comment block references spec 157", () => {
  const src = read(ACTIONS_PATH);
  assert.match(
    src,
    /spec 157|Spec 157|157/,
    "actions.ts must reference spec 157 in a comment so a future reader can trace the rationale",
  );
});

test("spec 157 — all five spec-kit files exist under specs/157-admin-grid-sort-and-bulk-delete/", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 157 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED/, "plan.md must declare CREATED");
  assert.match(src, /EDITED/, "plan.md must declare EDITED");
  assert.match(src, /MIGRATED/, "plan.md must declare MIGRATED");
});
