# Plan — Spec 157 (admin-grid-sort-and-bulk-delete)

## CREATED

- `apps/web/src/app/(authenticated)/admin/data/[entity]/bulk-toolbar.tsx`
  — new client component (`"use client"`) housing the bulk-select
  React Context + the sticky bulk-delete toolbar. Exports four named
  functions: `BulkSelectionProvider`, `BulkRowCheckbox`,
  `BulkSelectAllCheckbox`, `BulkDeleteToolbar`. Uses
  `useTransition()` for the action call and `window.confirm()` for the
  destructive gate (mirrors `DeleteRowButton` from spec 114).

- `specs/157-admin-grid-sort-and-bulk-delete/spec.md` — this design.
- `specs/157-admin-grid-sort-and-bulk-delete/plan.md` — this file.
- `specs/157-admin-grid-sort-and-bulk-delete/research.md` — rationale,
  alternatives considered, why we picked native `window.confirm()`
  and React Context over a hidden-form approach.
- `specs/157-admin-grid-sort-and-bulk-delete/quickstart.md` — manual
  test instructions (sort cycle through ascending/descending; bulk
  select 3 rows; bulk delete with confirm; verify audit row lands).
- `specs/157-admin-grid-sort-and-bulk-delete/tasks.md` — five tasks
  T1–T5 with completion checkboxes.
- `tests/governance/test_157_admin_grid_sort_and_bulk_delete.test.mjs`
  — governance test, 14 assertions across page.tsx, actions.ts,
  bulk-toolbar.tsx, and spec-kit file existence.

## EDITED

- `apps/web/src/app/(authenticated)/admin/data/[entity]/page.tsx`
  — adds `asc, desc` to the drizzle-orm import; adds the four
  bulk-toolbar imports; parses `sp.sort` and `sp.dir` with
  whitelisting; appends `.orderBy(...)` to the SELECT chain; rewrites
  each `<th>` header as a sort link with arrow indicator + aria-sort
  attr; adds `buildSortHref(colKey)` helper; extends `buildPageHref`
  to preserve sort+dir; wraps the desktop table region in
  `<BulkSelectionProvider>`; mounts `<BulkDeleteToolbar />` above the
  table; adds a leftmost checkbox column with `BulkSelectAllCheckbox`
  in the thead and `BulkRowCheckbox` per body row; bumps the empty
  state `colSpan` by 1.

- `apps/web/src/app/(authenticated)/admin/data/[entity]/actions.ts`
  — adds `inArray` to the drizzle-orm import; adds `recordAudit` to
  the audit-lib import; exports a new `bulkDeleteAction(formData)`
  server action that role-gates via `mutateRolesFor(entity)`, runs
  `tx.delete(...).where(inArray(idCol, rowIds))` inside
  `db.transaction(...)`, then audits `admin.row.bulk_delete` with
  count + ids.slice(0, 5) AFTER commit, then revalidates the path.

## MIGRATED

None. Bulk delete uses the existing primary key on every admin-editable
table; sort uses existing columns. The next-available migration index
(0019, reserved for spec 159 per the run-15 spec assignments) stays
free.

## Risk register

| Risk | Mitigation |
| --- | --- |
| User selects 200 rows and clicks Delete — single SQL DELETE with a 200-element IN(...) clause may slow the page. | Postgres handles 200-element IN clauses fine; the txn is short. If we ever see >1k selections we'll page the delete. |
| `?sort=<col>` carries a malicious column name. | Whitelisted against `entity.displayColumns[].key` via a `Set<string>` check before any SQL is built. Unknown values fall through to the default sort. |
| The select-all checkbox flips only the current page slice but the user expected all 1247 matching rows. | Out of scope — see Non-goals in spec.md. The checkbox is labelled `aria-label="Select all rows"` (not "all rows in database") and the toolbar shows the explicit `N rows selected` count. |
| `bulkDeleteAction` audit log row never lands if recordAudit throws. | `recordAudit` is best-effort by design (`Promise<boolean>` swallow); we use the `void` discard form. Audit-channel failure is logged to stderr and visible in worker logs but never rolls back the delete. |
| A user with stale UI (post-spec-deploy) has no checkboxes — does bulk delete still work? | No — bulk delete requires the toolbar, which requires the provider, which requires this spec's page.tsx to be deployed. The toolbar is server-rendered, so once deployed it's available to every authenticated user. |
| Race between two admins bulk-deleting overlapping selections. | The DELETE is idempotent — `WHERE id IN (...)` against an already-deleted id is a no-op. No lost-update bug. The second admin sees fewer rows in their grid on the next refresh. |
