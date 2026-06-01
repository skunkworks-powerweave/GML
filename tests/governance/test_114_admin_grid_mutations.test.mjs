import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const ACTIONS = "apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts";
const ROW_FORM = "apps/web/src/app/(authenticated)/admin/data/[entity]/row-form.tsx";
const PAGE = "apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx";
const DELETE_BUTTON = "apps/web/src/app/(authenticated)/admin/data/[entity]/delete-button.tsx";
const CSV = "apps/web/src/app/(authenticated)/admin/data/[entity]/csv.ts";
const SPEC_DIR = "specs/114-admin-grid-mutations";

test("spec 114: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("spec 114: updateRowAction is exported from actions.ts and uses db.update + eq + zod", () => {
  const src = read(ACTIONS);
  assert.match(src, /export async function updateRowAction/, "updateRowAction must be exported");
  assert.match(src, /db\s*\n?\s*\.update\(/, "updateRowAction must call db.update(...)");
  assert.match(src, /\.where\(eq\(/, "updateRowAction must use eq(...) to scope the update by id");
  assert.match(src, /entity\.formSchema\.safeParse/, "updateRowAction must validate via the entity's Zod formSchema");
});

test("spec 114: all three mutations use dotted-notation audit actions", () => {
  const src = read(ACTIONS);
  assert.match(src, /action:\s*"admin\.row\.create"/, "create must audit 'admin.row.create'");
  assert.match(src, /action:\s*"admin\.row\.update"/, "update must audit 'admin.row.update'");
  assert.match(src, /action:\s*"admin\.row\.delete"/, "delete must audit 'admin.row.delete'");
});

test("spec 114: actions.ts gates every mutation with requireRole(mutateRolesFor(entity))", () => {
  const src = read(ACTIONS);
  // Three mutations, each must call requireRole(mutateRolesFor(entity)).
  const calls = src.match(/await\s+requireRole\(\s*mutateRolesFor\(entity\)\s*\)/g) ?? [];
  assert.ok(
    calls.length >= 3,
    `expected at least 3 requireRole(mutateRolesFor(entity)) calls (create + update + delete); found ${calls.length}`,
  );
});

test("spec 114: actions.ts wraps all three mutations in withAudit() — SM-1 enforcement", () => {
  const src = read(ACTIONS);
  // Each mutation must wrap its db op in withAudit().
  const wraps = src.match(/withAudit\(/g) ?? [];
  assert.ok(
    wraps.length >= 3,
    `expected at least 3 withAudit() wrappers (create + update + delete); found ${wraps.length}`,
  );
});

test("spec 114: updateRowAction surfaces field-level zod errors", () => {
  const src = read(ACTIONS);
  assert.match(src, /fieldErrors/, "AdminActionState must include fieldErrors for inline per-field display");
});

test("spec 114: RowForm supports mode='edit' with rowId + initialValues and dispatches updateRowAction", () => {
  const src = read(ROW_FORM);
  assert.match(src, /mode\??:\s*"create"\s*\|\s*"edit"/, "RowForm props must allow mode='edit'");
  assert.match(src, /rowId\??:\s*string/, "RowForm props must accept rowId");
  assert.match(src, /initialValues\??:/, "RowForm props must accept initialValues");
  assert.match(src, /updateRowAction/, "RowForm must import and use updateRowAction");
  assert.match(src, /isEdit\s*\?\s*updateRowAction\s*:\s*createRowAction/, "RowForm must switch actions by mode");
});

test("spec 114: DeleteRowButton client wrapper exists and gates submit with window.confirm", () => {
  assert.ok(existsSync(resolve(root, DELETE_BUTTON)), "delete-button.tsx must exist");
  const src = read(DELETE_BUTTON);
  assert.match(src, /^"use client"/m, "DeleteRowButton must be a client component");
  assert.match(src, /window\.confirm/, "DeleteRowButton must gate submit with window.confirm");
  assert.match(src, /deleteRowAction/, "DeleteRowButton must call deleteRowAction");
});

test("spec 114: page.tsx wires per-row Edit link and DeleteRowButton", () => {
  const src = read(PAGE);
  assert.match(src, /DeleteRowButton/, "page must render DeleteRowButton");
  assert.match(src, /\?edit=\$\{encodeURIComponent\(rowId\)\}/, "page must build the ?edit=<id> link for the Edit affordance");
  assert.match(src, /mode="edit"/, "page must render RowForm with mode='edit' when ?edit=<id> is present");
  assert.match(src, /initialValues=\{editRow\}/, "page must pass the fetched row as initialValues");
});

test("spec 114: page.tsx renders the column-filter toolbar and applies filters via ilike", () => {
  const src = read(PAGE);
  assert.match(src, /data-filter-form="true"/, "filter form must be marked with data-filter-form");
  assert.match(src, /filter\[\$\{c\.key\}\]/, "filter inputs must use ?filter[<col>]=<value> name attribute");
  assert.match(src, /ilike\(/, "page must use ilike() to narrow the SELECT");
  assert.match(src, /extractFilters/, "page must parse filter[<col>] params via extractFilters()");
});

test("spec 114: pagination links preserve filter querystring (buildPageHref)", () => {
  const src = read(PAGE);
  assert.match(src, /buildPageHref/, "page must define buildPageHref to preserve filters across pagination");
  assert.match(src, /params\.set\(\s*`filter\[\$\{k\}\]`/, "buildPageHref must serialise active filters into the next-page URL");
});

test("spec 114: CSV import/export helpers remain untouched (still exported)", () => {
  const src = read(CSV);
  assert.match(src, /export async function exportCsv/, "exportCsv must still exist (must not be broken by spec 114)");
  assert.match(src, /export async function importCsv/, "importCsv must still exist (must not be broken by spec 114)");
});

test("spec 114: plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare CREATED:");
  assert.match(src, /EDITED:/, "plan.md must declare EDITED:");
  assert.match(src, /MIGRATED:/, "plan.md must declare MIGRATED:");
});
