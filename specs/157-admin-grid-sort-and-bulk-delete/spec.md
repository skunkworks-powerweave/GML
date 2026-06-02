# Spec 157 — Admin grid sort + bulk delete (Workflow Run 15 MISS closure)

## Why

The 7-agent code audit at the close of Workflow Run 14 ran a final MISS-tier
sweep across the no-code admin substrate. Two MISSES surfaced inside the
generic admin grid (`/admin/data/[entity]`):

1. **No sortable columns.** The JSX prototype (`admin.jsx::AdminTable`,
   lines 138-142) carries clickable `<th>` headers that toggle
   ascending/descending sort on any displayed column. The v1 grid (spec
   012) shipped without that affordance — a programme_admin staring at
   100 rows of attendance has no way to find the oldest row, the most
   recent row, or sort by status / grade / phase. The page already
   pages 50-at-a-time and filters by column; sort is the third leg of
   the standard admin-grid stool.

2. **No bulk-row select + delete.** The JSX prototype also carries a
   leftmost checkbox column plus a "Delete N selected" sticky action
   bar that appears when ≥1 row is checked (`admin.jsx::AdminTable`,
   lines 124-136). The v1 grid only carries the per-row Delete button
   (spec 114 — `DeleteRowButton`). A programme_admin clearing 30 stale
   sessions has to click Delete + confirm 30 times. Bulk delete is a
   single round-trip and a single audit row.

Both gaps are pure feature MISSES — the prototype shipped them, the v1
implementation did not. Workflow Run 15 closes them.

## What we ship

### `apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx` (EDITED)

- Imports `asc, desc` from `drizzle-orm` alongside the existing `and,
  eq, ilike` (so the SELECT chain can dispatch by direction).
- Imports `BulkDeleteToolbar`, `BulkRowCheckbox`, `BulkSelectAllCheckbox`,
  `BulkSelectionProvider` from the new `./bulk-toolbar` client island.
- Parses `?sort=<column>&dir=<asc|desc>` search params. The `sort` value
  is whitelisted against `entity.displayColumns[].key` so a malicious
  user cannot inject SQL via the search param. Default sort is
  `createdAt DESC` when the table carries that column (every v2 table
  does), falling back to `id ASC`.
- The SELECT chain now ends in `.orderBy((sortDir === "desc" ? desc :
  asc)(sortCol))` before `.limit(...).offset(...)`.
- Each table `<th>` header is now a `<Link role="button">` that
  navigates to the same page with `?sort=<col>&dir=<next>` flipped. The
  active sort column carries an arrow indicator (`↑` for asc, `↓` for
  desc) AND an `aria-sort="ascending|descending"` attribute so screen
  readers announce it.
- A new `buildSortHref(colKey)` helper computes the next-state URL: if
  the column is already the active sort, flip the direction; otherwise
  set it as the new sort with a sensible default direction (`createdAt`
  → desc, everything else → asc).
- `buildPageHref` is extended to preserve `sort` + `dir` on pagination
  links (alongside the existing `filter[<col>]` preservation).
- A leftmost `<th>`/`<td>` column is added for the bulk-select
  checkbox. The thead carries `<BulkSelectAllCheckbox />`, every body
  row carries `<BulkRowCheckbox rowId={...} />`. The `colSpan` on the
  empty-state cell is bumped from `displayColumns.length + 1` to
  `displayColumns.length + 2` to cover the new column.
- The desktop table region is wrapped in `<BulkSelectionProvider
  allRowIds={allRowIds}>`. `allRowIds` is computed server-side from
  `rows.map(r => String(r.id))` so the "select all" checkbox knows
  which ids to flip.
- `<BulkDeleteToolbar entitySlug={slug} />` is mounted just above the
  table inside the provider. It auto-hides when `selected.size === 0`.

### `apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts` (EDITED)

- Imports `inArray` from `drizzle-orm` and `recordAudit` from
  `@/lib/audit` (alongside the existing `withAudit`).
- New `bulkDeleteAction(formData)` server action:
  - Reads `entitySlug` and `rowIds[]` (repeated key) off the FormData.
  - Role-gates via the same `mutateRolesFor(entity)` helper the
    single-row delete uses.
  - Runs `tx.delete(entity.table).where(inArray(idCol, rowIds))` inside
    `db.transaction(async (tx) => { ... })` so the delete is atomic.
  - Audits `admin.row.bulk_delete` AFTER the transaction commits (same
    commit-then-audit shape as spec 148 / spec 152). Metadata carries
    `{ op: "bulk_delete", count, ids: ids.slice(0, 5) }` — the first 5
    ids are enough for audit-log traceability without bloating the JSONB.
  - `revalidatePath(/admin/data/${slug})` so the grid re-fetches.

### `apps/web/src/app/(authenticated)/admin/data/[entity]/bulk-toolbar.tsx` (CREATED)

A client component (`"use client"`) that owns the bulk-select state and the
sticky toolbar UI. Exports:

- **`BulkSelectionProvider`** — wraps the table region. Holds a
  `useState<Set<string>>` of selected row ids and exposes `toggle`,
  `setMany`, `clear` via React Context.
- **`BulkRowCheckbox`** — rendered in each `<td>` leftmost cell. Reads
  `selected.has(rowId)` and calls `toggle(rowId)` on change.
- **`BulkSelectAllCheckbox`** — rendered in the thead leftmost `<th>`.
  Reads how many of `allRowIds` are currently in `selected`, sets the
  checkbox's `checked` and `indeterminate` properties, and on change
  calls `setMany(allRowIds, !allOn)`.
- **`BulkDeleteToolbar`** — sticky bar that renders only when
  `selected.size > 0`. The "Delete N selected" button gates submit with
  `window.confirm()` (mirrors `DeleteRowButton` from spec 114) and posts
  `bulkDeleteAction(formData)` via a `useTransition()` so the grid stays
  responsive. Carries `data-bulk-toolbar="true"` and
  `data-bulk-delete-button="true"` for governance test selectors.

Native `window.confirm()` is deliberate for v1: zero new components,
zero new CSS, keyboard + screen-reader accessible by default, identical
UX on mobile. A future spec can upgrade to a styled modal without
touching the action.

## Acceptance criteria

- `page.tsx` imports `asc, desc` from `drizzle-orm`.
- `page.tsx` imports `BulkDeleteToolbar`, `BulkRowCheckbox`,
  `BulkSelectAllCheckbox`, `BulkSelectionProvider` from
  `./bulk-toolbar`.
- `page.tsx` reads `sp.sort` and `sp.dir` and whitelists `sort`
  against `entity.displayColumns[].key`.
- The SELECT chain calls `.orderBy(...)` with `desc(sortCol)` or
  `asc(sortCol)` based on `sortDir`.
- Default sort falls back to `createdAt` (desc) when the table has it,
  otherwise `id` (asc).
- Each `<th>` header is a sort link (`<Link>` with `role="button"`
  and `data-sort-header`).
- The active sort `<th>` carries `aria-sort="ascending"` or
  `aria-sort="descending"`.
- `buildSortHref(colKey)` exists and toggles direction when the column
  is already active.
- `buildPageHref` preserves `sort` + `dir` alongside filters.
- The table renders a leftmost checkbox column with
  `BulkSelectAllCheckbox` in the thead and `BulkRowCheckbox` per body
  row.
- `BulkSelectionProvider` wraps the desktop table region.
- `BulkDeleteToolbar entitySlug={slug}` is mounted inside the provider.
- The empty-state `<td>` carries `colSpan={displayColumns.length + 2}`
  (was `+ 1`) to cover the new checkbox column.
- `actions.ts` exports `bulkDeleteAction(formData)`.
- `bulkDeleteAction` calls `requireRole(mutateRolesFor(entity))`.
- `bulkDeleteAction` wraps the DELETE in `db.transaction(...)` with
  `inArray(idCol, rowIds)`.
- `bulkDeleteAction` calls `recordAudit({ action:
  "admin.row.bulk_delete", ... })` AFTER the transaction commits.
- The audit metadata includes `count` and `ids` keys.
- `bulk-toolbar.tsx` exists, starts with `"use client"`, and exports
  the four named functions above.
- `BulkDeleteToolbar` gates submit with `window.confirm` (same shape as
  `DeleteRowButton`).
- All five spec-kit files exist under
  `specs/157-admin-grid-sort-and-bulk-delete/`.
- `tests/governance/test_157_admin_grid_sort_and_bulk_delete.test.mjs`
  passes with at least 10 assertions covering the above.

## Non-goals

- **No new dependencies.** Pure dispatch + transaction wrap + React
  Context. Same `drizzle-orm` + React 19 that already ship.
- **No schema change.** Bulk delete uses the existing `id` PK on every
  admin-editable table.
- **No multi-column sort.** Only one column at a time. A future spec
  can layer secondary sort but that's a UX change, not a feature gap.
- **No "select across pages" affordance.** The select-all checkbox only
  flips the current page slice. A future spec can add an "all 1247
  matching rows" link, but that opens a different UX question (the
  audit blast radius of a single click) and is out of scope.
- **No styled confirm modal.** `window.confirm()` is keyboard +
  screen-reader accessible and matches the existing `DeleteRowButton`
  UX. A future spec can upgrade UI without touching the server action.
- **No CSV-export of selection.** The existing Export-CSV link exports
  the full page slice; a future spec can add `?ids=<comma-list>` if
  field reports want it.
