# Quickstart — Spec 157 (admin grid sort + bulk delete)

Manual smoke test after deploy. Should take a programme_admin under 3
minutes.

## Prereqs

- Logged in as a programme_admin or super_admin.
- At least one admin entity (e.g. `schools`) has ≥3 rows in the
  database. Seeded data from spec 086 satisfies this.

## 1. Column sort cycle

1. Open `/admin/data/schools` in the browser.
2. Observe the URL has no `sort=` / `dir=` params yet — the default
   sort is `createdAt DESC` (newest school first).
3. Click the **Name** column header.
4. Verify the URL is now `?sort=name&dir=asc` and the table is
   alphabetically A → Z. A small `↑` arrow appears next to "Name".
5. Click **Name** again.
6. Verify the URL is now `?sort=name&dir=desc` and rows are Z → A. The
   arrow is now `↓`.
7. Click the **Phone** column header.
8. Verify the URL is now `?sort=contactPhone&dir=asc` (the
   `displayColumns` `key` is `contactPhone`, not `phone`) and the
   "Name" arrow is gone — the active sort moved to the Phone column.

## 2. URL whitelist

1. Manually navigate to
   `/admin/data/schools?sort=DROP_TABLE&dir=asc`.
2. Verify the page renders normally (no SQL error, no 500). The
   unknown `sort` value silently falls back to the default
   `createdAt DESC`. Confirm the URL shown in the address bar is
   unchanged — Next.js doesn't rewrite it — but the table is sorted
   by `createdAt DESC`.

## 3. Bulk select

1. Back at `/admin/data/schools` (no params).
2. Click the leftmost checkbox in any row — that row's checkbox
   becomes checked.
3. Observe a red sticky toolbar appears above the table: **"1 row
   selected"** with a red **"Delete 1 selected"** button.
4. Click the same row's checkbox again — the checkbox un-checks and
   the toolbar disappears.

## 4. Select all

1. Click the leftmost checkbox in the table **header**.
2. Verify every visible row's checkbox is now checked. The toolbar
   shows **"50 rows selected"** (if your page has 50 rows) or
   the actual count.
3. Click the header checkbox again — every row un-checks and the
   toolbar disappears.

## 5. Indeterminate state

1. Click the header checkbox (selects all).
2. Click any one row checkbox to un-check it.
3. Verify the header checkbox is now **indeterminate** (rendered as a
   horizontal dash by Chrome / Firefox).

## 6. Bulk delete

1. Click the header checkbox to select all rows on the current page.
2. Click **"Delete N selected"** in the red toolbar.
3. A `window.confirm()` dialog appears: **"Delete N selected rows?
   This cannot be undone."**
4. Click **OK**.
5. The grid refreshes and all selected rows are gone.
6. Open `/admin/audit-log` (or query `audit_log` directly).
7. Verify a single audit row with `action = "admin.row.bulk_delete"`,
   `entityType = "schools"`, and metadata `{ "op": "bulk_delete",
   "count": <N>, "ids": [...first 5 ids...] }`.

## 7. Confirm dialog cancel

1. Repeat steps 6.1–6.3.
2. Click **Cancel** on the `window.confirm()` dialog.
3. No rows are deleted. No audit row is written. The selection
   remains intact (the toolbar still shows "N rows selected").

## 8. Role gate

1. Log out, log back in as a `mentor` (or any role NOT in
   `mutateRoles` for `schools`).
2. Open `/admin/data/schools` — should 403 at the page level (read
   role gate from spec 012).
3. If a future admin grid surface has asymmetric read vs mutate
   roles, the toolbar still renders for the read-allowed role. Click
   "Delete N selected" — the server action returns a 403 from
   `requireRole(mutateRolesFor(entity))` and the rows survive.

## 9. Sort + filter + bulk-delete interaction

1. Apply a column filter (e.g. set the "Name" filter to "Government").
2. Click **Apply filters**.
3. Click the **Name** column header — sort is applied on top of the
   filter. URL should be
   `?filter[name]=Government&sort=name&dir=asc`.
4. Click the header checkbox — only the filtered+sorted rows are
   selected.
5. Click **Delete N selected** and confirm.
6. Verify only the filtered rows were deleted; rows outside the
   filter set are untouched.
