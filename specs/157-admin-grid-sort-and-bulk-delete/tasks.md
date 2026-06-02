# Tasks — Spec 157 (admin-grid-sort-and-bulk-delete)

## T1 — Create the bulk-toolbar client island [x]

- [x] New file `apps/web/src/app/(authenticated)/admin/data/[entity]/bulk-toolbar.tsx`.
- [x] `"use client"` directive at top.
- [x] Export `BulkSelectionProvider` taking `allRowIds: readonly string[]`
      and `children: ReactNode`. Holds a `useState<Set<string>>` of
      selected ids. Exposes `toggle`, `setMany`, `clear` via React
      Context.
- [x] Export `BulkRowCheckbox` (consumes context, takes `rowId: string`).
- [x] Export `BulkSelectAllCheckbox` (consumes context, sets
      `el.indeterminate` via ref).
- [x] Export `BulkDeleteToolbar` (consumes context, takes
      `entitySlug: string`). Hides when `selected.size === 0`. Uses
      `useTransition()` for the action call. Gates submit with
      `window.confirm()`.

## T2 — Extend actions.ts with bulkDeleteAction [x]

- [x] Add `inArray` to the drizzle-orm import.
- [x] Add `recordAudit` to the audit-lib import.
- [x] Export `async function bulkDeleteAction(formData: FormData):
      Promise<void>`.
- [x] Read `entitySlug` and `rowIds[]` (FormData.getAll) off the
      payload. Bail if either is empty.
- [x] Role-gate via `requireRole(mutateRolesFor(entity))`.
- [x] Wrap the DELETE in `db.transaction(async (tx) => { … })`.
- [x] Inside the tx: `tx.delete(entity.table).where(inArray(idCol,
      rowIds))`.
- [x] After commit: `void recordAudit({ action:
      "admin.row.bulk_delete", entityType: entity.slug, metadata: {
      op: "bulk_delete", count, ids: ids.slice(0, 5) }})`.
- [x] Call `revalidatePath("/admin/data/${slug}")`.

## T3 — Extend page.tsx with sort + bulk-select wiring [x]

- [x] Add `asc, desc` to the drizzle-orm import.
- [x] Add the four `BulkXxx` imports from `./bulk-toolbar`.
- [x] Parse `sp.sort` and `sp.dir`. Whitelist sort against
      `entity.displayColumns[].key`.
- [x] Default sort `createdAt DESC` when the table has it; fall back
      to `id ASC`.
- [x] Add `.orderBy((sortDir === "desc" ? desc : asc)(sortCol))` to
      the SELECT chain.
- [x] Replace plain `<th>{c.label}</th>` with a `<Link role="button">`
      using `buildSortHref(c.key)`. Add `aria-sort` attribute on the
      active column. Add `↑` / `↓` arrow indicator.
- [x] Add `buildSortHref(colKey)` helper.
- [x] Extend `buildPageHref(page)` to preserve `sort` + `dir`.
- [x] Add a leftmost `<th>` with `<BulkSelectAllCheckbox />`.
- [x] Add a leftmost `<td>` with `<BulkRowCheckbox rowId={...} />`
      per body row.
- [x] Bump the empty-state `<td>` `colSpan` from
      `displayColumns.length + 1` to `displayColumns.length + 2`.
- [x] Wrap the desktop table region (the `<section>` plus its
      contents) in `<BulkSelectionProvider allRowIds={allRowIds}>`.
- [x] Mount `<BulkDeleteToolbar entitySlug={slug} />` inside the
      provider, above the `<table>`.

## T4 — Write spec-kit files [x]

- [x] `specs/157-admin-grid-sort-and-bulk-delete/spec.md` (the why /
      what / acceptance).
- [x] `specs/157-admin-grid-sort-and-bulk-delete/plan.md` (CREATED /
      EDITED / MIGRATED + risk register).
- [x] `specs/157-admin-grid-sort-and-bulk-delete/research.md`
      (alternatives considered, why we picked what we picked).
- [x] `specs/157-admin-grid-sort-and-bulk-delete/quickstart.md`
      (manual smoke test).
- [x] `specs/157-admin-grid-sort-and-bulk-delete/tasks.md` (this
      file).

## T5 — Write the governance test [x]

- [x] `tests/governance/test_157_admin_grid_sort_and_bulk_delete.test.mjs`
      with at least 10 assertions covering:
      - page.tsx imports `asc, desc`.
      - page.tsx imports `BulkSelectionProvider` etc. from
        `./bulk-toolbar`.
      - page.tsx parses `sp.sort` / `sp.dir`.
      - page.tsx calls `.orderBy(` on the SELECT chain.
      - page.tsx renders `aria-sort` on the active header.
      - page.tsx whitelists sort against `displayColumns`.
      - page.tsx contains `buildSortHref(`.
      - page.tsx wraps the table region in `<BulkSelectionProvider`.
      - page.tsx mounts `<BulkDeleteToolbar entitySlug={slug}`.
      - actions.ts exports `bulkDeleteAction`.
      - actions.ts uses `inArray` + `db.transaction`.
      - actions.ts audits `admin.row.bulk_delete` after commit.
      - bulk-toolbar.tsx is `"use client"`.
      - bulk-toolbar.tsx exports all four named functions.
      - All five spec-kit files exist.
